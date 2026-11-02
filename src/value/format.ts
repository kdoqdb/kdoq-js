import {
  Binary,
  Double,
  Int32,
  Int64,
  Code,
  Decimal128,
  KqDate,
  KqRegExp,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  type Value,
} from "./values.js";
import { KeyBytes } from "./values.js";

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** JSONX-like text for the console: typed values keep their type. */
export function format(value: Value, options: { indent?: number } = {}): string {
  const indent = options.indent ?? 2;
  const write = (v: Value, depth: number): string => {
    const pad = (n: number) => (indent ? "\n" + " ".repeat(indent * n) : "");
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
    if (typeof v === "bigint") return `NumberLong("${v}")`;
    if (typeof v === "boolean") return String(v);
    if (v instanceof Date) return `ISODate("${v.toISOString()}")`;
    if (v instanceof KqDate) return `Date("${v}")`;
    if (v instanceof Int32) return `NumberInt(${v.value})`;
    if (v instanceof Int64) return `NumberLong("${v.value}")`;
    if (v instanceof Double) return Object.is(v.value, -0) ? "-0" : Number.isInteger(v.value) ? `${v.value}.0` : String(v.value);
    if (v instanceof Decimal128) return `NumberDecimal("${v}")`;
    if (v instanceof Timestamp) return `Timestamp(${v.seconds}, ${v.increment})`;
    if (v instanceof Code) return `Code(${JSON.stringify(v.source)})`;
    if (v instanceof ObjectId) return `ObjectId("${v}")`;
    if (v instanceof KqRegExp) return `/${v.pattern}/${v.options}`;
    if (v instanceof MinKey) return "MinKey";
    if (v instanceof MaxKey) return "MaxKey";
    if (v instanceof Binary) return `BinData(${v.subtype}, "${hexOf(v.bytes)}")`;
    if (v instanceof KeyBytes) return `BinData(0, "${hexOf(v)}")`;
    if (v instanceof Uint8Array) return `BinData(0, "${hexOf(v)}")`;
    if (Array.isArray(v)) return v.length ? `[${v.map((x) => pad(depth + 1) + write(x, depth + 1)).join(",")}${pad(depth)}]` : "[]";
    const entries = Object.entries(v);
    return entries.length
      ? `{${entries.map(([k, x]) => `${pad(depth + 1)}${JSON.stringify(k)}: ${write(x, depth + 1)}`).join(",")}${pad(depth)}}`
      : "{}";
  };
  return write(value, 0);
}
