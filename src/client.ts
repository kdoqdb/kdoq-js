import { Connection, type TransportFactory } from "./internal/connection.js";
import { encodeDocumentInput, encodeStatement, isFilter } from "./internal/mutations.js";
import { ErrorCode, KdoqBulkError, KdoqConfigError, KdoqConnectionError, KdoqError, KdoqTimeoutError } from "./errors.js";
import type { OperationStream, OpSpec } from "./internal/operation.js";
import { parseDsn, type ParsedDsn } from "./dsn.js";
import type {
  Backoff,
  BulkItem,
  BulkResult,
  Client,
  ClientState,
  Collection,
  CollectionInfo,
  CountOptions,
  Database,
  DatabaseInfo,
  Databases,
  Key,
  MutationOptions,
  MutationResult,
  PipelineStage,
  Query,
  ResourceState,
  ServerCapabilities,
  SessionInfo,
  Sessions,
  WriteOptions,
  FindOptions,
  OpOptions,
  BulkStatement,
  Stage,
  Target,
} from "./types.js";
import { Cursor, createSpec, QueryImpl, parseStatistics, type PaginateMode } from "./query.js";
import { RUNNER, type Runner, type Unary } from "./internal/runner.js";
import { KeyBytes, NameDictionary, type Doc } from "./internal/codec.js";
import { concat, enc, type Fields, utf8 } from "./internal/wire.js";

export interface ConnectOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  /** SHA-256 of the DER leaf certificate of a self-signed development server: bytes or hex. */
  certificateHash?: Uint8Array | string;
  signal?: AbortSignal;
  capabilities?: { required?: number; optional?: number };
  connectTimeout?: number;
  /** Default time limit of an operation in milliseconds (30000 when omitted); each operation can override it. */
  timeout?: number;
  retry?: false | { attempts?: number; backoff?: Backoff };
  reconnect?: boolean;
  /** Replaces the WebTransport constructor; for tests and embedding. */
  transport?: TransportFactory;
  maxFrameSize?: number;
}

const STATES: Record<number, ResourceState> = { 1: "loaded", 2: "unavailable", 3: "unloaded", 4: "loading", 5: "unloading" };

/** The port a kdoq server listens on unless configured otherwise. */
export const DEFAULT_PORT = 27505;

const DEFAULT_BACKOFF = { initial: 100, max: 5000, factor: 2, jitter: true };

interface Config {
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  certificateHash?: Uint8Array;
}

const hex = (s: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(s)) throw new KdoqConfigError("certificateHash must be bytes or a hex string");
  return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
};

function resolveConfig(dsn: string | null, o: ConnectOptions): Config {
  const p: Partial<ParsedDsn> = dsn === null ? {} : parseDsn(dsn);
  const host = o.host ?? p.host;
  if (!host) throw new KdoqConfigError("no host: pass a DSN or options.host");
  const username = o.username ?? p.username;
  const password = o.password ?? p.password;
  if (password !== undefined && username === undefined) throw new KdoqConfigError("a password needs a username");
  const certificateHash = typeof o.certificateHash === "string" ? hex(o.certificateHash) : o.certificateHash;
  return { host, port: o.port ?? p.port ?? DEFAULT_PORT, username, password, database: o.database ?? p.database, certificateHash };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const retryable = (e: unknown) => e instanceof KdoqError && (e.code === ErrorCode.Overloaded || e.code === ErrorCode.AdmissionTimeout);

const isFatal = (e: unknown) => e instanceof KdoqError && (e.code === ErrorCode.Authentication || e.code === ErrorCode.Revoked);

/** An AbortController that also follows `signal` and aborts after `ms`. */
function deadline(signal: AbortSignal | undefined, ms: number, write: boolean) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new KdoqTimeoutError(`the operation timed out after ${ms} ms`, { outcome: write ? "Unknown" : "NotApplied" })),
    ms,
  );
  const follow = () => controller.abort(signal!.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener("abort", follow, { once: true });
  return {
    signal: controller.signal,
    stop: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", follow);
    },
  };
}

class ClientImpl implements Client, Runner {
  state: ClientState = "disconnected";
  readonly closed: Promise<void>;
  private conn?: Connection;
  private connecting?: Promise<Connection>;
  private everConnected = false;
  private fatal?: KdoqError;
  private listeners = new Set<(state: ClientState, reason?: Error) => void>();
  private resolveClosed!: () => void;
  private rejectClosed!: (e: unknown) => void;

