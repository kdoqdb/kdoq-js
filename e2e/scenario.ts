// The end-to-end scenario against a real kdoq process. `browser.ts` runs it in Chrome (started by
// run.py) and `run-bun.ts` in Bun with a WebTransport polyfill; `bun test` does not run it.
import { connect, ErrorCode, expr, KdoqError, type Client, type PipelineStage, type TransportFactory } from "../src";
import { format, KeyBytes, GroupKey } from "../src/value";

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
  const explicit = await connect(dsn.replace("kdoq://", "kdoq+wt://"), { certificateHash: c.hash, transport });
  check(await explicit.server.health(), "explicit WebTransport scheme with shared trust");
  await explicit.close();
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

  const total = (await docs.aggregate<number>([{ count: true }]).first())?.value;
  check(total === 6, `count ${total}`);
  check((await docs.aggregate<number>([{ match: "n >= 10" }, { count: true }]).first())?.value === 2, "count with filter");

  const all = await docs.aggregate([]).toArray();
  check(all.length === 6 && all.every((i) => i.key instanceof KeyBytes), "aggregate streams every document with keys");
  const paged = [];
  for await (const item of docs.aggregate([{ match: "n >= 0" }], { pageSize: 2 })) paged.push(item);
  check(paged.length === 6, "auto-pagination over several pages");
  const q = docs.aggregate([{ match: "n >= 0" }], { pageSize: 2 });
  let taken = 0;
  for await (const _ of q) {
    if (++taken === 3) break;
  }
  check(taken === 3, "break out of a paginated aggregate");
  const whole = await docs.aggregate([{ match: "n >= 0" }], { paginate: false }).toArray();
  check(whole.length === 6, "unpaginated aggregate");
  const cursor = await docs.aggregate([{ match: "n >= 0" }], { paginate: "manual", pageSize: 4 });
  const first = await cursor.next();
  const second = await cursor.next();
  eq([first.items.length, second.items.length, second.done], [4, 2, true], "manual cursor pages");
  await cursor.close();
  const firstPage = await docs.aggregatePage([{ match: "n >= 0" }], { pageSize: 4 });
  check(firstPage.items.length === 4 && !firstPage.done && firstPage.cursor !== null, "aggregatePage first page");
  const lastPage = await firstPage.cursor!.next();
  eq([lastPage.items.length, lastPage.done], [2, true], "aggregatePage continuation");
  check((await docs.aggregatePage([{ match: "n >= 0" }], { pageSize: 10 })).cursor === null, "aggregatePage last page has no cursor");

  const grouped = await docs.aggregate<number>([{ count: true }]).first();
  check(grouped?.value === 6, "count stage");
  const projected = await docs.aggregate([{ match: "n == 1" }, { project: "{n: n, twice: n * 2}" }]).toArray();
  eq(
    projected.map((i) => i.value),
    [{ n: 1, twice: 2 }],
    "projection stage",
  );
  const reduced = await docs
    .aggregate<number>([{ reduce: { key: "'all'", initial: "0", accumulate: "$prev + 1", onError: "skipGroup" } }])
    .first();
  check(reduced?.key instanceof GroupKey && reduced.key.value === "all" && reduced.value === 6, "reduction with onError and a group key");
  const stats = docs.aggregate([{ match: "n == 1" }], { observe: { statistics: true } });
  check((await stats.toArray()).length === 1, "observed aggregate returns matching rows");
  const statistics = await stats.statistics;
  check(statistics?.durationUs !== undefined && statistics.memory !== undefined, "aggregate statistics include duration and memory");

  // Ordered unwind stages retain document keys and emit every combination.
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
  const unwound: PipelineStage[] = [{ unwind: { path: "items" } }, { unwind: { path: "tags" } }];
  const rows = await orders.aggregate<Unwound>([...unwound, { match: flat }]).toArray();
  eq(
    rows.map((i) => [(i.key as KeyBytes).text(), i.value.items.qty, i.value.tags.size]),
    [
      ["o1", 150, "s"],
      ["o3", 200, "m"],
      ["o3", 200, "s"],
      ["o3", 300, "m"],
      ["o3", 300, "s"],
    ],
    "unwind returns every combination, keyed by its document",
  );
  const counted = await orders.aggregate<number>([...unwound, { match: flat }, { count: true }]).first();
  eq(counted?.value, 5, "count counts every unwound row");
  check(counted?.key === undefined, "count returns an unkeyed item");
  const empty = await orders.aggregate<number>([{ match: "false" }, { count: true }]).first();
  eq(empty?.value, 0, "count returns zero for empty input");
  const scalar = await orders
    .aggregate<number>([{ unwind: { path: "items", nonArray: "single" } }, { match: "items == 'pen'" }, { count: true }])
    .first();
  eq(scalar?.value, 1, "nonArray single treats a scalar as one element");
  const projectedRows = await orders
    .aggregate([{ project: "{lines: items}" }, { unwind: { path: "lines" } }, { match: "lines.qty > 100" }, { count: true }])
    .first();
  eq(projectedRows?.value, 3, "unwind runs after projection on the current item");
  for (const explain of ["plan", "analyze"] as const) {
    const reports = await orders.aggregate([{ count: true }], { explain }).toArray();
    check(reports.length === 1 && reports[0].key === undefined, `aggregate explain ${explain} returns one unkeyed report`);
  }
  const unsupportedExplain = await orders
    .aggregate([...unwound, { match: flat }], { explain: "plan" })
    .toArray()
    .catch((e) => e);
  check(KdoqError.hasCode(unsupportedExplain, ErrorCode.InvalidDocument), "explain rejects unsupported aggregate pipeline shapes");

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
