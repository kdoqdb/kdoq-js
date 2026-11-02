import { Decimal128 } from "./decimal.js";
import { invalidDocument } from "../errors.js";

export { Decimal128 };

export class Timestamp {
  constructor(
    readonly seconds: number,
    readonly increment: number,
  ) {}
}

export class Code {
  constructor(readonly source: string) {}
}

export class Binary {
  constructor(
    readonly subtype: number,
    readonly bytes: Uint8Array,
  ) {}
}

export class ObjectId {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    if (bytes.length !== 12) throw invalidDocument("ObjectId needs exactly 12 bytes");
    this.bytes = Uint8Array.from(bytes);
  }
  toString(): string {
    return Array.from(this.bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

/** A pattern with its sorted option letters (`ilmsux`); never compiled. */
export class KqRegExp {
  constructor(
    readonly pattern: string,
    readonly options: string = "",
  ) {}
}

/** An int32, to store an integral number as that type instead of the width chosen by value. */
export class Int32 {
  readonly value: number;
  constructor(value: number) {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw invalidDocument(`${value} is not an Int32`);
    this.value = value;
  }
}

/** An int64, to store a number or bigint as that type. */
export class Int64 {
  readonly value: bigint;
  constructor(value: number | bigint) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw invalidDocument(`${value} is not a safe integer`);
    const n = BigInt(value);
    if (n < -(1n << 63n) || n >= 1n << 63n) throw invalidDocument(`${value} does not fit Int64`);
    this.value = n;
  }
}

/** A double, to store an integral number as a double (`new Double(1)`) instead of an integer. */
export class Double {
  constructor(readonly value: number) {}
}

export class MinKey {}
export class MaxKey {}

/** A calendar date without a time of day (Gregorian years 0000-9999). */
export class KqDate {
  constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
  ) {}

  /** Days since 1970-01-01. */
  toDays(): number {
    const y = this.month <= 2 ? this.year - 1 : this.year;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (this.month + (this.month > 2 ? -3 : 9)) + 2) / 5) + this.day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  static fromDays(days: number): KqDate {
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return new KqDate(yoe + era * 400 + (month <= 2 ? 1 : 0), month, day);
  }

  toString(): string {
    const p = (n: number, w: number) => String(n).padStart(w, "0");
    return `${p(this.year, 4)}-${p(this.month, 2)}-${p(this.day, 2)}`;
  }
}

export type Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | undefined
  | Date
  | Uint8Array
  | Binary
  | KqDate
  | Timestamp
  | Code
  | Decimal128
  | ObjectId
  | KqRegExp
  | MinKey
  | MaxKey
  | Value[]
  | { [field: string]: Value };
export type Doc = { [field: string]: Value };

/** A document key; `.text()` is the UTF-8 string, or null when the bytes are not UTF-8. */
export class KeyBytes extends Uint8Array {
  text(): string | null {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this);
    } catch {
      return null;
    }
  }
  static copyOf(bytes: Uint8Array): KeyBytes {
    return new KeyBytes(Uint8Array.from(bytes).buffer);
  }
}

/** A native grouping key (kind 2). */
export class GroupKey {
  constructor(readonly value: Value) {}
}
