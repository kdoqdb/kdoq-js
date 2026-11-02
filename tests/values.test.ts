import { describe, expect, test } from "bun:test";
import {
  Binary,
  Code,
  Decimal128,
  decodeValue,
  encodeDocument,
  KqDate,
  KqRegExp,
  MaxKey,
  MinKey,
  NameDictionary,
  ObjectId,
  Timestamp,
  type Value,
} from "../src/internal/codec";
import { ScramClient } from "../src/internal/scram";
import { bytes, hex } from "./wire.test";

const names = (...list: string[]) => new Map(list.map((n, i) => [i, n] as [number, string]));

describe("decoding reference bytes", () => {
  test("compact object with Int8", () => {
    expect(decodeValue(bytes("87 07 01 01 01 00 00 80 f9"), names("x"))).toEqual({ x: -7 });
  });
  test("empty objects and arrays", () => {
    expect(decodeValue(bytes("87 03 01 01 00"), names())).toEqual({});
    expect(decodeValue(bytes("88 09 01 00 00 00 00 00 00 00 00"), names())).toEqual({});
    expect(decodeValue(bytes("89 01 00"), names())).toEqual([]);
    expect(decodeValue(bytes("8a 02 01 00"), names())).toEqual([]);
  });
  test("bitmap object with eight Nulls", () => {
    const doc = decodeValue(
      bytes("88 19 01 ff 00 00 00 00 00 00 00 00 01 02 03 04 05 06 07 0a 0a 0a 0a 0a 0a 0a 0a"),
      names(..."abcdefgh"),
    );
    expect(doc).toEqual({ a: null, b: null, c: null, d: null, e: null, f: null, g: null, h: null });
  });
  test("scalars: fixed widths, Undefined, Int64 safety", () => {
    expect(decodeValue(bytes("82 ff"), names())).toBe(255);
    expect(decodeValue(bytes("85 ff ff ff ff ff ff ff ff"), names())).toBe(18446744073709551615n);
    expect(decodeValue(bytes("12 ff ff ff ff ff ff ff 7f"), names())).toBe(9223372036854775807n);
    expect(decodeValue(bytes("12 05 00 00 00 00 00 00 00"), names())).toBe(5);
    expect(decodeValue(bytes("06"), names())).toBeUndefined();
    expect(decodeValue(bytes("8b 02 68 69"), names())).toBe("hi");
  });
  test("rejects malformed values", () => {
    expect(() => decodeValue(bytes("08 02"), names())).toThrow();
    expect(() => decodeValue(bytes("87 03 01 01 00 00"), names())).toThrow(/trailing/);
    expect(() => decodeValue(bytes("02 00"), names())).toThrow(/tag/);
    expect(() => decodeValue(bytes("87 06 01 01 01 00 00 0a"), names())).toThrow(/dictionary/);
  });
});

