import type { AccessLevel } from "./errors.js";
import type { Operand } from "./expr.js";
import type { Doc, GroupKey, KeyBytes, Value } from "./value/values.js";

/** A document key: a string (stored as UTF-8) or raw bytes. */
export type Key = string | Uint8Array;

/** Delays between retries, in milliseconds. */
export interface Backoff {
  initial?: number;
  max?: number;
  factor?: number;
  jitter?: boolean;
}

/** Options every operation accepts. */
export interface OpOptions {
  /** Aborts the operation; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Milliseconds; overrides the client's `timeout`. */
  timeout?: number;
}

export interface WriteOptions extends OpOptions {
  /** Durability of this write; the server default applies when omitted. */
  durability?: "durable" | "relaxed";
}
export type MutationOptions = WriteOptions;

export type ClientState = "connected" | "disconnected" | "closed";
export type ResourceState = "loaded" | "unavailable" | "unloaded" | "loading" | "unloading";
export interface DatabaseInfo {
  name: string;
  state: ResourceState;
  diagnostic?: string;
}
export interface CollectionInfo extends DatabaseInfo {
  lockReleased: boolean;
  excluded: boolean;
}
export interface SessionInfo {
  id: number | bigint;
  username: string;
  peer: string;
  createdAt: Date;
}
export interface ServerCapabilities {
  operations: number[];
  encoding: number;
  capabilities: number;
}

export interface MutationResult {
  key?: KeyBytes;
  matched?: number | bigint;
  modified?: number | bigint;
  inserted: boolean;
}
export interface BulkItem extends MutationResult {
  index: number;
  status: number | null;
}
export interface BulkResult {
  executed: number;
  items: BulkItem[];
}

export type PipelineStage =
  | { project: string }
  | { match: string }
  | { reduce: { key: string; initial: string; accumulate: string } }
  | { count: true };

export interface Budget {
  memoryBytes?: number;
  admissionWaitMs?: number;
  memoryWaitMs?: number;
  steps?: number;
  expressionBytes?: number;
  activeMs?: number;
}
export interface Diagnostic {
  expression: string;
  stage?: number | bigint;
  span: { start: number | bigint; end: number | bigint };
  reason: string;
}
export interface Progress {
  processed: number | bigint;
  total: number | bigint;
}

export interface QueryOptions {
  /** Bloom necessary-condition pruning; omitted means enabled. Fixed for the execution. */
  pruning?: boolean;
  signal?: AbortSignal;
  timeout?: number;
  budget?: Budget;
  observe?: { progress?: boolean; diagnostics?: boolean; statistics?: boolean };
  onProgress?(p: Progress): void;
  onDiagnostic?(d: Diagnostic): void;
}

export interface FindOptions extends QueryOptions {
  pageSize?: number;
  idleTtl?: number;
  window?: { skip?: number; limit?: number };
}
export type CountOptions = QueryOptions;

export interface Item<V = Value> {
  key?: KeyBytes | GroupKey;
  value: V;
}

export type N = number | bigint;
export interface Statistics {
  source: { total: N; processed: N; bloomCandidates: N };
  documents: { processed: N; selected: N; rejected: N; filterErrors: N };
  budgetUsed: { steps: N; valueBytes: N; activeNs: N };
  /** Not reported over REST. */
  memory?: { currentBytes: N; peakBytes: N };
  /** Server handling time of the last page, in microseconds; reported over REST only. */
  durationUs?: N;
  reduction?: { accumulatedDocuments: N; groupsCreated: N };
}

/** A lazy query: it runs on the first iteration and can be iterated once. Leaving the loop closes the server cursor. */
export interface Query<V = Value> extends AsyncIterable<Item<V>> {
  values(): AsyncIterable<V>;
  toArray(): Promise<Item<V>[]>;
  /** The first item, or `undefined` for an empty result; the rest of the query is cancelled. */
  first(): Promise<Item<V> | undefined>;
  readonly cursorId: number | bigint | null;
  readonly statistics: Promise<Statistics | undefined>;
  cancel(): Promise<void>;
}

/** A key (single) or a filter (optionally every match). */
export type Target = string | Uint8Array | { filter: string; multi?: boolean };

export type Stage =
  | { set: Record<string, Operand | Value> | Array<[string[] | string, Operand | Value]> }
  | { unset: Array<string | string[]> }
  | { replace: Doc | Operand };

export interface BulkStatement {
  mode: "update" | "upsert";
  target: Target;
  stages: Stage[];
}

export interface Databases {
  list(): Promise<DatabaseInfo[]>;
  get(name: string): Promise<DatabaseInfo>;
  create(name: string): Promise<void>;
  load(name: string): Promise<void>;
  unload(name: string): Promise<void>;
}

