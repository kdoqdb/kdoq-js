import { KdoqConnectionError, KdoqError, KdoqIncompleteError, malformed, type Outcome } from "../errors.js";
import { decodeValue, type Value } from "./codec.js";
import { empty, enc, Fields, frame, FrameReader, encodeFrame, Kind, type Frame } from "./wire.js";

export interface BiStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
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
  private aborted: unknown;
  /** The BEGIN fields, once received. */
  begin?: Fields;

  private constructor(
    private readonly host: OperationHost,
    stream: BiStream,
    ceiling: number,
    readonly requestId: number,
    private readonly write: boolean,
  ) {
    this.reader = new FrameReader(stream.readable, ceiling);
  }

  static start(
    host: OperationHost,
    stream: BiStream,
    ceiling: number,
    requestId: number,
    spec: OpSpec,
    signal?: AbortSignal,
  ): OperationStream {
    const op = new OperationStream(host, stream, ceiling, requestId, spec.write ?? false);
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
      } catch {
        /* the response side reports the failure */
      } finally {
        writer.releaseLock?.();
      }
    })();
    if (signal) {
      const onAbort = () => {
        op.aborted = signal.reason ?? new DOMException("Aborted", "AbortError");
        void op.cancel();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return op;
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
      if (this.aborted !== undefined) throw this.aborted;
      if (this.finished) return null;
      let f: Frame | null;
      try {
        f = await this.reader.read();
      } catch (e) {
        this.finished = true;
        throw this.aborted !== undefined ? this.aborted : this.lost(e);
      }
      if (this.aborted !== undefined) throw this.aborted;
      if (!f) {
        this.finished = true;
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
          return { kind: "end", fields: new Fields(f.payload) };
        case Kind.ERROR: {
          this.finish();
          const error = errorFromFrame(f.payload);
          throw error;
        }
        default:
          this.finish();
          throw malformed(`unexpected frame kind 0x${f.kind.toString(16)} in a response`);
      }
    }
  }

  private finish(): void {
    this.finished = true;
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
    this.finished = true;
    await this.reader.cancel();
    if (this.host.alive) await this.host.cancel(this.requestId).catch(() => {});
  }
}