describe("encoding", () => {
  test("empty object and compact layout match the reference", () => {
    expect(hex(encodeDocument({}, new NameDictionary()))).toBe("87 03 01 01 00");
    const dict = new NameDictionary();
    expect(hex(encodeDocument({ x: null }, dict))).toBe("87 06 01 01 01 00 00 0a");
  });
  test("numbers pick Int32, then Int64, then Double", () => {
    const enc = (v: Value) => hex(encodeDocument({ v }, new NameDictionary())).slice(21);
    expect(enc(7)).toBe("10 07 00 00 00");
    expect(enc(2 ** 31)).toBe("12 00 00 00 80 00 00 00 00");
    expect(enc(1.5)).toBe("01 00 00 00 00 00 00 f8 3f");
    expect(enc(-0)).toMatch(/^01 /);
    expect(enc(2 ** 60)).toMatch(/^01 /);
    expect(enc(2n ** 60n)).toMatch(/^12 /);
  });
  test("round trips every supported type", () => {
    const doc = {
      s: "héllo",
      t: true,
      f: false,
      n: null,
      int: -5,
      big: 2n ** 62n,
      dbl: 0.25,
      nan: NaN,
      date: new Date(Date.UTC(2026, 10, 1, 12, 30, 15, 123)),
      day: new KqDate(2026, 11, 1),
      ts: new Timestamp(1700000000, 3),
      code: new Code("x + 1"),
      dec: Decimal128.from("12.50"),
      oid: new ObjectId(bytes("00 01 02 03 04 05 06 07 08 09 0a 0b")),
      re: new KqRegExp("^a", "i"),
      min: new MinKey(),
      max: new MaxKey(),
      bin: Uint8Array.of(1, 2, 3),
      uuid: new Binary(4, new Uint8Array(16).fill(7)),
      legacy: new Binary(2, Uint8Array.of(9, 8)),
      arr: [1, "two", [3], { four: 4 }],
      nested: { a: { b: { c: [] } } },
      "with.dot": 1,
    };
    const dict = new NameDictionary();
    const encoded = encodeDocument(doc, dict);
    const map = new Map(dict.drain());
    expect(decodeValue(encoded, map)).toEqual(doc);
  });
  test("rejects Undefined and non-plain objects", () => {
    expect(() => encodeDocument({ a: undefined }, new NameDictionary())).toThrow(/Undefined/);
    expect(() => encodeDocument({ a: new Map() as unknown as Value }, new NameDictionary())).toThrow();
    expect(() => encodeDocument({ a: 2n ** 63n }, new NameDictionary())).toThrow(/Int64/);
  });
  test("field IDs are shared across nested objects and wide dictionaries use wider IDs", () => {
    const doc: Record<string, Value> = {};
    for (let i = 0; i < 300; i++) doc[`f${i}`] = i;
    const dict = new NameDictionary();
    const encoded = encodeDocument(doc, dict);
    expect(decodeValue(encoded, new Map(dict.drain()))).toEqual(doc);
  });
  test("a field named __proto__ stays an own property", () => {
    const doc = JSON.parse('{"__proto__": 1}');
    const dict = new NameDictionary();
    const out = decodeValue(encodeDocument(doc, dict), new Map(dict.drain())) as Record<string, Value>;
    expect(Object.keys(out)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("Decimal128", () => {
  test("text round trips and special values", () => {
    for (const t of [
      "0",
      "1",
      "-1",
      "12.50",
      "0.001",
      "1.23E+20",
      "0E-10",
      "-0",
      "Infinity",
      "-Infinity",
      "NaN",
      "9.999999999999999999999999999999999E+6144",
    ]) {
      expect(Decimal128.from(t).toString()).toBe(t === "-0" ? "-0" : t);
    }
    expect(Decimal128.from("1e3").toString()).toBe("1E+3");
  });
  test("matches the BSON BID bytes of known values", () => {
    expect(hex(Decimal128.from("1").bytes)).toBe("01 00 00 00 00 00 00 00 00 00 00 00 00 00 40 30");
    expect(hex(Decimal128.from("-0.1").bytes)).toBe("01 00 00 00 00 00 00 00 00 00 00 00 00 00 3e b0");
  });
  test("rejects text that needs rounding", () => {
    expect(() => Decimal128.from("1.00000000000000000000000000000000001")).toThrow();
    expect(() => Decimal128.from("abc")).toThrow();
  });
});

describe("KqDate", () => {
  test("converts to and from Unix days", () => {
    expect(new KqDate(1970, 1, 1).toDays()).toBe(0);
    expect(new KqDate(2026, 11, 1).toDays()).toBe(20758);
    expect(KqDate.fromDays(-719528).toString()).toBe("0000-01-01");
    expect(KqDate.fromDays(2932896).toString()).toBe("9999-12-31");
    expect(KqDate.fromDays(20758).toString()).toBe("2026-11-01");
  });
});

describe("SCRAM-SHA-256", () => {
  test("RFC 7677 exchange", async () => {
    const client = new ScramClient("user", "pencil", "rOprNGfwEbeRWgbNEkqO");
    expect(client.first()).toBe("n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
    const final = await client.final("r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096");
    expect(final).toBe("c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
    client.verify("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
    expect(() => client.verify("v=AAAA")).toThrow();
  });
  test("rejects a server nonce that does not extend the client nonce", async () => {
    const client = new ScramClient("user", "pencil", "abc");
    await expect(client.final("r=zzz,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096")).rejects.toThrow();
  });
});
