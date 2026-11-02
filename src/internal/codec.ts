import { KdoqError, ErrorCode, invalidDocument, malformed } from "../errors.js";
import {
  Binary,
  Double,
  Int32,
  Int64,
  Code,
  Decimal128,
  GroupKey,
  KeyBytes,
  KqDate,
  KqRegExp,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  type Doc,
  type Value,
} from "../value/values.js";
import { concat, encodeU32V, readU32V, safe, text, utf8 } from "./wire.js";

export { Binary, Code, Decimal128, GroupKey, KeyBytes, KqDate, KqRegExp, MaxKey, MinKey, ObjectId, Timestamp, type Doc, type Value };

const MAX_DEPTH = 64;

// ---- Decoding ------------------------------------------------------------

class Reader {
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
    readonly end = bytes.length,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private take(n: number): number {
    if (n < 0 || this.pos + n > this.end) throw malformed("truncated value");
    const at = this.pos;
    this.pos += n;
    return at;
  }
  u8(): number {
    return this.bytes[this.take(1)];
  }
  i8(): number {
    return this.view.getInt8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }
  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }
  i64(): bigint {
    return this.view.getBigInt64(this.take(8), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }
  raw(n: number): Uint8Array {
    const at = this.take(n);
    return this.bytes.subarray(at, at + n);
  }
  v32(): number {
    const { value, next } = readU32V(this.bytes.subarray(0, this.end), this.pos);
    this.pos = next;
    return value;
  }
}

function setField(target: Doc, key: string, value: Value): void {
  if (key === "__proto__") Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  else target[key] = value;
}

function readObject(r: Reader, names: ReadonlyMap<number, string>, depth: number, bitmap: boolean): Doc {
  if (depth > MAX_DEPTH) throw malformed("container depth exceeds the limit");
  const length = r.v32();
  const body = new Reader(r.bytes, r.pos, r.pos + length);
  r.raw(length);
  const ids: number[] = [];
  if (bitmap) {
    const offsetWidth = body.u8();
    const mask = body.u64();
    for (let i = 0; i < 64; i++) if ((mask >> BigInt(i)) & 1n) ids.push(i);
    body.raw(ids.length * offsetWidth);
  } else {
    const idWidth = body.u8();
    const offsetWidth = body.u8();
    const count = body.v32();
    if (![1, 2, 4].includes(idWidth) || ![1, 2, 4].includes(offsetWidth)) throw malformed("invalid directory width");
    for (let i = 0; i < count; i++) ids.push(idWidth === 1 ? body.u8() : idWidth === 2 ? body.u16() : body.u32());
    body.raw(count * offsetWidth);
  }
  const doc: Doc = {};
  for (const id of ids) {
    const name = names.get(id);
    if (name === undefined) throw invalidDocument(`field id ${id} is not in the dictionary`);
    setField(doc, name, readValue(body, names, depth));
  }
  if (body.pos !== body.end) throw malformed("object body has trailing bytes");
  return doc;
}

function readArray(r: Reader, names: ReadonlyMap<number, string>, depth: number, indexed: boolean): Value[] {
  if (depth > MAX_DEPTH) throw malformed("container depth exceeds the limit");
  const length = r.v32();
  const body = new Reader(r.bytes, r.pos, r.pos + length);
  r.raw(length);
  let width = 0;
  if (indexed) width = body.u8();
  const count = body.v32();
  if (indexed) body.raw(count * width);
  const out: Value[] = [];
  for (let i = 0; i < count; i++) out.push(readValue(body, names, depth));
  if (body.pos !== body.end) throw malformed("array body has trailing bytes");
  return out;
}

