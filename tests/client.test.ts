import { describe, expect, test } from "bun:test";
import {
  connect,
  ErrorCode,
  expr,
  KdoqBulkError,
  KdoqConfigError,
  KdoqConnectionError,
  KdoqError,
  KdoqIncompleteError,
  type Client,
} from "../src";
import { KeyBytes } from "../src/value";
import { NameDictionary, encodeDocument } from "../src/internal/codec";
import { dictionaryFrames } from "../src/internal/mutations";
import { enc, encodeFrame, frame, Kind } from "../src/internal/wire";
import { documentReply, errorFrame, FakeServer, inputDocuments } from "./fake";

const open = (server: FakeServer, dsn: string | null = "kdoq://localhost/app", options = {}) =>
  connect(dsn, { transport: server.factory, retry: { attempts: 2, backoff: { initial: 1, max: 2 } }, ...options });

/** BEGIN with a cursor, one ITEM per document, END with the remaining cursor id. */
function page(cursor: number, docs: object[], remaining: number): Uint8Array[] {
  const out = [frame(Kind.BEGIN, enc.u64(1, cursor), enc.u64(2, cursor))];
  for (const [i, doc] of docs.entries()) {
    const dict = new NameDictionary();
    const bytes = encodeDocument(doc as never, dict);
    out.push(...dictionaryFrames(dict).map((f) => f));
    out.push(
      frame(Kind.ITEM, enc.group(1, enc.u16(1, 1), enc.bin(2, new TextEncoder().encode(`k${i}`))), enc.u64(2, 1), enc.bin(3, bytes)),
    );
  }
  out.push(frame(Kind.END, enc.u64(1, remaining)));
  return out;
}

describe("connecting", () => {
  test("anonymous session: HELLO, READY, health", async () => {
    const server = new FakeServer({ accessLevel: 2 });
    server.handler = () => [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.u8(1, 1)), encodeFrame(Kind.END)];
    const client = await open(server);
    expect(client.state).toBe("connected");
    expect(client.session).toEqual({ id: 7, accessLevel: 2 });
    expect(await client.server.health()).toBe(true);
    await client.close();
    expect(client.state).toBe("closed");
    await client.closed;
  });

  test("the default port is 27505", async () => {
    const server = new FakeServer();
    const urls: string[] = [];
    const client = await open(server, "kdoq://localhost/app", {
      transport: (url: string, init: never) => {
        urls.push(url);
        return server.factory(url, init);
      },
    });
    expect(urls).toEqual(["https://localhost:27505/native"]);
    await client.close();
  });

  test("await using closes the client", async () => {
    const server = new FakeServer();
    let kept!: Client;
    {
      await using client = await open(server);
      kept = client;
    }
    expect(kept.state).toBe("closed");
  });

  test("SCRAM exchange verifies the server signature", async () => {
    const server = new FakeServer({ auth: { user: "al", password: "secret" } });
    const client = await open(server, "kdoq://al:secret@localhost");
    expect(client.session?.id).toBe(7);
    await client.close();
  });

  test("a wrong password fails and closes the client for good", async () => {
    const server = new FakeServer({ auth: { user: "al", password: "secret" } });
    await expect(open(server, "kdoq://al:nope@localhost")).rejects.toMatchObject({ code: ErrorCode.Authentication });
  });

  test("options override the DSN, and bad configuration fails before the network", async () => {
    const server = new FakeServer();
    await expect(open(server, "kdoq://localhost", { password: "x" })).rejects.toBeInstanceOf(KdoqConfigError);
    await expect(open(server, null)).rejects.toBeInstanceOf(KdoqConfigError);
    expect(server.transports).toHaveLength(0);
    const client = await open(server, null, { host: "localhost", port: 9, database: "other" });
    expect(client.db().name).toBe("other");
    await client.close();
  });

  test("db() without a database fails", async () => {
    const client = await open(new FakeServer(), "kdoq://localhost");
    expect(() => client.db()).toThrow(KdoqConfigError);
    await client.close();
  });
});

