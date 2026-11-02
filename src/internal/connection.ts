import { type AccessLevel, ErrorCode, KdoqConnectionError, KdoqError, malformed } from "../errors.js";
import { errorFromFrame, OperationStream, type BiStream, type OpSpec } from "./operation.js";
import { ScramClient } from "./scram.js";
import { enc, Fields, frame, FrameReader, Kind } from "./wire.js";

export interface CloseInfo {
  closeCode?: number;
  reason?: string;
}

export interface TransportLike {
  readonly ready: Promise<unknown>;
  readonly closed: Promise<unknown>;
  createBidirectionalStream(): Promise<BiStream>;
  close(info?: CloseInfo): void;
}

export interface TransportInit {
  serverCertificateHashes?: Array<{ algorithm: string; value: Uint8Array }>;
}

export type TransportFactory = (url: string, init: TransportInit) => TransportLike;

export const defaultTransport: TransportFactory = (url, init) => {
  const WT = (globalThis as { WebTransport?: new (url: string, init?: TransportInit) => TransportLike }).WebTransport;
  if (!WT) throw new KdoqConnectionError("WebTransport is not available in this environment");
  return new WT(url, init);
};

export interface ConnectionSettings {
  url: string;
  username?: string;
  password?: string;
  certificateHash?: Uint8Array;
  requiredCapabilities: number;
  optionalCapabilities: number;
  frameCeiling: number;
  connectTimeout: number;
  transport?: TransportFactory;
  nonce?: string;
}

const NONE = 0,
  SCRAM_SHA_256 = 1;

/** One established native session: transport, control stream and operation streams. */
export class Connection {
  alive = true;
  session!: { id: number | bigint; accessLevel: AccessLevel };
  capabilities = 0;
  /** Resolves once the connection ends, whatever the cause. */
  readonly closed: Promise<CloseInfo>;

  private frameCeiling = 0;
  private nextRequest = 1;
  private nextControl = 1;
  private control!: { reader: FrameReader; writer: WritableStreamDefaultWriter<Uint8Array> };
  private writeChain: Promise<void> = Promise.resolve();
  private readonly acks = new Map<number, (found: boolean | null) => void>();
  private resolveClosed!: (info: CloseInfo) => void;
  private fatal?: KdoqError;