  constructor(
    private readonly cfg: Config,
    private readonly o: ConnectOptions,
  ) {
    this.closed = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.closed.catch(() => {});
  }

  get session() {
    return this.conn?.alive ? this.conn.session : null;
  }
  get capabilities() {
    return this.conn?.capabilities ?? 0;
  }
  get [RUNNER](): Runner {
    return this;
  }

  on(_event: "state", listener: (state: ClientState, reason?: Error) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: ClientState, reason?: Error) {
    if (this.state === state) return;
    this.state = state;
    for (const l of this.listeners) l(state, reason);
  }

  // ---- connection management -------------------------------------------------

  async ensure(): Promise<Connection> {
    if (this.state === "closed") throw this.fatal ?? new KdoqConnectionError("the client is closed");
    if (this.conn?.alive) return this.conn;
    if (this.everConnected && this.o.reconnect === false)
      throw new KdoqConnectionError("the connection was lost and reconnect is disabled");
    return (this.connecting ??= this.openConnection().finally(() => {
      this.connecting = undefined;
    }));
  }

  private async openConnection(): Promise<Connection> {
    const c = this.cfg;
    const host = c.host.includes(":") && !c.host.startsWith("[") ? `[${c.host}]` : c.host;
    try {
      const conn = await Connection.open({
        url: `https://${host}:${c.port}/native`,
        username: c.username,
        password: c.password,
        certificateHash: c.certificateHash,
        requiredCapabilities: this.o.capabilities?.required ?? 4 | 8,
        optionalCapabilities: this.o.capabilities?.optional ?? 1 | 16,
        frameCeiling: this.o.maxFrameSize ?? 64 * 1024 * 1024,
        connectTimeout: this.o.connectTimeout ?? 10000,
        transport: this.o.transport,
      });
      this.conn = conn;
      this.everConnected = true;
      this.setState("connected");
      void conn.closed.then((info) => {
        if (this.conn !== conn) return;
        this.conn = undefined;
        if (this.state === "closed") return;
        if (info.closeCode === 8 || conn.failure?.code === ErrorCode.Revoked)
          this.fail(new KdoqError("the session was revoked", { code: ErrorCode.Revoked }));
        else this.setState("disconnected", conn.failure ?? new KdoqConnectionError("the connection was lost"));
      });
      return conn;
    } catch (e) {
      if (isFatal(e)) this.fail(e as KdoqError);
      throw e;
    }
  }

  /** A failure that makes further connection attempts pointless (shared server cooldown, revocation). */
  private fail(error: KdoqError) {
    if (this.state === "closed") return;
    this.fatal = error;
    this.setState("closed", error);
    this.conn?.close();
    this.conn = undefined;
    this.rejectClosed(error);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.setState("closed");
    const conn = this.conn;
    this.conn = undefined;
    await this.connecting?.then(
      (c) => c.close(),
      () => {},
    );
    if (conn?.alive) await conn.logout();
    this.resolveClosed();
  }

  // ---- Runner ------------------------------------------------------------------

  async open(spec: OpSpec, options: OpOptions = {}): Promise<OperationStream> {
    const limit = deadline(options.signal, options.timeout ?? this.o.timeout ?? 30000, spec.write ?? false);
    try {
      return await this.openWithin(spec, limit.signal, limit.stop);
    } finally {
      limit.dispose();
    }
  }

  private async openWithin(spec: OpSpec, signal: AbortSignal, established: () => void): Promise<OperationStream> {
    const retry =
      this.o.retry === false
        ? { attempts: 0, backoff: DEFAULT_BACKOFF }
        : { attempts: this.o.retry?.attempts ?? 3, backoff: { ...DEFAULT_BACKOFF, ...this.o.retry?.backoff } };
    for (let attempt = 0; ; attempt++) {
      const abort = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      try {
        const conn = await Promise.race([this.ensure(), abort]);
        const stream = await conn.start(spec, signal);
        const first = await Promise.race([stream.next(), abort]);
        if (first?.kind !== "begin") {
          await stream.cancel();
          throw new KdoqError("the server did not start the response with BEGIN", { code: ErrorCode.Malformed });
        }
        established();
        return stream;
      } catch (e) {
        if (isFatal(e)) this.fail(e as KdoqError);
        if (!retryable(e) || attempt >= retry.attempts) throw e;
        const b = retry.backoff;
        const delay = Math.min(b.max, b.initial * b.factor ** attempt) * (b.jitter ? 0.5 + Math.random() / 2 : 1);
        await sleep(delay, signal);
      }
    }
  }

