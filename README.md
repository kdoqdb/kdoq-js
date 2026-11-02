# kdoq-js

[![CI](https://github.com/kdoqdb/kdoq-js/actions/workflows/ci.yml/badge.svg)](https://github.com/kdoqdb/kdoq-js/actions/workflows/ci.yml)

A JavaScript and TypeScript client for [kdoq](https://github.com/kdoqdb/kdoq), a document database. It
gives you typed collections, queries you iterate with `for await`, server-side cursors, online
mutations and database administration, all over one authenticated session of the native protocol
(WebTransport).

```ts
import { connect } from "@kdoq/kdoq";

await using client = await connect("kdoq://ann@db.example.com/shop", { password: process.env.KDOQ_PASSWORD });
const accounts = client.db().collection<{ name: string; age: number }>("accounts");

await accounts.put("u1", { name: "Ann", age: 31 });

for await (const { key, value } of accounts.find("age >= 30")) {
  console.log(key, value.name);
}
```

- **Typed documents.** `collection<T>()` types what you read and write; values come back as plain
  JavaScript values, with classes for the types JavaScript lacks.
- **Queries as async iterables.** `find` returns a lazy query. Pages are fetched as you read, and
  leaving the loop cancels the query and closes its cursor on the server.
- **Mutations on the server.** Change documents with ordered stages instead of reading, modifying
  and writing back.
- **Safe by default.** The server's identity is verified, a lost connection is never retried
  silently for a write, and every operation has a time limit.
- **No dependencies, ESM only.** The package ships its own types and uses `WebTransport`,
  `AbortSignal` and Web Crypto only.

The package is a pre-1.0 release (`0.x`): the API can still change between minor versions.

## Installation

```sh
npm install @kdoq/kdoq
```

The package has two entry points: `@kdoq/kdoq` (the client) and `@kdoq/kdoq/value` (document value
classes and `format`, usable without a connection).

### Runtimes

The client uses the global `WebTransport`, so it runs where that exists: current browsers (Chrome,
Firefox, Safari) and Deno. **Bun and Node do not provide `WebTransport`.** There, pass an
implementation through the `transport` option, a function `(url, init) => TransportLike` where
`TransportLike` is the small subset of `WebTransport` the client needs (`ready`, `closed`,
`createBidirectionalStream()`, `close()`).

```ts
import { connect } from "@kdoq/kdoq";
import { WebTransport, quicheLoaded } from "@fails-components/webtransport"; // your choice, not a dependency of kdoq

await quicheLoaded;
const client = await connect("kdoq://ann@db.example.com/shop", {
  password: process.env.KDOQ_PASSWORD,
  transport: (url, init) => new WebTransport(url, init),
});
```

The test suite runs the whole scenario against a real server in both Bun and Node with
[`@fails-components/webtransport`](https://www.npmjs.com/package/@fails-components/webtransport); the
library does not depend on it.

## Quick start

```ts
import { connect, ErrorCode, KdoqError } from "@kdoq/kdoq";

type Account = { name: string; age: number };

await using client = await connect("kdoq://ann@db.example.com/shop", {
  password: process.env.KDOQ_PASSWORD,
  timeout: 10_000,
});
const accounts = client.db().collection<Account>("accounts");

await accounts.put("u1", { name: "Ann", age: 31 });

try {
  const ann = await accounts.get("u1");
  console.log(ann.name, ann.age); // Ann 31
} catch (error) {
  if (!KdoqError.hasCode(error, ErrorCode.NotFound)) throw error;
  console.log("no such account");
}
```

Use a `type` alias, not an `interface`, for the document type: `collection<T>` needs `T` to be
assignable to `Doc`, and interfaces have no implicit index signature.

## Connecting

`connect(dsn, options)` takes a connection string and resolves once the server has accepted the
session.

```
kdoq://[user[:password]@]host[:port][/database]
```

| Part | Meaning |
| --- | --- |
| `user` | Selects SCRAM-SHA-256 authentication. Without a user the session is anonymous. |
| `password` | The user's password. Prefer the `password` option so it stays out of the string. |
| `port` | The server's port. When omitted the client uses 27505. |
| `database` | The default database for `client.db()`. |

Options override any part of the connection string (`host`, `port`, `username`, `password`,
`database`), so `connect(null, { host, ... })` works without a string.

```ts
const client = await connect("kdoq://ann@db.example.com/shop", {
  password: process.env.KDOQ_PASSWORD,
  connectTimeout: 5_000, // transport setup and authentication; 10 s by default
  timeout: 20_000, // every operation; 30 s by default
  signal: controller.signal, // closes the client when it aborts
});
```

A mistake in the configuration, such as a password without a user, fails at once with a
`KdoqConfigError` and never touches the network. With SCRAM the client also checks the server's
final signature before it trusts the session.

### TLS

By default the server certificate is verified against the system trust store. A self-signed
certificate is accepted only by pinning its hash with `certificateHash` (the SHA-256 of the DER
leaf certificate, as bytes or hex). There is no way to turn verification off. Browsers accept a
pinned certificate only if it is valid for at most 14 days.

### Connection lifecycle

The client reconnects on the next operation after a connection is lost, and concurrent operations
share one attempt. A failed authentication, or a session revoked by an administrator, closes the
client for good.

```ts
const stop = client.on("state", (state, reason) => {
  console.log("kdoq:", state, reason); // "connected" | "disconnected" | "closed"
});

await client.closed.catch((error) => console.error(error)); // settles when the client is closed for good
stop();
```

`client.state` and `client.session` (`{ id, accessLevel }`, or `null` while disconnected) show the
current state. Set `reconnect: false` to keep a lost connection lost. `await client.close()`, or
`await using`, ends the session.

## Documents

Opening a database or a collection never touches the network, so handles are cheap.

```ts
const db = client.db("shop");
const accounts = db.collection<Account>("accounts");

await accounts.put("u1", { name: "Ann", age: 31 }); // create or replace
const ann = await accounts.get("u1");
const key = await accounts.insert({ name: "Bob", age: 40 }); // the server generates the key
await accounts.delete(key);

const events = db.collection("events"); // documents of any shape (`Doc`)
```

`collection<T>()` is a type hint: documents are not validated against `T` at run time.

### Keys

A key is a `string` (stored as UTF-8) or a `Uint8Array`. The keys the server returns are
`KeyBytes`, a `Uint8Array` with a `text()` method that gives the string when the bytes are valid
UTF-8 and `null` otherwise. `insert` accepts `{ key }` to choose the key instead of generating one;
it fails with `ErrorCode.AlreadyExists` if the key is live.

### Durability

`put`, `insert`, `delete` and the mutations accept `durability`. A write is durable when
acknowledged unless you trade that for speed:

```ts
await accounts.put("u1", ann, { durability: "relaxed" });
```

## Values

Document values map to JavaScript like this. The classes come from `@kdoq/kdoq/value`.

| Document type | JavaScript |
| --- | --- |
| string, boolean, null, array, document | the same |
| double | `number` |
| int32, int64 | `number` when it is a safe integer, otherwise `bigint` |
| datetime | `Date` |
| decimal128 | `Decimal128` (exact text, no arithmetic) |
| calendar date | `KqDate` |
| timestamp | `Timestamp` |
| ObjectId | `ObjectId` (12 bytes) |
| binary, code, regular expression | `Binary` (subtype and bytes), `Code`, `KqRegExp` |
| MinKey, MaxKey | `MinKey`, `MaxKey` |

On write, an integral `number` is stored as int32 when it fits and as int64 otherwise, any other
`number` as a double, and a `bigint` as int64. To store a specific type, wrap the value:
`new Int32(1)`, `new Int64(1)`, `new Double(1)`.

`@kdoq/kdoq/value` has no network code, so you can build, convert and print values without a
connection. `format(value)` prints any value as readable text.

### Limitations

- On read the original integer width is not visible, and an int64 is a `number` when it is safe and
  a `bigint` when it is not. A field can therefore come back as either, depending on its magnitude.
- `Decimal128` carries the exact value but has no arithmetic; convert with `toString()`.
- `collection<T>()` does not check documents against `T`.
- Bun and Node need a `WebTransport` implementation (see [Runtimes](#runtimes)).

## Queries

`find` takes a filter and returns a query you iterate with `for await`. The query is lazy: it runs
on the first iteration, and it can be iterated once.

```ts
for await (const { key, value } of accounts.find("age >= 30", undefined, { pageSize: 100 })) {
  console.log(key, value.name);
  if (enough()) break; // cancels the query and closes its cursor
}
```

| Method | Result |
| --- | --- |
| `for await (const { key, value } of query)` | Items one at a time; pages are fetched as you read. |
| `query.values()` | An async iterable of the values only. |
| `await query.toArray()` | Every item. |
| `await query.first()` | The first item, or `undefined`; the rest of the query is cancelled. |
| `query.cursorId` | The server cursor, once the query has started. |
| `await query.statistics` | Execution statistics, when requested (see below). |
| `await query.cancel()` | Stops the query from another place. |

`await accounts.count("age >= 30")` counts matching documents; without a filter it counts them all.

### Options

`find` and `count` take `pruning`, `budget` and the observers; `find` also takes `pageSize`,
`idleTtl` and `window`.

```ts
const query = accounts.find("age >= 30", undefined, {
  window: { skip: 20, limit: 10 },
  pruning: false, // Bloom pruning is on unless you turn it off
  budget: { memoryBytes: 64 << 20, activeMs: 2_000 },
  observe: { statistics: true },
  onProgress: ({ processed, total }) => console.log(processed, total),
});
const page = await query.toArray();
console.log((await query.statistics)?.documents.selected);
```

### Aggregation

A pipeline that changes the shape of the result goes in the second argument; the type parameter
names the result.

```ts
import { GroupKey } from "@kdoq/kdoq/value";

const byCountry = [{ reduce: { key: "country", initial: "0", accumulate: "$prev + 1" } }];
for await (const item of accounts.find<number>(undefined, byCountry)) {
  console.log(item.key instanceof GroupKey ? item.key.value : item.key, item.value); // the grouping key and the count
}
```

The stages are `project`, `match`, `reduce` and `count`.

### Cursors

A cursor is advanced by hand, for example behind a "load more" button. `find` with
`paginate: "manual"` resolves to one, and `client.attachCursor(id)` continues a cursor from another
connection of the same identity, so a stateless service can page across requests.

```ts
const cursor = await accounts.find("age >= 30", undefined, { paginate: "manual", pageSize: 50 });
try {
  for (;;) {
    const page = await cursor.next();
    for (const item of page.items) console.log(item.key);
    if (page.done) break;
  }
} finally {
  await cursor.close();
}
```

## Mutations

Change documents on the server with ordered stages instead of reading, modifying and writing back.
A statement addresses one document by key, or the documents matching a filter with
`{ filter, multi }`.

```ts
import { expr } from "@kdoq/kdoq";

const result = await accounts.update("u1", [{ set: { age: expr("age + 1") } }, { unset: ["email"] }]);

// Every matching account, not only the first.
await accounts.update({ filter: "age < 18", multi: true }, [{ set: { minor: true } }]);

const created = await accounts.upsert("u2", [{ set: { name: "Cy" } }]); // created.inserted
```

The stages are `set`, `unset` and `replace`. `expr` makes a value an expression of the query language
instead of a literal. A `MutationResult` reports `matched`, `modified`, `inserted` and the document
`key`.

`bulk` applies many statements in one call, ordered or unordered, with a result for each. A failure
after some statements were accepted is a `KdoqBulkError` that carries the results received so far.

```ts
const { items } = await accounts.bulk(
  [
    { mode: "update", target: "u1", stages: [{ set: { vip: true } }] },
    { mode: "upsert", target: "u9", stages: [{ set: { name: "Di" } }] },
  ],
  { ordered: false },
);
```

## Errors

A failure reported by the server is a `KdoqError` with a numeric `code` (`ErrorCode.NotFound`,
`AlreadyExists`, `Forbidden`, `Overloaded`, `Conflict`, ...) and an `outcome` that says whether the
operation was **not applied** (`"NotApplied"`) or its **outcome is unknown** (`"Unknown"`). Match a
code with `KdoqError.hasCode(error, code)`, which is what `errors.Is` with a sentinel is in the Go
client. `KdoqConfigError`, `KdoqConnectionError`, `KdoqIncompleteError`, `KdoqTimeoutError` and
`KdoqBulkError` have their own classes, and all of them extend `KdoqError`.

```ts
try {
  await accounts.insert(ann, { key: "u1" });
} catch (error) {
  if (KdoqError.hasCode(error, ErrorCode.AlreadyExists)) {
    // pick another key
  } else if (error instanceof KdoqError && error.outcome === "Unknown") {
    // the write may or may not have happened; check before retrying
  } else {
    throw error;
  }
}
```

### Time limits, cancellation and retries

- Every operation takes a last argument of options with `signal?: AbortSignal` and
  `timeout?: number` (milliseconds). Without them the client's `timeout` applies. Aborting a signal
  rejects the operation with the signal's reason and cancels it on the server.
- A time limit is a `KdoqTimeoutError`; for a write it carries `outcome: "Unknown"`, because the
  server may have applied it.
- Operations rejected as `Overloaded` or `AdmissionTimeout` were not applied and are retried with
  backoff, three attempts by default. Tune this with `retry: { attempts, backoff }` or turn it off
  with `retry: false`.
- A write interrupted by a lost connection is **never** retried. The library cannot know whether the
  write was applied, so that decision stays with you; the next operation reconnects.

## Administration

| Call | Purpose |
| --- | --- |
| `client.databases` | `list`, `get`, `create`, `load` and `unload` databases. |
| `db.collections` | `list`, `get`, `create`, `load` and `unload` collections. |
| `collection.info`, `create()`, `load()`, `unload()` | Manage one collection. |
| `collection.walSync()`, `collection.checkpoint()` | Control persistence. |
| `client.sessions` | `list`, `get` and `revoke` sessions. |
| `client.server` | `health()` and `capabilities()`. |

An operation that the identity's access level does not allow fails with `ErrorCode.Forbidden`.

## Testing your code

`Client`, `Database` and `Collection` are interfaces, so you can mock the part you use. The library's
own tests run the client against an in-memory fake server through the `transport` option; see
[tests/fake.ts](tests/fake.ts).

## Documentation

- Every public type carries TSDoc comments, which your editor shows.
- A runnable example: [examples/quickstart.ts](examples/quickstart.ts).
- The wire contract the library implements is the native protocol reference in the
  [kdoq repository](https://github.com/kdoqdb/kdoq).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
