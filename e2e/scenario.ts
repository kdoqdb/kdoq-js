// The end-to-end scenario against a real kdoq process. `browser.ts` runs it in Chrome (started by
// run.py) and `run-bun.ts` in Bun with a WebTransport polyfill; `bun test` does not run it.
import { connect, ErrorCode, expr, KdoqError, type Client, type TransportFactory } from "../src";
import { format, KeyBytes } from "../src/value";

export interface Config {
  host: string;
  port: number;
  hash: string;
  username: string;
  password: string;
  origin?: string;
  /** A scenario needs a database that does not exist yet; a second run on one server names another. */
  database?: string;
}

const steps: string[] = [];
const check = (ok: unknown, what: string) => {
  if (!ok) throw new Error(`check failed: ${what}`);
  steps.push(what);
};
const eq = (actual: unknown, expected: unknown, what: string) =>
  check(
    JSON.stringify(actual, (_, v) => (typeof v === "bigint" ? `${v}n` : v)) ===
      JSON.stringify(expected, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
    `${what}: ${format(actual as never, { indent: 0 })}`,
  );

async function scenario(c: Config, transport?: TransportFactory) {
  const database = c.database ?? "Web";
  const dsn = `kdoq://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${database}`;
  const client: Client = await connect(dsn, { certificateHash: c.hash, transport });
  check(client.state === "connected" && client.session?.accessLevel === 3, "connect with SCRAM and READY");
  check(await client.server.health(), "server health");
  const caps = await client.server.capabilities();
  check(caps.operations.includes(0x0407) && caps.encoding === 4, "server capabilities");

  await client.databases.create(database);
  const db = client.db();
  await db.collections.create("Docs");
  const docs = db.collection("Docs");
  check(
    (await db.collections.list()).some((x) => x.name === "Docs" && x.state === "loaded"),
    "namespace lifecycle",
  );

  const original = {
    n: 1,
    name: "héllo",
    nested: { list: [1, 2.5, "x", null, true], when: new Date(Date.UTC(2026, 10, 1)) },
    big: 2n ** 62n,
  };
  const key = await docs.put("k1", original);
  check(key.text() === "k1", "put returns the key");
  const got = await docs.get("k1");
  eq(got, original, "get returns the stored document");
  const generated = await docs.insert({ n: 2 });
  check(generated.length > 0, "insert generates a key");
  await docs.insert({ n: 3 }, { key: "k3" });
  const dup = await docs.insert({ n: 3 }, { key: "k3" }).catch((e) => e);
  check(
    dup instanceof KdoqError && dup.code === ErrorCode.AlreadyExists && dup.outcome === "NotApplied",
    "insert of a live key fails with AlreadyExists",
  );
  const missing = await docs.get("nobody").catch((e) => e);
  check(missing instanceof KdoqError && missing.code === ErrorCode.NotFound, "get of a missing key fails with NotFound");

  const updated = await docs.update("k1", [{ set: { y: expr("n + 1"), "nested.extra": "lit" } }, { unset: ["name"] }]);
  check(updated.key?.text() === "k1" && !updated.inserted, "update by key");
  eq(
    await docs.get("k1").then((d) => ({ y: d.y, extra: (d.nested as { extra: string }).extra, name: d.name })),
    { y: 2, extra: "lit" },
    "update result",
  );
  const upserted = await docs.upsert("k9", [{ set: { n: 9 } }]);
  check(upserted.inserted, "upsert inserts");
  const multi = await docs.update({ filter: "n >= 3", multi: true }, [{ set: { tag: "t" } }]);
  eq([multi.matched, multi.modified], [2, 2], "filter update with multi");

  const bulk = await docs.bulk(
    [
      { mode: "upsert", target: "b1", stages: [{ set: { n: 10 } }] },
      { mode: "upsert", target: "b2", stages: [{ set: { n: 11 } }] },
      { mode: "update", target: { filter: "n == 10" }, stages: [{ set: { n: 100 } }] },
    ],
    { ordered: true },
  );
  check(bulk.executed === 3 && bulk.items.length === 3 && bulk.items.every((i) => i.status === null), "bulk");

  const total = await docs.count();
  check(total === 6, `count ${total}`);
  check((await docs.count("n >= 10")) === 2, "count with filter");

  const all = await docs.find().toArray();
  check(all.length === 6 && all.every((i) => i.key instanceof KeyBytes), "find streams every document with keys");
  const paged = [];
  for await (const item of docs.find("n >= 0", undefined, { pageSize: 2 })) paged.push(item);
  check(paged.length === 6, "auto-pagination over several pages");
  const q = docs.find("n >= 0", undefined, { pageSize: 2 });
  let taken = 0;
  for await (const _ of q) {
    if (++taken === 3) break;
  }
  check(taken === 3, "break out of a paginated find");
  const whole = await docs.find("n >= 0", undefined, { paginate: false }).toArray();
  check(whole.length === 6, "unpaginated find");
  const cursor = await docs.find("n >= 0", undefined, { paginate: "manual", pageSize: 4 });
  const first = await cursor.next();
  const second = await cursor.next();
  eq([first.items.length, second.items.length, second.done], [4, 2, true], "manual cursor pages");
  await cursor.close();

  const grouped = await docs.find<number>("true", [{ count: true }]).first();
  check(grouped?.value === 6, "count stage");
  const projected = await docs.find("n == 1", [{ project: "{n: n, twice: n * 2}" }]).toArray();
  eq(
    projected.map((i) => i.value),
    [{ n: 1, twice: 2 }],
    "projection stage",
  );
  const stats = docs.find("n == 1", undefined, { observe: { statistics: true } });
  await stats.toArray();
  check((await stats.statistics)?.documents.selected === 1, "statistics");

  // Unwind steps: one flat filter about one element of each array, rows that keep the document key.
  await db.collections.create("Orders");
  const orders = db.collection("Orders");
  const tag = (color: string, size: string) => ({ color, size });
  await orders.put("o1", {
    items: [
      { sku: "pen", qty: 150 },
      { sku: "ink", qty: 50 },
    ],
    tags: [tag("red", "s"), tag("blue", "m")],
  });
  await orders.put("o2", { items: [{ sku: "pen", qty: 50 }], tags: [tag("red", "s")] });
  await orders.put("o3", {
    items: [
      { sku: "pen", qty: 200 },
      { sku: "pen", qty: 300 },
    ],
    tags: [tag("red", "m"), tag("red", "s")],
  });
  await orders.put("o4", { items: "pen", tags: [] });
  const flat = "items.sku == 'pen' and items.qty > 100 and tags.color == 'red'";
  type Unwound = { items: { sku: string; qty: number }; tags: { color: string; size: string } };
  const matched = await orders
    .find<Unwound>(flat, [{ project: "{items: items, tags: tags}" }], {
      unwind: [
        { path: "items", mode: "any" },
        { path: "tags", mode: "any" },
      ],
    })
    .toArray();
  eq(
    matched.map((i) => [(i.key as KeyBytes).text(), i.value.items.qty, i.value.tags.size]),
    [
      ["o1", 150, "s"],
      ["o3", 200, "m"],
    ],
    "unwind with mode any returns the first matched element of each array",
  );
  const unwound = [{ path: "items" }, { path: "tags" }];
  const rows = await orders.find<Unwound>(flat, undefined, { unwind: unwound }).toArray();
  eq(
    rows.map((i) => [(i.key as KeyBytes).text(), i.value.items.qty, i.value.tags.size]),
    [
      ["o1", 150, "s"],
      ["o3", 200, "m"],
      ["o3", 200, "s"],
      ["o3", 300, "m"],
      ["o3", 300, "s"],
    ],
    "unwind with the default mode all returns every combination, keyed by its document",
  );
  eq(await orders.count(flat, { unwind: unwound }), 5, "count counts the rows of all steps");
  eq(
    await orders.count(flat, {
      unwind: [
        { path: "items", mode: "any" },
        { path: "tags", mode: "any" },
      ],
    }),
    2,
    "count with mode any",
  );
  const source = await orders.find("items.sku == 'pen'", undefined, { unwind: [{ path: "items", emit: "source" }] }).toArray();
  eq(
    source.map((i) => [(i.key as KeyBytes).text(), (i.value.items as unknown[]).length]),
    [
      ["o1", 2],
      ["o2", 1],
      ["o3", 2],
    ],
    "emit source returns each document once with its array",
  );
  eq(
    await orders.count("items == 'pen'", { unwind: [{ path: "items", nonArray: "single" }] }),
    1,
    "nonArray single treats a value that is not an array as one element",
  );
  const refused = await orders.count(undefined, { unwind: [{ path: "items", mode: "all", emit: "source" }] }).catch((e) => e);
  check(refused instanceof KdoqError && refused.code === ErrorCode.InvalidDocument, "mode all with emit source is rejected by the server");
  const [report] = await orders.find(flat, undefined, { explain: "plan", unwind: unwound }).toArray();
  check(
    JSON.stringify(report.value, (_, v) => (typeof v === "bigint" ? `${v}n` : v)).includes('"unwind"'),
    "explain plan lists the unwind steps",
  );

  const sessions = await client.sessions.list();
  check(
    sessions.some((s) => s.id === client.session!.id),
    "session list includes this session",
  );
  await docs.walSync();
  await docs.checkpoint();
  check((await docs.delete("k9")).text() === "k9", "delete");
  check((await docs.get("k9").catch((e) => e)).code === ErrorCode.NotFound, "deleted document is gone");

  const states: string[] = [];
  client.on("state", (s) => states.push(s));
  await client.close();
  check(client.state === "closed" && states.at(-1) === "closed", "logout closes the client");

  const wrong = await connect(dsn.replace(c.password, "wrong"), { certificateHash: c.hash, transport }).catch((e) => e);
  check(wrong instanceof KdoqError && wrong.code === ErrorCode.Authentication, "bad password is an Authentication error");
}

export async function runScenario(config: Config, transport?: TransportFactory): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  try {
    await scenario(config, transport);
    return { ok: true, steps };
  } catch (e) {
    return { ok: false, steps, error: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e) };
  }
}
