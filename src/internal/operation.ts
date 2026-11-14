import { KdoqConnectionError, KdoqError, KdoqIncompleteError, malformed, type Outcome } from "../errors.js";
import { decodeValue, type Value } from "./codec.js";
import { empty, enc, Fields, frame, FrameReader, encodeFrame, Kind, type Frame } from "./wire.js";
import { ms, opName, type Trace } from "./trace.js";
import type { OperationTiming } from "../types.js";

const KIND_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Kind).map(([name, code]) => [code, name]));

export interface BiStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/** What the client knew before the stream existed, and where finished timings go. */
export interface OperationObserver {
  trace?: Trace;
  onTiming?: (timing: OperationTiming) => void;
  requestedAt: number;
  connectionReadyAt: number;
  streamRequestedAt: number;
  streamOpenedAt: number;
}

/** One operation: a code, its payload fields and the complete input frames. */
export interface OpSpec {
  operation: number;
  /** Encoded payload fields; absent means no payload group. */
  payload?: Uint8Array;
  /** Complete DICTIONARY and INPUT_VALUE frames, sent between COMMAND and INPUT_END. */
  inputs?: Uint8Array[];
  /** A write that may have been accepted: a lost response has outcome Unknown. */
  write?: boolean;
}

export type OpEvent = { kind: "begin" | "item" | "end"; fields: Fields } | { kind: "progress" | "diagnostic"; fields: Fields };

export interface OperationHost {
  readonly alive: boolean;
  cancel(requestId: number): Promise<void>;
}

export function errorFromFrame(payload: Uint8Array): KdoqError {
  const f = new Fields(payload);
  const code = f.need(f.u16(2), 2);
  const outcome: Outcome = f.u16(3) === 1 ? "Unknown" : "NotApplied";
  const requestId = f.u64(1);
  return new KdoqError(f.str(4) ?? `server error ${code}`, { code, outcome, requestId: requestId ? requestId : undefined });
}

/** The response side of one operation stream. */
export class OperationStream {
  private readonly reader: FrameReader;
  private readonly contexts = new Map<number, Map<number, string>>();
  private finished = false;
  private abortListeners = new Map<AbortSignal, () => void>();
  private aborted: unknown;
  /** The BEGIN fields, once received. */
  begin?: Fields;
  private readonly started = performance.now();
  private items = 0;
  private itemBytes = 0;
  private responseBytes = 0;
  private sentAt?: number;
  private beginAt?: number;
  private firstItemAt?: number;
  private reported = false;

  private constructor(
    private readonly host: OperationHost,
    stream: BiStream,
    ceiling: number,
    readonly requestId: number,
    private readonly write: boolean,
    private readonly observer: OperationObserver | undefined,
    private readonly name: string,
    private readonly operation: number,
  ) {
    this.reader = new FrameReader(stream.readable, ceiling);
  }

  private get trace(): Trace | undefined {
    return this.observer?.trace;
  }

