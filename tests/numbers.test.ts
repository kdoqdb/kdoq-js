import { describe, expect, test } from "bun:test";
import { encodeDocument, NameDictionary } from "../src/internal/codec";
import { Double, Int32, Int64 } from "../src/value";

/** The element tag of the single field `a`: its value is the last thing in the encoded document. */
function tagOf(value: unknown, valueSize: number): number {
  const bytes = encodeDocument({ a: value } as never, new NameDictionary());
  return bytes[bytes.length - valueSize - 1];
}

describe("numeric wrappers", () => {
  test("Int32, Int64 and Double store the type they name", () => {
    expect(tagOf(1, 4)).toBe(0x10);
    expect(tagOf(new Int32(1), 4)).toBe(0x10);
    expect(tagOf(new Int64(1), 8)).toBe(0x12);
    expect(tagOf(new Double(1), 8)).toBe(0x01);
    expect(tagOf(2n, 8)).toBe(0x12);
    expect(tagOf(1.5, 8)).toBe(0x01);
  });

  test("out-of-range values are rejected", () => {
    expect(() => new Int32(2 ** 31)).toThrow();
    expect(() => new Int32(1.5)).toThrow();
    expect(() => new Int64(2 ** 60)).toThrow();
    expect(() => new Int64(1n << 63n)).toThrow();
  });
});