  async unary(spec: OpSpec, options: OpOptions = {}): Promise<Unary> {
    const limit = deadline(options.signal, options.timeout ?? this.o.timeout ?? 30000, spec.write ?? false);
    try {
      const stream = await this.openWithin(spec, limit.signal, () => {});
      const items: Fields[] = [];
      for (;;) {
        const e = await stream.next();
        if (!e) throw new KdoqError("the response ended without END", { code: ErrorCode.Malformed });
        if (e.kind === "item") items.push(e.fields);
        else if (e.kind === "end") return { stream, begin: stream.begin!, items, end: e.fields };
      }
    } catch (e) {
      if (isFatal(e)) this.fail(e as KdoqError);
      throw e;
    } finally {
      limit.dispose();
    }
  }

  // ---- Client API -------------------------------------------------------------

  db(name?: string): Database {
    const n = name ?? this.cfg.database;
    if (!n) throw new KdoqConfigError("no database name: pass one or set a default in the DSN or options");
    return new DatabaseImpl(this, n);
  }

  attachCursor(id: number | bigint): Cursor {
    return Cursor.attach(this, id);
  }

  readonly databases: Databases = {
    list: async () => (await this.unary({ operation: 0x0201 })).items.map(databaseInfo),
    get: async (name) => databaseInfo((await this.unary({ operation: 0x0202, payload: enc.str(1, name) })).items[0]),
    create: async (name) => void (await this.unary({ operation: 0x0203, payload: enc.str(1, name), write: true })),
    load: async (name) => void (await this.unary({ operation: 0x0204, payload: enc.str(1, name), write: true })),
    unload: async (name) => void (await this.unary({ operation: 0x0205, payload: enc.str(1, name), write: true })),
  };

  readonly server = {
    health: async () => (await this.unary({ operation: 0x0001 })).items[0].u8(1) === 1,
    capabilities: async (): Promise<ServerCapabilities> => {
      const f = (await this.unary({ operation: 0x0002 })).items[0];
      return { operations: f.u16list(1), encoding: f.need(f.u16(2), 2), capabilities: Number(f.need(f.u64(3), 3)) };
    },
  };

  readonly sessions: Sessions = {
    list: async () => (await this.unary({ operation: 0x0101 })).items.map(sessionInfo),
    get: async (id) => sessionInfo((await this.unary({ operation: 0x0102, payload: enc.u64(1, id) })).items[0]),
    revoke: async (id) => void (await this.unary({ operation: 0x0103, payload: enc.u64(1, id), write: true })),
  };
}

function databaseInfo(f: Fields): DatabaseInfo {
  return { name: f.need(f.str(1), 1), state: STATES[f.need(f.u16(2), 2)] ?? "unavailable", ...(f.has(3) ? { diagnostic: f.str(3) } : {}) };
}
function collectionInfo(f: Fields): CollectionInfo {
  return { ...databaseInfo(f), lockReleased: f.u8(4) === 1, excluded: f.u8(5) === 1 };
}
function sessionInfo(f: Fields): SessionInfo {
  return {
    id: f.need(f.u64(1), 1),
    username: f.need(f.str(2), 2),
    peer: f.need(f.str(3), 3),
    createdAt: new Date(Number(f.need(f.u64(4), 4))),
  };
}

class DatabaseImpl implements Database {
  constructor(
    private readonly runner: Runner,
    readonly name: string,
  ) {}

  readonly collections = {
    list: async () => (await this.runner.unary({ operation: 0x0301, payload: enc.str(1, this.name) })).items.map(collectionInfo),
    get: (name: string) => this.collection(name).info,
    create: (name: string) => this.collection(name).create(),
    load: (name: string) => this.collection(name).load(),
    unload: (name: string) => this.collection(name).unload(),
  };

  collection<T extends Doc = Doc>(name: string): Collection<T> {
    return new CollectionImpl(this.runner, this.name, name) as unknown as Collection<T>;
  }
  get() {
    return this.runner.unary({ operation: 0x0202, payload: enc.str(1, this.name) }).then((r) => databaseInfo(r.items[0]));
  }
  create() {
    return this.runner.unary({ operation: 0x0203, payload: enc.str(1, this.name), write: true }).then(() => {});
  }
  load() {
    return this.runner.unary({ operation: 0x0204, payload: enc.str(1, this.name), write: true }).then(() => {});
  }
  unload() {
    return this.runner.unary({ operation: 0x0205, payload: enc.str(1, this.name), write: true }).then(() => {});
  }
}