function readValue(r: Reader, names: ReadonlyMap<number, string>, depth: number): Value {
  const tag = r.u8();
  switch (tag) {
    case 0x01:
      return r.f64();
    case 0x05: {
      const length = r.i32();
      const subtype = r.u8();
      let payload = r.raw(length);
      if (subtype === 2) {
        if (payload.length < 4) throw malformed("truncated Binary subtype 2");
        const inner = new DataView(payload.buffer, payload.byteOffset, 4).getInt32(0, true);
        if (inner !== payload.length - 4) throw malformed("inconsistent Binary subtype 2 framing");
        payload = payload.subarray(4);
      }
      const bytes = Uint8Array.from(payload);
      return subtype === 0 ? bytes : new Binary(subtype, bytes);
    }
    case 0x06:
      return undefined;
    case 0x07:
      return new ObjectId(r.raw(12));
    case 0x08: {
      const b = r.u8();
      if (b > 1) throw malformed("invalid Boolean");
      return b === 1;
    }
    case 0x09: {
      const ms = r.i64();
      const date = new Date(Number(ms));
      if (Number.isNaN(date.getTime()) || BigInt(date.getTime()) !== ms)
        throw new KdoqError("DateTime is outside the JavaScript Date range", { code: ErrorCode.LimitExceeded });
      return date;
    }
    case 0x0a:
      return null;
    case 0x0d: {
      const n = r.i32() - 1;
      const source = text(r.raw(n));
      if (r.u8() !== 0) throw malformed("Code is not zero terminated");
      return new Code(source);
    }
    case 0x10:
      return r.i32();
    case 0x11: {
      const increment = r.u32();
      return new Timestamp(r.u32(), increment);
    }
    case 0x12:
      return safe(r.i64());
    case 0x13:
      return new Decimal128(r.raw(16));
    case 0x7f:
      return new MaxKey();
    case 0x80:
      return r.i8();
    case 0x81:
      return r.i16();
    case 0x82:
      return r.u8();
    case 0x83:
      return r.u16();
    case 0x84:
      return r.u32();
    case 0x85:
      return safe(r.u64());
    case 0x86:
      return KqDate.fromDays(r.i32());
    case 0x87:
      return readObject(r, names, depth + 1, false);
    case 0x88:
      return readObject(r, names, depth + 1, true);
    case 0x89:
      return readArray(r, names, depth + 1, false);
    case 0x8a:
      return readArray(r, names, depth + 1, true);
    case 0x8b:
      return text(r.raw(r.v32()));
    case 0x8c: {
      const length = r.v32();
      const body = new Reader(r.bytes, r.pos, r.pos + length);
      r.raw(length);
      const pattern = text(body.raw(body.v32()));
      const options = text(body.raw(body.v32()));
      return new KqRegExp(pattern, options);
    }
    case 0xff:
      return new MinKey();
    default:
      throw malformed(`unsupported value tag 0x${tag.toString(16)}`);
  }
}

/** Decodes one complete result value against a dictionary context. */
export function decodeValue(bytes: Uint8Array, names: ReadonlyMap<number, string>): Value {
  const r = new Reader(bytes);
  const value = readValue(r, names, 0);
  if (r.pos !== bytes.length) throw malformed("trailing bytes after the value");
  return value;
}

// ---- Encoding ------------------------------------------------------------

/** Assigns field IDs to names in first-use order and tracks the entries not yet announced. */
export class NameDictionary {
  private readonly ids = new Map<string, number>();
  private pending: Array<[number, string]> = [];