describe("documents", () => {
  test("put and get", async () => {
    const server = new FakeServer();
    server.handler = (cmd) => {
      if (cmd.operation === 0x0402)
        return [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.bin(1, cmd.payload.bin(3)!)), encodeFrame(Kind.END)];
      return documentReply(cmd.payload.bin(3)!, { a: 1, nested: { b: [true] } });
    };
    const client = await open(server);
    const coll = client.db().collection("docs");
    const key = await coll.put("k1", { a: 1, name: "x" });
    expect(key).toBeInstanceOf(KeyBytes);
    expect(key.text()).toBe("k1");
    const put = server.commands.find((c) => c.operation === 0x0402)!;
    expect(put.payload.str(1)).toBe("app");
    expect(put.payload.str(2)).toBe("docs");
    expect(inputDocuments(put)).toEqual([{ a: 1, name: "x" }]);
    expect(await coll.get("k1")).toEqual({ a: 1, nested: { b: [true] } });
    await client.close();
  });

  test("a server ERROR becomes a KdoqError with code and outcome", async () => {
    const server = new FakeServer();
    server.handler = () => [errorFrame(ErrorCode.NotFound)];
    const client = await open(server);
    const error = await client
      .db()
      .collection("docs")
      .get("missing")
      .catch((e) => e);
    expect(error).toBeInstanceOf(KdoqError);
    expect(error).toMatchObject({ code: ErrorCode.NotFound, outcome: "NotApplied", codeName: "NotFound" });
    await client.close();
  });

  test("an operation stream that ends without END is incomplete; a write is Unknown", async () => {
    const server = new FakeServer();
    server.handler = () => "cut";
    const client = await open(server);
    const coll = client.db().collection("docs");
    await expect(coll.get("k")).rejects.toMatchObject({ constructor: KdoqIncompleteError, outcome: "NotApplied" });
    await expect(coll.put("k", {})).rejects.toMatchObject({ constructor: KdoqIncompleteError, outcome: "Unknown" });
    await client.close();
  });

  test("Overloaded is retried, other errors are not", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.handler = () =>
      ++calls < 3 ? [errorFrame(ErrorCode.Overloaded)] : [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.u8(1, 1)), encodeFrame(Kind.END)];
    const client = await open(server);
    expect(await client.server.health()).toBe(true);
    expect(calls).toBe(3);
    calls = -100;
    server.handler = () => {
      calls++;
      return [errorFrame(ErrorCode.Forbidden)];
    };
    await expect(client.server.health()).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    expect(calls).toBe(-99);
    await client.close();
  });
});

describe("mutations", () => {
  test("update sends the statement of the protocol reference", async () => {
    const server = new FakeServer();
    server.handler = () => [
      encodeFrame(Kind.BEGIN),
      frame(Kind.ITEM, enc.bin(1, new TextEncoder().encode("k")), enc.u8(2, 6)),
      encodeFrame(Kind.END),
    ];
    const client = await open(server);
    const result = await client
      .db()
      .collection("docs")
      .upsert("k", [{ set: { a: expr("1") } }]);
    expect(result.inserted).toBe(true);
    expect(result.key?.text()).toBe("k");
    const cmd = server.commands[0];
    expect(cmd.operation).toBe(0x0406);
    expect(cmd.payload.bin(3)).toEqual(new TextEncoder().encode("k"));
    expect(cmd.inputs).toHaveLength(1);
    await client.close();
  });

  test("bulk reports items; a late failure carries them", async () => {
    const server = new FakeServer();
    const items = [0, 1].map((i) => frame(Kind.ITEM, enc.u32(1, i), enc.u16(2, 0), enc.u8(3, 2)));
    server.handler = () => [encodeFrame(Kind.BEGIN), ...items, frame(Kind.END, enc.u32(1, 2))];
    const client = await open(server);
    const coll = client.db().collection("docs");
    const result = await coll.bulk(
      [
        { mode: "update", target: "a", stages: [{ unset: ["x"] }] },
        { mode: "upsert", target: { filter: "n > 1", multi: true }, stages: [{ set: { s: { nested: 1 } } }] },
      ],
      { ordered: false },
    );
    expect(result.executed).toBe(2);
    expect(result.items.map((i) => i.index)).toEqual([0, 1]);
    server.handler = () => [encodeFrame(Kind.BEGIN), items[0], errorFrame(ErrorCode.Storage, 1)];
    const failure = await coll.bulk([{ mode: "update", target: "a", stages: [{ unset: ["x"] }] }]).catch((e) => e);
    expect(failure).toBeInstanceOf(KdoqBulkError);
    expect(failure.items).toHaveLength(1);
    await client.close();
  });
});