const keyBytes = (k: Key): Uint8Array => (typeof k === "string" ? utf8(k) : k);
const durability = (o?: WriteOptions) => (o?.durability === undefined ? undefined : enc.u16(1, o.durability === "relaxed" ? 1 : 0));

class CollectionImpl implements Collection {
  constructor(
    private readonly runner: Runner,
    readonly database: string,
    readonly name: string,
  ) {}

  private get ns(): Uint8Array {
    return concat(enc.str(1, this.database), enc.str(2, this.name));
  }
  private options(id: number, extra: Array<Uint8Array | undefined>): Uint8Array {
    const fields = extra.filter((f): f is Uint8Array => f !== undefined);
    return fields.length ? enc.group(id, ...fields) : new Uint8Array(0);
  }

  async get(key: Key, op?: OpOptions): Promise<Doc> {
    const r = await this.runner.unary({ operation: 0x0401, payload: concat(this.ns, enc.bin(3, keyBytes(key))) }, op);
    const item = r.items[0];
    return r.stream.decode(item.need(item.u64(2), 2), item.need(item.bin(3), 3)) as Doc;
  }

  private async writeDocument(operation: number, payload: Uint8Array, doc: Doc | undefined, op?: WriteOptions): Promise<KeyBytes> {
    const r = await this.runner.unary({ operation, payload, inputs: doc ? encodeDocumentInput(doc) : [], write: true }, op);
    return KeyBytes.copyOf(r.items[0].need(r.items[0].bin(1), 1));
  }

  put(key: Key, doc: Doc, op?: WriteOptions) {
    return this.writeDocument(0x0402, concat(this.ns, enc.bin(3, keyBytes(key)), this.options(4, [durability(op)])), doc, op);
  }
  insert(doc: Doc, op?: WriteOptions & { key?: Key }) {
    return this.writeDocument(
      0x0403,
      concat(this.ns, ...(op?.key === undefined ? [] : [enc.bin(3, keyBytes(op.key))]), this.options(4, [durability(op)])),
      doc,
      op,
    );
  }
  delete(key: Key, op?: WriteOptions) {
    return this.writeDocument(0x0404, concat(this.ns, enc.bin(3, keyBytes(key)), this.options(4, [durability(op)])), undefined, op);
  }

  private mutation(f: Fields): MutationResult {
    const flags = f.need(f.u8(2), 2);
    return {
      ...(f.has(1) ? { key: KeyBytes.copyOf(f.bin(1)!) } : {}),
      ...(f.has(3) ? { matched: f.u64(3) } : {}),
      ...(f.has(4) ? { modified: f.u64(4) } : {}),
      inserted: (flags & 4) !== 0,
    };
  }

  private async single(operation: number, target: Target, stages: Stage[], op?: MutationOptions): Promise<MutationResult> {
    const dict = new NameDictionary();
    const key = isFilter(target) ? undefined : keyBytes(target);
    const inputs = encodeStatement(dict, stages, target);
    const payload = concat(this.ns, ...(key ? [enc.bin(3, key)] : []), this.options(4, [durability(op)]));
    const r = await this.runner.unary({ operation, payload, inputs, write: true }, op);
    return this.mutation(r.items[0]);
  }

  update(target: Target, stages: Stage[], op?: MutationOptions) {
    return this.single(0x0405, target, stages, op);
  }
  upsert(target: Target, stages: Stage[], op?: MutationOptions) {
    return this.single(0x0406, target, stages, op);
  }