  idOf(name: string): number {
    let id = this.ids.get(name);
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(name, id);
      this.pending.push([id, name]);
    }
    return id;
  }

  /** The entries added since the previous call. */
  drain(): Array<[number, string]> {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function le(n: number | bigint, size: number, signed = false): Uint8Array {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (size === 4) signed ? view.setInt32(0, Number(n), true) : view.setUint32(0, Number(n), true);
  else if (size === 8) signed ? view.setBigInt64(0, BigInt(n), true) : view.setBigUint64(0, BigInt(n), true);
  else if (size === 2) view.setUint16(0, Number(n), true);
  else out[0] = Number(n);
  return out;
}

const tagged = (tag: number, ...rest: Uint8Array[]) => concat(Uint8Array.of(tag), ...rest);
const width = (max: number): 1 | 2 | 4 => (max <= 0xff ? 1 : max <= 0xffff ? 2 : 4);
const widthOf = (n: number, w: number) => le(n, w);
const isPlain = (v: object) => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

function encodeNumber(v: number): Uint8Array {
  if (Number.isInteger(v) && !Object.is(v, -0)) {
    if (v >= -0x80000000 && v <= 0x7fffffff) return tagged(0x10, le(v, 4, true));
    if (Number.isSafeInteger(v)) return tagged(0x12, le(BigInt(v), 8, true));
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, v, true);
  return tagged(0x01, out);
}

function encodeObject(doc: object, dict: NameDictionary, depth: number): Uint8Array {
  if (depth > MAX_DEPTH) throw invalidDocument("container depth exceeds the limit");
  const entries = Object.entries(doc).map(([name, value]) => ({ id: dict.idOf(name), value: encodeAt(value as Value, dict, depth) }));
  entries.sort((a, b) => a.id - b.id);
  const values = concat(...entries.map((e) => e.value));
  const idWidth = width(entries.length ? entries[entries.length - 1].id : 0);
  const offsetWidth = width(values.length);
  const offsets: Uint8Array[] = [];
  let at = 0;
  for (const e of entries) {
    offsets.push(widthOf(at, offsetWidth));
    at += e.value.length;
  }
  const body = concat(
    Uint8Array.of(idWidth, offsetWidth),
    encodeU32V(entries.length),
    ...entries.map((e) => widthOf(e.id, idWidth)),
    ...offsets,
    values,
  );
  return tagged(0x87, encodeU32V(body.length), body);
}

function encodeAt(v: Value, dict: NameDictionary, depth: number): Uint8Array {
  if (v === null) return Uint8Array.of(0x0a);
  switch (typeof v) {
    case "boolean":
      return Uint8Array.of(0x08, v ? 1 : 0);
    case "number":
      return encodeNumber(v);
    case "bigint":
      if (v < -(1n << 63n) || v >= 1n << 63n) throw invalidDocument("bigint does not fit Int64");
      return tagged(0x12, le(v, 8, true));
    case "string": {
      const b = utf8(v);
      return tagged(0x8b, encodeU32V(b.length), b);
    }
    case "undefined":
      throw invalidDocument("Undefined cannot be written");
    case "object":
      break;
    default:
      throw invalidDocument(`unsupported value of type ${typeof v}`);
  }
  if (Array.isArray(v)) {
    if (depth + 1 > MAX_DEPTH) throw invalidDocument("container depth exceeds the limit");
    const body = concat(encodeU32V(v.length), ...v.map((x) => encodeAt(x, dict, depth + 1)));
    return tagged(0x89, encodeU32V(body.length), body);
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw invalidDocument("invalid Date");
    return tagged(0x09, le(BigInt(v.getTime()), 8, true));
  }
  if (v instanceof Int32) return tagged(0x10, le(v.value, 4, true));
  if (v instanceof Int64) return tagged(0x12, le(v.value, 8, true));
  if (v instanceof Double) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, v.value, true);
    return tagged(0x01, out);
  }
  if (v instanceof Uint8Array) return encodeBinary(0, v);
  if (v instanceof Binary) return encodeBinary(v.subtype, v.bytes);
  if (v instanceof KqDate) return tagged(0x86, le(v.toDays(), 4, true));
  if (v instanceof Timestamp) return tagged(0x11, le(v.increment, 4), le(v.seconds, 4));
  if (v instanceof Code) {
    const b = utf8(v.source);
    return tagged(0x0d, le(b.length + 1, 4, true), b, Uint8Array.of(0));
  }
  if (v instanceof Decimal128) return tagged(0x13, v.bytes);
  if (v instanceof ObjectId) return tagged(0x07, v.bytes);
  if (v instanceof KqRegExp) {
    const p = utf8(v.pattern),
      o = utf8(v.options);
    const body = concat(encodeU32V(p.length), p, encodeU32V(o.length), o);
    return tagged(0x8c, encodeU32V(body.length), body);
  }
  if (v instanceof MinKey) return Uint8Array.of(0xff);
  if (v instanceof MaxKey) return Uint8Array.of(0x7f);
  if (!isPlain(v)) throw invalidDocument(`unsupported object of type ${(v as object).constructor?.name}`);
  return encodeObject(v, dict, depth + 1);
}

function encodeBinary(subtype: number, bytes: Uint8Array): Uint8Array {
  if (subtype === 2) return tagged(0x05, le(bytes.length + 4, 4, true), Uint8Array.of(2), le(bytes.length, 4, true), bytes);
  return tagged(0x05, le(bytes.length, 4, true), Uint8Array.of(subtype), bytes);
}

/** Encodes any value (a document must be an Object) against `dict`. */
export function encodeValue(value: Value, dict: NameDictionary): Uint8Array {
  return encodeAt(value, dict, 0);
}

export function encodeDocument(doc: Doc, dict: NameDictionary): Uint8Array {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc) || !isPlain(doc))
    throw invalidDocument("a document must be a plain object");
  return encodeObject(doc, dict, 1);
}