describe("queries", () => {
  test("pruning is sent on create and count, but not on continuation", async () => {
    const server = new FakeServer();
    server.handler = (cmd) =>
      cmd.operation === 0x0502
        ? [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.u64(1, 0)), encodeFrame(Kind.END)]
        : page(9, [], cmd.operation === 0x0501 ? 9 : 0);
    const client = await open(server);
    const coll = client.db().collection("docs");
    for (const pruning of [undefined, true, false]) {
      const start = server.commands.length;
      await coll.find(undefined, undefined, { pruning }).toArray();
      await coll.count(undefined, { pruning });
      const [create, read, count] = server.commands.slice(start);
      expect(create.payload.group(5)!.u8(5)).toBe(pruning === undefined ? undefined : Number(pruning));
      expect(count.payload.group(4)!.u8(5)).toBe(pruning === undefined ? undefined : Number(pruning));
      expect(read.payload.group(2)?.has(5) ?? false).toBe(false);
    }
    await client.close();
  });

  test("auto-pagination reads every page with CURSOR_READ", async () => {
    const server = new FakeServer();
    server.handler = (cmd) => {
      if (cmd.operation === 0x0501) return page(9, [{ n: 0 }, { n: 1 }], 9);
      if (cmd.operation === 0x0503) return page(9, [{ n: 2 }], 0);
      return [encodeFrame(Kind.BEGIN), encodeFrame(Kind.END)];
    };
    const client = await open(server);
    const q = client.db().collection("docs").find("n >= 0", undefined, { pageSize: 2 });
    const values = [];
    for await (const { key, value } of q) values.push([(key as KeyBytes).text(), value]);
    expect(values).toEqual([
      ["k0", { n: 0 }],
      ["k1", { n: 1 }],
      ["k0", { n: 2 }],
    ]);
    expect(server.commands.map((c) => c.operation)).toEqual([0x0501, 0x0503]);
    expect(server.commands[0].payload.group(5)!.group(1)!.u32(1)).toBe(2);
    await client.close();
  });

  test("breaking out of a paginated find closes its cursor", async () => {
    const server = new FakeServer();
    server.handler = (cmd) =>
      cmd.operation === 0x0501 ? page(5, [{ n: 0 }, { n: 1 }], 5) : [encodeFrame(Kind.BEGIN), encodeFrame(Kind.END)];
    const client = await open(server);
    for await (const _ of client.db().collection("docs").find(undefined, undefined, { pageSize: 2 })) break;
    const close = server.commands.find((c) => c.operation === 0x0504)!;
    expect(close.payload.u64(1)).toBe(5);
    await client.close();
  });

  test("first() returns one item and closes the cursor", async () => {
    const server = new FakeServer();
    server.handler = (cmd) =>
      cmd.operation === 0x0501 ? page(5, [{ n: 0 }, { n: 1 }], 5) : [encodeFrame(Kind.BEGIN), encodeFrame(Kind.END)];
    const client = await open(server);
    const item = await client.db().collection<{ n: number }>("docs").find(undefined, undefined, { pageSize: 2 }).first();
    expect(item?.value).toEqual({ n: 0 });
    expect(server.commands.find((c) => c.operation === 0x0504)!.payload.u64(1)).toBe(5);
    await client.close();
  });

  test("manual mode returns a cursor with explicit pages", async () => {
    const server = new FakeServer();
    server.handler = (cmd) => {
      if (cmd.operation === 0x0501) return [frame(Kind.BEGIN, enc.u64(1, 4), enc.u64(2, 4)), frame(Kind.END, enc.u64(1, 4))];
      if (cmd.operation === 0x0503) return page(4, [{ n: 1 }], 0);
      return [encodeFrame(Kind.BEGIN), encodeFrame(Kind.END)];
    };
    const client = await open(server);
    const cursor = await client.db().collection("docs").find("true", undefined, { paginate: "manual", pageSize: 10 });
    expect(cursor.id).toBe(4);
    expect(server.commands[0].payload.group(5)!.group(1)!.u32(1)).toBe(0);
    const { items, done } = await cursor.next();
    expect(items.map((i) => i.value)).toEqual([{ n: 1 }]);
    expect(done).toBe(true);
    await cursor.close();
    await client.close();
  });

  test("count and pipeline encoding", async () => {
    const server = new FakeServer();
    server.handler = (cmd) =>
      cmd.operation === 0x0502 ? [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.u64(1, 42)), encodeFrame(Kind.END)] : page(0, [], 0);
    const client = await open(server);
    const coll = client.db().collection("docs");
    expect(await coll.count("a > 1")).toBe(42);
    await coll
      .find("a", [{ project: "{a}" }, { match: "a > 1" }, { reduce: { key: "k", initial: "0", accumulate: "$acc+1" } }, { count: true }])
      .toArray();
    const pipeline = server.commands[1].payload.group(4)!;
    expect(pipeline.all(1)).toHaveLength(1);
    expect(pipeline.has(2) && pipeline.has(3) && pipeline.has(4)).toBe(true);
    await client.close();
  });
});