  async bulk(statements: BulkStatement[], op?: MutationOptions & { ordered?: boolean }): Promise<BulkResult> {
    const dict = new NameDictionary();
    const inputs = statements.flatMap((s) =>
      encodeStatement(dict, s.stages, s.target, {
        key: isFilter(s.target) ? undefined : keyBytes(s.target),
        mode: s.mode === "upsert" ? 1 : 0,
      }),
    );
    const payload = concat(this.ns, this.options(3, [durability(op), op?.ordered === undefined ? undefined : enc.bool(2, op.ordered)]));
    const stream = await this.runner.open({ operation: 0x0407, payload, inputs, write: true }, op);
    const items: BulkItem[] = [];
    try {
      for (;;) {
        const e = await stream.next();
        if (!e) throw new KdoqError("the response ended without END", { code: ErrorCode.Malformed });
        if (e.kind === "end") return { executed: e.fields.need(e.fields.u32(1), 1), items };
        if (e.kind !== "item") continue;
        const f = e.fields;
        const status = f.need(f.u16(2), 2);
        items.push({
          index: f.need(f.u32(1), 1),
          status: status === 0 ? null : status,
          ...(f.has(4) ? { key: KeyBytes.copyOf(f.bin(4)!) } : {}),
          ...(f.has(5) ? { matched: f.u64(5) } : {}),
          ...(f.has(6) ? { modified: f.u64(6) } : {}),
          inserted: (f.need(f.u8(3), 3) & 4) !== 0,
        });
      }
    } catch (e) {
      if (items.length && e instanceof KdoqError) {
        const wrapped = new KdoqBulkError(e.message, { code: e.code, outcome: "Unknown", requestId: e.requestId, cause: e });
        wrapped.items = items;
        throw wrapped;
      }
      throw e;
    }
  }

  find(filter?: string, pipeline?: PipelineStage[], options: FindOptions & { paginate?: PaginateMode } = {}): Query & Promise<Cursor> {
    const { paginate = true, ...rest } = options;
    if (paginate === "manual") {
      return this.manualCursor(filter, pipeline, rest) as unknown as Query & Promise<Cursor>;
    }
    return new QueryImpl(this.runner, this.database, this.name, filter, pipeline, rest, paginate) as unknown as Query & Promise<Cursor>;
  }

  private async manualCursor(filter: string | undefined, pipeline: PipelineStage[] | undefined, o: FindOptions): Promise<Cursor> {
    const stream = await this.runner.open(createSpec(this.database, this.name, filter, pipeline, o, 0), o);
    const id = stream.begin?.u64(1);
    for (;;) {
      if (!(await stream.next())) break;
    }
    if (!id) throw new KdoqError("the server returned no cursor", { code: ErrorCode.Malformed });
    return new Cursor(this.runner, id, o.pageSize);
  }

  async count(filter?: string, options: CountOptions = {}): Promise<number | bigint> {
    const o = options;
    const observe = enc.group(
      3,
      enc.bool(1, o.observe?.progress ?? !!o.onProgress),
      enc.bool(2, o.observe?.diagnostics ?? !!o.onDiagnostic),
      enc.bool(3, o.observe?.statistics ?? false),
    );
    const payload = concat(
      this.ns,
      ...(filter === undefined ? [] : [enc.str(3, filter)]),
      enc.group(4, observe, ...(o.pruning === undefined ? [] : [enc.bool(5, o.pruning)])),
    );
    const r = await this.runner.unary({ operation: 0x0502, payload }, o);
    return r.items[0].need(r.items[0].u64(1), 1);
  }

  get info(): Promise<CollectionInfo> {
    return this.runner.unary({ operation: 0x0302, payload: this.ns }).then((r) => collectionInfo(r.items[0]));
  }
  create() {
    return this.runner.unary({ operation: 0x0303, payload: this.ns, write: true }).then(() => {});
  }
  load() {
    return this.runner.unary({ operation: 0x0304, payload: this.ns, write: true }).then(() => {});
  }
  unload() {
    return this.runner.unary({ operation: 0x0305, payload: this.ns, write: true }).then(() => {});
  }
  walSync() {
    return this.runner.unary({ operation: 0x0601, payload: this.ns, write: true }).then(() => {});
  }
  checkpoint() {
    return this.runner.unary({ operation: 0x0602, payload: this.ns, write: true }).then(() => {});
  }
}

// ---- entry point ------------------------------------------------------------------

export async function connect(dsn: string | null, options: ConnectOptions = {}): Promise<Client> {
  const client = new ClientImpl(resolveConfig(dsn, options), options);
  if (options.signal?.aborted) throw options.signal.reason;
  options.signal?.addEventListener("abort", () => void client.close(), { once: true });
  await client.ensure();
  return client;
}

export type {
  Backoff,
  BulkItem,
  BulkResult,
  Client,
  ClientState,
  Collection,
  CollectionInfo,
  Database,
  DatabaseInfo,
  Databases,
  Key,
  MutationOptions,
  MutationResult,
  ResourceState,
  ServerCapabilities,
  SessionInfo,
  Sessions,
  WriteOptions,
} from "./types.js";
export { Cursor, parseStatistics };
