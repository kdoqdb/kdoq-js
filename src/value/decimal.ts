import { KdoqError, ErrorCode } from "../errors.js";

const BIAS = 6176;
const MAX_COEFFICIENT = 10n ** 34n - 1n;
const MASK_113 = (1n << 113n) - 1n;

const bad = (message: string) => new KdoqError(message, { code: ErrorCode.InvalidDocument });

/** IEEE 754-2008 Decimal128 as its sixteen BSON (BID) bytes; no arithmetic. */
export class Decimal128 {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (bytes.length !== 16) throw bad("Decimal128 needs exactly 16 bytes");
    this.bytes = Uint8Array.from(bytes);
  }

  /** Parses decimal text exactly; a value that needs rounding is rejected. */
  static from(text: string): Decimal128 {
    const s = text.trim();
    const sign = s.startsWith("-") ? 1n : 0n;
    const body = s.replace(/^[+-]/, "");
    let bits: bigint;
    if (/^inf(inity)?$/i.test(body)) bits = (sign << 127n) | (0b11110n << 122n);
    else if (/^nan$/i.test(body)) bits = 0b11111n << 122n;
    else {
      const m = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(body);
      if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw bad(`invalid Decimal128 text: ${text}`);
      const fraction = m[2] ?? "";
      let coefficient = BigInt(m[1] + fraction || "0");
      let exponent = Number(m[3] ?? 0) - fraction.length;
      let digits = coefficient === 0n ? 0 : coefficient.toString().length;
      while (exponent > 6111 && digits < 34) {
        coefficient *= 10n;
        exponent--;
        digits++;
      }
      if (coefficient === 0n) exponent = Math.max(-BIAS, Math.min(6111, exponent));
      if (coefficient > MAX_COEFFICIENT || exponent > 6111 || exponent < -BIAS) throw bad(`Decimal128 out of range or inexact: ${text}`);
      bits = (sign << 127n) | (BigInt(exponent + BIAS) << 113n) | coefficient;
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      out[i] = Number(bits & 0xffn);
      bits >>= 8n;
    }
    return new Decimal128(out);
  }

  toString(): string {
    let bits = 0n;
    for (let i = 15; i >= 0; i--) bits = (bits << 8n) | BigInt(this.bytes[i]);
    const negative = bits >> 127n === 1n;
    const sign = negative ? "-" : "";
    const top5 = (bits >> 122n) & 0x1fn;
    if (top5 === 0b11111n) return "NaN";
    if (top5 === 0b11110n) return `${sign}Infinity`;
    let exponent: number;
    let coefficient: bigint;
    if (((bits >> 125n) & 3n) === 3n) {
      exponent = Number((bits >> 111n) & 0x3fffn) - BIAS;
      coefficient = 0n;
    } else {
      exponent = Number((bits >> 113n) & 0x3fffn) - BIAS;
      coefficient = bits & MASK_113;
      if (coefficient > MAX_COEFFICIENT) coefficient = 0n;
    }
    const digits = coefficient.toString();
    const adjusted = exponent + digits.length - 1;
    if (exponent > 0 || adjusted < -6) {
      const rest = digits.length > 1 ? `.${digits.slice(1)}` : "";
      return `${sign}${digits[0]}${rest}E${adjusted >= 0 ? "+" : ""}${adjusted}`;
    }
    if (exponent === 0) return sign + digits;
    const point = digits.length + exponent;
    if (point > 0) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
    return `${sign}0.${"0".repeat(-point)}${digits}`;
  }
}