export interface Sessions {
  list(): Promise<SessionInfo[]>;
  get(id: number | bigint): Promise<SessionInfo>;
  revoke(id: number | bigint): Promise<void>;
}

/** One authenticated session with a kdoq server. Connecting is lazy after a lost connection (see `reconnect`). */
export interface Client {
  readonly state: ClientState;
  /** The current session, or `null` while disconnected. */
  readonly session: { id: number | bigint; accessLevel: AccessLevel } | null;
  readonly capabilities: number;
  /** Settles when the client is closed: resolves after `close()`, rejects with the error that ended it. */
  readonly closed: Promise<void>;
  /** Subscribes to state changes; returns the function that unsubscribes. */
  on(event: "state", listener: (state: ClientState, reason?: Error) => void): () => void;
  /** A database handle; without a name, the one from the DSN or options. Nothing is sent to the server. */
  db(name?: string): Database;
  /** Continues a cursor created earlier, for example on another connection. */
  attachCursor(id: number | bigint): Cursor;
  [Symbol.asyncDispose](): Promise<void>;
  readonly databases: Databases;
  readonly server: { health(): Promise<boolean>; capabilities(): Promise<ServerCapabilities> };
  readonly sessions: Sessions;
  /** Ends the session (LOGOUT) and closes the connection. Calling it again is a no-op. */
  close(): Promise<void>;
}

/** A cursor read page by page. */
export interface Cursor {
  readonly id: number | bigint;
  next(
    options?: { size?: number; signal?: AbortSignal } & Pick<QueryOptions, "onProgress" | "onDiagnostic">,
  ): Promise<{ items: Item[]; done: boolean; statistics?: Statistics }>;
  close(): Promise<void>;
}

export interface Database {
  readonly name: string;
  readonly collections: {
    list(): Promise<CollectionInfo[]>;
    get(name: string): Promise<CollectionInfo>;
    create(name: string): Promise<void>;
    load(name: string): Promise<void>;
    unload(name: string): Promise<void>;
  };
  /** `T` is a type hint only: documents are not checked against it at run time. */
  collection<T extends Doc = Doc>(name: string): Collection<T>;
  get(): Promise<DatabaseInfo>;
  create(): Promise<void>;
  load(): Promise<void>;
  unload(): Promise<void>;
}

/** A collection of documents. `T` is a type hint; documents are not validated against it. */
export interface Collection<T extends Doc = Doc> {
  readonly database: string;
  readonly name: string;
  /** Reads one document; rejects with `ErrorCode.NotFound` when there is none. */
  get(key: Key, op?: OpOptions): Promise<T>;
  /** Stores a document under a key. */
  put(key: Key, doc: T, op?: WriteOptions): Promise<KeyBytes>;
  /** Stores a new document under a generated key, or under `op.key`; rejects with `ErrorCode.AlreadyExists` for a live key. */
  insert(doc: T, op?: WriteOptions & { key?: Key }): Promise<KeyBytes>;
  /** Deletes the document under a key. */
  delete(key: Key, op?: WriteOptions): Promise<KeyBytes>;
  /** Changes documents on the server with ordered stages instead of reading and writing back. */
  update(target: Target, stages: Stage[], op?: MutationOptions): Promise<MutationResult>;
  /** Like `update`, but when nothing matches it inserts the result of applying the stages to an empty document. */
  upsert(target: Target, stages: Stage[], op?: MutationOptions): Promise<MutationResult>;
  /**
   * Runs several update or upsert statements in one operation. With `ordered`, it stops at the first rejected
   * statement; with `ordered: false` it continues with the independent ones.
   */
  bulk(statements: BulkStatement[], op?: MutationOptions & { ordered?: boolean }): Promise<BulkResult>;
  /**
   * Starts a query: a lazy async iterable of `{ key, value }`. Pages are read as you iterate, and leaving the loop
   * closes the server cursor. A `pipeline` can change the shape of the results, which `R` then names.
   * With `paginate: "manual"` it resolves to a `Cursor` you read page by page.
   */
  find<R = T>(filter?: string, pipeline?: PipelineStage[], options?: FindOptions & { paginate?: true | false }): Query<R>;
  find(filter: string | undefined, pipeline: PipelineStage[] | undefined, options: FindOptions & { paginate: "manual" }): Promise<Cursor>;
  /** Counts the documents matching a filter (all of them without one). */
  count(filter?: string, options?: CountOptions): Promise<number | bigint>;
  readonly info: Promise<CollectionInfo>;
  create(): Promise<void>;
  load(): Promise<void>;
  unload(): Promise<void>;
  /** Synchronizes the write-ahead log appends that relaxed writes accumulated. Needs the Admin access level. */
  walSync(): Promise<void>;
  /** Publishes the checkpoint of the collection. Needs the Admin access level. */
  checkpoint(): Promise<void>;
}