  private constructor(private readonly transport: TransportLike) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    transport.closed.then(
      (info) => this.end((info as CloseInfo) ?? {}),
      (e) => this.end({ closeCode: (e as { closeCode?: number })?.closeCode, reason: String((e as Error)?.message ?? e) }),
    );
  }

  static async open(s: ConnectionSettings): Promise<Connection> {
    const factory = s.transport ?? defaultTransport;
    const transport = factory(
      s.url,
      s.certificateHash ? { serverCertificateHashes: [{ algorithm: "sha-256", value: s.certificateHash }] } : {},
    );
    const conn = new Connection(transport);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new KdoqConnectionError(`connecting timed out after ${s.connectTimeout} ms`)), s.connectTimeout);
    });
    try {
      await Promise.race([conn.setup(s), timeout]);
      return conn;
    } catch (e) {
      conn.close();
      if (e instanceof KdoqError) throw e;
      throw new KdoqConnectionError(`cannot connect to ${s.url}: ${(e as Error)?.message ?? e}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  private async setup(s: ConnectionSettings): Promise<void> {
    await this.transport.ready;
    const stream = await this.transport.createBidirectionalStream();
    this.control = { reader: new FrameReader(stream.readable, 8192 + 8), writer: stream.writable.getWriter() };

    const scram = s.username === undefined ? undefined : new ScramClient(s.username, s.password ?? "", s.nonce);
    await this.send(
      frame(
        Kind.HELLO,
        enc.u32(1, 1),
        enc.u32(2, 1),
        enc.u16list(3, [4]),
        enc.u64(4, s.requiredCapabilities),
        enc.u64(5, s.optionalCapabilities),
        enc.u16list(6, [scram ? SCRAM_SHA_256 : NONE]),
        enc.u64(7, s.frameCeiling),
      ),
    );

    const hello = await this.expect(Kind.HELLO);
    if (hello.need(hello.u32(1), 1) !== 1 || hello.need(hello.u16(2), 2) !== 4)
      throw new KdoqError("the server selected an unsupported protocol version or encoding", { code: ErrorCode.Incompatible });
    this.capabilities = Number(hello.need(hello.u64(3), 3));
    if (hello.need(hello.u16(4), 4) !== (scram ? SCRAM_SHA_256 : NONE))
      throw new KdoqError("the server selected an authentication method that was not offered", { code: ErrorCode.Incompatible });
    this.frameCeiling = Math.min(s.frameCeiling, Number(hello.need(hello.u64(5), 5)));

    if (scram) {
      await this.send(frame(Kind.AUTH, enc.str(1, scram.first())));
      const serverFirst = await this.expect(Kind.AUTH);
      await this.send(frame(Kind.AUTH, enc.str(1, await scram.final(serverFirst.need(serverFirst.str(1), 1)))));
      const serverFinal = await this.expect(Kind.AUTH);
      scram.verify(serverFinal.need(serverFinal.str(1), 1));
    }
    const ready = await this.expect(Kind.READY);
    this.session = { id: ready.need(ready.u64(1), 1), accessLevel: ready.need(ready.u8(2), 2) as AccessLevel };
    void this.controlLoop();
  }

  private async expect(kind: number): Promise<Fields> {
    const f = await this.control.reader.read();
    if (!f) throw new KdoqConnectionError("the connection closed during setup");
    if (f.kind === Kind.ERROR) throw errorFromFrame(f.payload);
    if (f.kind !== kind) throw malformed(`unexpected frame kind 0x${f.kind.toString(16)} during setup`);
    return new Fields(f.payload);
  }

  private send(bytes: Uint8Array): Promise<void> {
    const next = this.writeChain.then(() => this.control.writer.write(bytes));
    this.writeChain = next.catch(() => {});
    return next;
  }

  private async controlLoop(): Promise<void> {
    try {
      for (;;) {
        const f = await this.control.reader.read();
        if (!f) break;
        if (f.kind === Kind.CONTROL_ACK) {
          const a = new Fields(f.payload);
          const found = a.u8(3);
          this.acks.get(Number(a.need(a.u64(1), 1)))?.(found === undefined ? null : found === 1);
        } else if (f.kind === Kind.ERROR) {
          this.fatal = errorFromFrame(f.payload);
          break;
        }
      }
    } catch {
      /* a transport failure also resolves `closed` */
    }
    this.end({});
  }

  private end(info: CloseInfo): void {
    if (!this.alive) return;
    this.alive = false;
    for (const ack of this.acks.values()) ack(null);
    this.acks.clear();
    this.resolveClosed(info);
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
  }

  /** The server error that ended the connection, if it sent one. */
  get failure(): KdoqError | undefined {
    return this.fatal;
  }

  async start(spec: OpSpec, signal?: AbortSignal): Promise<OperationStream> {
    if (!this.alive) throw new KdoqConnectionError("the connection is closed");
    const stream = await this.transport.createBidirectionalStream();
    return OperationStream.start(this, stream, this.frameCeiling, this.nextRequest++, spec, signal);
  }

  async cancel(requestId: number): Promise<void> {
    if (!this.alive) return;
    await this.send(frame(Kind.CANCEL, enc.u64(1, this.nextControl++), enc.u64(2, requestId)));
  }

  /** LOGOUT: access ends before the acknowledgment; then the transport closes. */
  async logout(timeout = 5000): Promise<void> {
    if (this.alive) {
      const id = this.nextControl++;
      const acked = new Promise<boolean | null>((resolve) => this.acks.set(id, resolve));
      try {
        await this.send(frame(Kind.LOGOUT, enc.u64(1, id)));
        await Promise.race([acked, new Promise((r) => setTimeout(r, timeout))]);
      } catch {
        /* closing anyway */
      }
    }
    this.close();
  }

  close(): void {
    this.end({ closeCode: 0 });
  }
}