describe("connection loss", () => {
  test("a loss ends the call explicitly, the next call reconnects lazily", async () => {
    const server = new FakeServer();
    server.handler = (cmd, s) => {
      if (cmd.operation === 0x0402) {
        s.transports.at(-1)!.drop();
        return "hang";
      }
      return [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.u8(1, 1)), encodeFrame(Kind.END)];
    };
    const client = await open(server);
    const states: string[] = [];
    client.on("state", (s) => states.push(s));
    const failure = await client
      .db()
      .collection("c")
      .put("k", {})
      .catch((e) => e);
    expect(failure).toBeInstanceOf(KdoqError);
    expect(failure.outcome).toBe("Unknown");
    expect(client.state).toBe("disconnected");
    expect(server.transports).toHaveLength(1);
    expect(await client.server.health()).toBe(true);
    expect(server.transports).toHaveLength(2);
    expect(states).toEqual(["disconnected", "connected"]);
    await client.close();
  });

  test("reconnect: false keeps the client disconnected", async () => {
    const server = new FakeServer();
    server.handler = () => [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.u8(1, 1)), encodeFrame(Kind.END)];
    const client = await open(server, "kdoq://localhost", { reconnect: false });
    server.transports[0].drop();
    await new Promise((r) => setTimeout(r, 5));
    await expect(client.server.health()).rejects.toBeInstanceOf(KdoqConnectionError);
    expect(server.transports).toHaveLength(1);
  });

  test("a revoked session closes the client for good", async () => {
    const server = new FakeServer();
    const client = await open(server);
    server.transports[0].drop(8);
    await expect(client.closed).rejects.toMatchObject({ code: ErrorCode.Revoked });
    expect(client.state).toBe("closed");
    await expect(client.server.health()).rejects.toMatchObject({ code: ErrorCode.Revoked });
    expect(server.transports).toHaveLength(1);
  });

  test("concurrent operations share one reconnect", async () => {
    const server = new FakeServer();
    server.handler = () => [encodeFrame(Kind.BEGIN), frame(Kind.ITEM, enc.u8(1, 1)), encodeFrame(Kind.END)];
    const client = await open(server);
    server.transports[0].drop();
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([client.server.health(), client.server.health(), client.server.health()]);
    expect(server.transports).toHaveLength(2);
    await client.close();
  });
});

export type { Client };

describe("errors and cursors", () => {
  test("hasCode matches a server error by code", async () => {
    const server = new FakeServer();
    server.handler = () => [errorFrame(ErrorCode.NotFound)];
    const client = await open(server);
    const error = await client
      .db()
      .collection("docs")
      .get("k")
      .catch((e) => e);
    expect(KdoqError.hasCode(error, ErrorCode.NotFound)).toBe(true);
    expect(KdoqError.hasCode(error, ErrorCode.Conflict)).toBe(false);
    expect(KdoqError.hasCode(new Error("x"), ErrorCode.NotFound)).toBe(false);
    await client.close();
  });

  test("attachCursor continues a cursor by id", async () => {
    const server = new FakeServer();
    server.handler = (cmd) => (cmd.operation === 0x0503 ? page(9, [{ n: 5 }], 0) : [encodeFrame(Kind.BEGIN), encodeFrame(Kind.END)]);
    const client = await open(server);
    const result = await client.attachCursor(9).next();
    expect(result.done).toBe(true);
    expect(result.items).toHaveLength(1);
    await client.close();
  });
});