  /** Hands the finished timings to the observer, once. */
  private report(outcome: OperationTiming["outcome"], errorCode?: number): void {
    const o = this.observer;
    if (this.reported || !o?.onTiming) return;
    this.reported = true;
    o.onTiming({
      kind: "operation",
      requestId: this.requestId,
      operation: this.operation,
      name: this.name,
      requestedAt: o.requestedAt,
      connectionReadyAt: o.connectionReadyAt,
      streamRequestedAt: o.streamRequestedAt,
      streamOpenedAt: o.streamOpenedAt,
      ...(this.sentAt === undefined ? {} : { sentAt: this.sentAt }),
      ...(this.beginAt === undefined ? {} : { beginAt: this.beginAt }),
      ...(this.firstItemAt === undefined ? {} : { firstItemAt: this.firstItemAt }),
      endAt: performance.now(),
      items: this.items,
      responseBytes: this.responseBytes,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  private log(message: string): void {
    this.trace?.(`op#${this.requestId} ${this.name}`, `${message} (+${ms(this.started)})`);
  }

  static start(
    host: OperationHost,
    stream: BiStream,
    ceiling: number,
    requestId: number,
    spec: OpSpec,
    signal?: AbortSignal,
    observer?: OperationObserver,
  ): OperationStream {
    const op = new OperationStream(host, stream, ceiling, requestId, spec.write ?? false, observer, opName(spec.operation), spec.operation);
    const command = frame(
      Kind.COMMAND,
      enc.u16(1, spec.operation),
      enc.u64(2, requestId),
      ...(spec.payload ? [enc.group(3, spec.payload)] : []),
    );
    const writer = stream.writable.getWriter();
    void (async () => {
      try {
        await writer.write(command);
        for (const input of spec.inputs ?? []) await writer.write(input);
        await writer.write(encodeFrame(Kind.INPUT_END, empty));
        await writer.close();
        op.sentAt = performance.now();
        op.log(`request sent, ${command.length + (spec.inputs ?? []).reduce((n, i) => n + i.length, 0)} bytes of command and input`);
      } catch (e) {
        /* the response side reports the failure */
        op.log(`sending the request failed: ${(e as Error)?.message ?? e}`);
      } finally {
        writer.releaseLock?.();
      }
    })();
    if (signal) op.follow(signal);
    return op;
  }

  /** Keeps caller cancellation connected for the complete response lifetime. */
  follow(signal: AbortSignal): void {
    if (this.finished || this.abortListeners.has(signal)) return;
    const onAbort = () => {
      this.aborted = signal.reason ?? new DOMException("Aborted", "AbortError");
      void this.cancel();
    };
    if (signal.aborted) onAbort();
    else {
      this.abortListeners.set(signal, onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  private clearAbortListeners(): void {
    for (const [signal, listener] of this.abortListeners) signal.removeEventListener("abort", listener);
    this.abortListeners.clear();
  }

  get done(): boolean {
    return this.finished;
  }

  private lost(cause: unknown): KdoqError {
    const outcome: Outcome = this.write ? "Unknown" : "NotApplied";
    if (cause instanceof KdoqError) {
      if (cause instanceof KdoqIncompleteError) cause.outcome = outcome;
      return cause;
    }
    const resetCode = (cause as { streamErrorCode?: number } | undefined)?.streamErrorCode;
    if (!this.host.alive) return new KdoqConnectionError("the connection was lost", { outcome, requestId: this.requestId, cause });
    const e = new KdoqIncompleteError(`the stream was reset${resetCode === undefined ? "" : ` (code ${resetCode})`}`, {
      outcome,
      requestId: this.requestId,
      cause,
    });
    e.resetCode = resetCode;
    return e;
  }

  /** The next response event, or null after END. ERROR and an incomplete stream throw. */
  async next(): Promise<OpEvent | null> {
    for (;;) {
      if (this.aborted !== undefined) {
        this.report("cancelled");
        throw this.aborted;
      }
      if (this.finished) return null;
      let f: Frame | null;
      try {
        f = await this.reader.read();
      } catch (e) {
        this.finished = true;
        this.clearAbortListeners();
        this.report(this.aborted !== undefined ? "cancelled" : "error");
        throw this.aborted !== undefined ? this.aborted : this.lost(e);
      }
      if (this.aborted !== undefined) {
        this.report("cancelled");
        throw this.aborted;
      }
      if (f) this.logFrame(f);
      if (!f) {
        this.log("stream ended without END or ERROR");
        this.finished = true;
        this.clearAbortListeners();
        this.report("error");
        throw new KdoqIncompleteError("the stream ended without END or ERROR", {
          outcome: this.write ? "Unknown" : "NotApplied",
          requestId: this.requestId,
        });
      }
      switch (f.kind) {
        case Kind.DICTIONARY:
          this.addDictionary(new Fields(f.payload));
          continue;
        case Kind.BEGIN: {
          const fields = new Fields(f.payload);
          this.begin = fields;
          this.beginAt = performance.now();
          return { kind: "begin", fields };
        }
        case Kind.ITEM:
          return { kind: "item", fields: new Fields(f.payload) };
        case Kind.DIAGNOSTIC:
          return { kind: "diagnostic", fields: new Fields(f.payload) };
        case Kind.PROGRESS:
          return { kind: "progress", fields: new Fields(f.payload) };
        case Kind.END:
          this.finish();
          this.report("ok");
          return { kind: "end", fields: new Fields(f.payload) };
        case Kind.ERROR: {
          this.finish();
          const error = errorFromFrame(f.payload);
          this.report("error", error.code ?? undefined);
          throw error;
        }
        default:
          this.finish();
          this.report("error");
          throw malformed(`unexpected frame kind 0x${f.kind.toString(16)} in a response`);
      }
    }
  }

  private logFrame(f: Frame): void {
    this.responseBytes += f.payload.length;
    if (f.kind === Kind.ITEM) {
      if (this.items === 0) {
        this.firstItemAt = performance.now();
        this.log(`first ITEM, ${f.payload.length} bytes`);
      }
      this.items++;
      this.itemBytes += f.payload.length;
      return;
    }
    const kind = KIND_NAMES[f.kind] ?? `0x${f.kind.toString(16)}`;
    if (f.kind === Kind.END || f.kind === Kind.ERROR) {
      let detail = "";
      if (f.kind === Kind.ERROR) {
        const fields = new Fields(f.payload);
        detail = ` code=${fields.u16(2)}`;
      }
      this.log(`${kind}${detail}, ${f.payload.length} bytes; items=${this.items} itemBytes=${this.itemBytes}`);
    } else this.log(`${kind}, ${f.payload.length} bytes`);
  }

  private finish(): void {
    this.finished = true;
    this.clearAbortListeners();
    void this.reader.cancel();
  }

  private addDictionary(f: Fields): void {
    const context = Number(f.need(f.u64(1), 1));
    let names = this.contexts.get(context);
    if (!names) this.contexts.set(context, (names = new Map()));
    for (const entry of f.groups(2)) names.set(entry.need(entry.u32(1), 1), entry.need(entry.str(2), 2));
  }

  /** Decodes a result value announced in `context`. */
  decode(context: number | bigint, bytes: Uint8Array): Value {
    return decodeValue(bytes, this.contexts.get(Number(context)) ?? new Map());
  }

  /** Stops the operation: CANCEL on the control stream and a closed read side. */
  async cancel(): Promise<void> {
    if (this.finished) return;
    this.log("cancelled by the client");
    this.finished = true;
    this.clearAbortListeners();
    this.report("cancelled");
    await Promise.all([this.reader.cancel(), this.host.alive ? this.host.cancel(this.requestId).catch(() => {}) : Promise.resolve()]);
  }
}
