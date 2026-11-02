import { KdoqIncompleteError, malformed } from "../errors.js";

export const Kind = {
  HELLO: 0x0001,
  AUTH: 0x0002,
  READY: 0x0003,
  CANCEL: 0x0004,
  CONTROL_ACK: 0x0005,
  LOGOUT: 0x0006,
  COMMAND: 0x0100,
  INPUT_VALUE: 0x0101,
  INPUT_END: 0x0102,
  BEGIN: 0x0200,
  ITEM: 0x0201,
  DIAGNOSTIC: 0x0202,
  PROGRESS: 0x0203,
  END: 0x0204,
  ERROR: 0x0205,
  DICTIONARY: 0x0300,
} as const;

export const empty = new Uint8Array(0);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Unsigned LEB128 in the u32 range, minimal form. */
export function encodeU32V(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`U32V out of range: ${n}`);
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Uint8Array.from(out);
}

export function readU32V(bytes: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos + i >= bytes.length) throw malformed("truncated U32V");
    const byte = bytes[pos + i];
    if (i === 4 && byte > 0x0f) throw malformed("U32V overflow");
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) {
      if (i > 0 && byte === 0) throw malformed("non-minimal U32V");
      return { value, next: pos + i + 1 };
    }
  }
  throw malformed("overlong U32V");
}

function le(value: number | bigint, size: 1 | 2 | 4 | 8): Uint8Array {
  const out = new Uint8Array(size);
  let v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(size * 8)) throw new RangeError(`u${size * 8} out of range: ${value}`);
  for (let i = 0; i < size; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** A number when it is a safe integer, otherwise a bigint. */
export const safe = (v: bigint): number | bigint =>
  v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const utf8 = (s: string): Uint8Array => encoder.encode(s);
export const text = (b: Uint8Array): string => decoder.decode(b);

/** One field: header (REQUIRED bit, id), U32V length, value. */
export function field(id: number, value: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x80 | id), encodeU32V(value.length), value);
}

export const enc = {
  u8: (id: number, v: number) => field(id, le(v, 1)),
  u16: (id: number, v: number) => field(id, le(v, 2)),
  u32: (id: number, v: number) => field(id, le(v, 4)),
  u64: (id: number, v: number | bigint) => field(id, le(v, 8)),
  bool: (id: number, v: boolean) => field(id, le(v ? 1 : 0, 1)),
  str: (id: number, v: string) => field(id, utf8(v)),
  bin: (id: number, v: Uint8Array) => field(id, v),
  group: (id: number, ...children: Uint8Array[]) => field(id, concat(...children)),
  u16list: (id: number, v: number[]) => field(id, concat(...v.map((n) => le(n, 2)))),
};

export function encodeFrame(kind: number, payload: Uint8Array = empty): Uint8Array {
  return concat(le(kind, 2), le(0, 2), le(payload.length, 4), payload);
}

export const frame = (kind: number, ...fields: Uint8Array[]): Uint8Array => encodeFrame(kind, concat(...fields));

/** The parsed fields of one payload or group; each ID maps to its values in order. */
export class Fields {
  private readonly map = new Map<number, Uint8Array[]>();

  constructor(payload: Uint8Array) {
    let pos = 0;
    while (pos < payload.length) {
      const header = payload[pos++];
      const id = header & 0x3f;
      if (header & 0x40 || id === 0) throw malformed("invalid field header");
      const { value: length, next } = readU32V(payload, pos);
      if (next + length > payload.length) throw malformed("truncated field");
      const list = this.map.get(id);
      const value = payload.subarray(next, next + length);
      if (list) list.push(value);
      else this.map.set(id, [value]);
      pos = next + length;
    }
  }

  has(id: number): boolean {
    return this.map.has(id);
  }
  bin(id: number): Uint8Array | undefined {
    return this.map.get(id)?.[0];
  }
  all(id: number): Uint8Array[] {
    return this.map.get(id) ?? [];
  }

  private fixed(id: number, size: number): Uint8Array | undefined {
    const v = this.bin(id);
    if (v && v.length !== size) throw malformed(`field ${id} has length ${v.length}, expected ${size}`);
    return v;
  }
  u8(id: number): number | undefined {
    return this.fixed(id, 1)?.[0];
  }
  u16(id: number): number | undefined {
    const v = this.fixed(id, 2);
    return v && v[0] | (v[1] << 8);
  }
  u32(id: number): number | undefined {
    const v = this.fixed(id, 4);
    return v && new DataView(v.buffer, v.byteOffset, 4).getUint32(0, true);
  }
  u64(id: number): number | bigint | undefined {
    const v = this.fixed(id, 8);
    return v && safe(new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true));
  }
  str(id: number): string | undefined {
    const v = this.bin(id);
    return v && text(v);
  }
  group(id: number): Fields | undefined {
    const v = this.bin(id);
    return v && new Fields(v);
  }
  groups(id: number): Fields[] {
    return this.all(id).map((v) => new Fields(v));
  }
  u16list(id: number): number[] {
    const v = this.bin(id);
    if (!v) return [];
    if (v.length % 2) throw malformed(`field ${id} is not a list of u16`);
    const out: number[] = [];
    for (let i = 0; i < v.length; i += 2) out.push(v[i] | (v[i + 1] << 8));
    return out;
  }

  need<T>(value: T | undefined, id: number): T {
    if (value === undefined) throw malformed(`missing required field ${id}`);
    return value;
  }
}

export interface Frame {
  kind: number;
  payload: Uint8Array;
}

export class FrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(
    readable: ReadableStream<Uint8Array>,
    private readonly ceiling: number,
  ) {
    this.reader = readable.getReader();
  }

  private async need(n: number): Promise<boolean> {
    while (this.size < n) {
      const { value, done } = await this.reader.read();
      if (done) return false;
      if (value.length) {
        this.chunks.push(value);
        this.size += value.length;
      }
    }
    return true;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.chunks[0];
      const k = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, k), at);
      at += k;
      if (k === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(k);
    }
    this.size -= n;
    return out;
  }

  /** The next frame, or null at a clean end of stream. */
  async read(): Promise<Frame | null> {
    if (!(await this.need(8))) {
      if (this.size === 0) return null;
      throw new KdoqIncompleteError("stream ended inside a frame prefix");
    }
    const prefix = this.take(8);
    const view = new DataView(prefix.buffer, prefix.byteOffset, 8);
    const kind = view.getUint16(0, true);
    const length = view.getUint32(4, true);
    if (kind === 0 || view.getUint16(2, true) !== 0) throw malformed("invalid frame prefix");
    if (8 + length > this.ceiling) throw malformed(`frame of ${8 + length} bytes exceeds the ceiling of ${this.ceiling}`);
    if (!(await this.need(length))) throw new KdoqIncompleteError("stream ended inside a frame");
    return { kind, payload: this.take(length) };
  }

  cancel(reason?: unknown): Promise<void> {
    return this.reader.cancel(reason).catch(() => {});
  }
}
