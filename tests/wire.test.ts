import { describe, expect, test } from "bun:test";
import { enc, encodeFrame, encodeU32V, Fields, frame, FrameReader, Kind, readU32V, utf8 } from "../src/internal/wire";
import { NameDictionary } from "../src/internal/codec";
import { dictionaryFrames, encodeStatement, expr } from "../src/internal/mutations";
import { parseDsn } from "../src/dsn";
import { KdoqConfigError } from "../src/errors";

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
export const bytes = (s: string) =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((h) => parseInt(h, 16)),
  );

describe("U32V", () => {
  test("encodes minimally", () => {
    expect(hex(encodeU32V(0))).toBe("00");
    expect(hex(encodeU32V(127))).toBe("7f");
    expect(hex(encodeU32V(128))).toBe("80 01");
    expect(hex(encodeU32V(0xffffffff))).toBe("ff ff ff ff 0f");
  });
  test("rejects non-minimal and overlong forms", () => {
    expect(() => readU32V(bytes("80 00"), 0)).toThrow();
    expect(() => readU32V(bytes("ff ff ff ff 1f"), 0)).toThrow();
    expect(readU32V(bytes("80 01"), 0)).toEqual({ value: 128, next: 2 });
  });
});

describe("reference bytes", () => {
  test("DOCUMENT_GET COMMAND of the protocol reference", () => {
    const payload = new Uint8Array([...enc.str(1, "Test"), ...enc.str(2, "Docs"), ...enc.bin(3, bytes("00 ff 2f"))]);
    const command = frame(Kind.COMMAND, enc.u16(1, 0x0401), enc.u64(2, 42), enc.group(3, payload));
    expect(hex(command)).toBe(
      "00 01 00 00 21 00 00 00 81 02 01 04 82 08 2a 00 00 00 00 00 00 00 83 11 81 04 54 65 73 74 82 04 44 6f 63 73 83 03 00 ff 2f",
    );
    expect(hex(encodeFrame(Kind.INPUT_END))).toBe("02 01 00 00 00 00 00 00");
  });

  test("DOCUMENT_UPSERT statement of the protocol reference", () => {
    const frames = encodeStatement(new NameDictionary(), [{ set: { a: expr("1") } }], "k");
    expect(frames).toHaveLength(1);
    expect(hex(frames[0])).toBe("01 01 00 00 10 00 00 00 82 0e 81 0c 81 0a 81 03 81 01 61 82 03 82 01 31");
  });

  test("DICTIONARY and document INPUT_VALUE", () => {
    const dict = new NameDictionary();
    dict.idOf("x");
    expect(hex(dictionaryFrames(dict)[0])).toBe("00 03 00 00 15 00 00 00 81 08 01 00 00 00 00 00 00 00 82 09 81 04 00 00 00 00 82 01 78");
    expect(dictionaryFrames(dict)).toHaveLength(0);
  });
});

describe("fields", () => {
  test("parse repeated fields in order and reject malformed headers", () => {
    const f = new Fields(new Uint8Array([...enc.str(1, "a"), ...enc.str(1, "b"), ...enc.u16(2, 513)]));
    expect(f.all(1).map((v) => String.fromCharCode(...v))).toEqual(["a", "b"]);
    expect(f.u16(2)).toBe(513);
    expect(() => new Fields(bytes("c1 01 00"))).toThrow(); // reserved bit
    expect(() => new Fields(bytes("80 00"))).toThrow(); // field id zero
    expect(() => new Fields(bytes("81 05 00"))).toThrow(); // truncated
    expect(() => new Fields(enc.u16(1, 1)).u32(1)).toThrow(); // wrong width
  });
});

describe("FrameReader", () => {
  const streamOf = (...chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    });

  test("reassembles fragmented frames and splits coalesced ones", async () => {
    const a = frame(Kind.ITEM, enc.str(1, "hello")),
      b = encodeFrame(Kind.END);
    const all = new Uint8Array([...a, ...b]);
    const reader = new FrameReader(streamOf(all.subarray(0, 3), all.subarray(3, 11), all.subarray(11)), 1 << 20);
    expect((await reader.read())?.kind).toBe(Kind.ITEM);
    expect((await reader.read())?.kind).toBe(Kind.END);
    expect(await reader.read()).toBeNull();
  });

  test("rejects an oversized frame before allocating it and flags a truncated one", async () => {
    await expect(new FrameReader(streamOf(bytes("01 02 00 00 ff ff ff 7f")), 1024).read()).rejects.toThrow(/ceiling/);
    await expect(new FrameReader(streamOf(bytes("01 02 00 00 05 00 00 00 01")), 1024).read()).rejects.toThrow(/inside a frame/);
    await expect(new FrameReader(streamOf(bytes("01 02 00 01 00 00 00 00")), 1024).read()).rejects.toThrow(/prefix/);
  });
});

describe("DSN", () => {
  test("parses every part and decodes percent-encoding", () => {
    expect(parseDsn("kdoq://al%40x:p%3Aw@db.example:9000/my%20db")).toEqual({
      host: "db.example",
      port: 9000,
      username: "al@x",
      password: "p:w",
      database: "my db",
    });
    expect(parseDsn("kdoq://localhost")).toEqual({
      host: "localhost",
      port: undefined,
      username: undefined,
      password: undefined,
      database: undefined,
    });
    expect(parseDsn("kdoq://u@[::1]:8443/").host).toBe("[::1]");
  });
  test("rejects other schemes, queries and bad ports", () => {
    for (const bad of ["http://h", "kdoq://", "kdoq://h?x=1", "kdoq://h:0", "kdoq://h:70000", "kdoq://h/%zz"]) {
      expect(() => parseDsn(bad)).toThrow(KdoqConfigError);
    }
  });
});

export { utf8 };
