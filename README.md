# kdoq-js

A JavaScript client for [kdoq](https://github.com/kdoqdb/kdoq), a document database. It speaks the
native protocol over WebTransport and gives you collections, lazy queries you iterate with
`for await`, server-side cursors, online mutations and database administration, all over one
authenticated session.

```ts
import { connect } from "@kdoq/kdoq";

await using client = await connect("kdoq://user:pass@localhost:27505/app");
const accounts = client.db().collection<{ name: string; age: number }>("accounts");

await accounts.put("u1", { name: "Ann", age: 31 });

for await (const { key, value } of accounts.find("age >= 30")) {
  console.log(key, value.name);
}
```

- **Queries are lazy async iterables.** Pages are fetched as you read, and leaving the loop
  (`break`, `return`, a thrown error) cancels the query and closes its cursor on the server.
- **Mutations on the server.** Change documents with ordered stages instead of reading,
  modifying and writing back.
- **Safe by default.** The server's identity is verified, a write interrupted by a lost
  connection is never retried, and every operation has a time limit.
- **No dependencies.** The library uses `WebTransport`, `fetch`-style `AbortSignal` and Web
  Crypto only.

## Installation

```sh
npm install @kdoq/kdoq
```

The package is ESM-only and ships its own types. It has two entry points: `@kdoq/kdoq` (the client) and
`@kdoq/kdoq/value` (document values and `format`, usable without a connection).

## Runtimes

The client uses the global `WebTransport`, so it runs where that exists: current browsers
(Chrome, Firefox, Safari) and Deno. **Bun and Node do not provide `WebTransport`.** There, pass an
implementation through the `transport` option, a function `(url, init) => TransportLike` where
`TransportLike` is the small subset of `WebTransport` the client needs (`ready`, `closed`,
`createBidirectionalStream()`, `close()`).

```ts
import { connect } from "@kdoq/kdoq";
import { WebTransport, quicheLoaded } from "@fails-components/webtransport"; // your choice, not a dependency of kdoq

await quicheLoaded;
const client = await connect("kdoq://user:pass@localhost:27505/app", {
  transport: (url, init) => new WebTransport(url, init),
});
```

The test suite runs the whole scenario against a real server in both Bun and Node with
[`@fails-components/webtransport`](https://www.npmjs.com/package/@fails-components/webtransport); the
library does not depend on it.

## Connecting

`connect(dsn, options)` takes `kdoq://[user[:password]@]host[:port][/database]`; the port defaults
to 27505. Options override the DSN.

| Option | Meaning |
| --- | --- |
| `certificateHash` | SHA-256 of the server's leaf certificate (bytes or hex) for a self-signed development server. There is no way to skip verification. |
| `timeout` | Default time limit of an operation in milliseconds (30000). |
| `connectTimeout` | Time limit of connecting. |
| `signal` | An `AbortSignal` that closes the client when it aborts. |
| `retry` | `false`, or `{ attempts, backoff }` for the retries below. |
| `reconnect` | `false` to stop reconnecting after a lost connection. |
| `transport` | A `WebTransport` replacement, see [Runtimes](#runtimes). |

Every operation accepts a last argument of options with `signal?: AbortSignal` and
`timeout?: number` (milliseconds). A time limit surfaces as `KdoqTimeoutError`; for a write it
carries `outcome: "Unknown"`, because the server may have applied it.

`await using client = await connect(...)` or `await client.close()` ends the session.

## Errors

Server errors are `KdoqError` with a numeric `code` (see `ErrorCode`) and an `outcome` that says
whether a failed write may have been applied. Subclasses mark the origin: `KdoqConfigError`
(before any network use), `KdoqConnectionError`, `KdoqIncompleteError`, `KdoqTimeoutError` and
`KdoqBulkError`. Test them with `instanceof` and `KdoqError.hasCode(error, ErrorCode.NotFound)`, which is what
`errors.Is` with a sentinel is in the Go client.

## Retries

An operation the server rejects as `Overloaded` or `AdmissionTimeout` was not applied and is
retried with backoff (3 attempts by default; `retry: false` turns it off). A write is never
replayed after the connection was lost: the operation in flight fails with the error and its
`outcome`, and unless `reconnect: false` the next operation connects again.

## Values and limitations

`@kdoq/kdoq/value` maps the document types of the protocol to JavaScript:

| Document type | JavaScript |
| --- | --- |
| string, boolean, null, arrays, documents | the same |
| double | `number` (`new Double(1)` to store an integral value as a double) |
| int32 / int64 | `number` when it is a safe integer, otherwise `bigint` |
| datetime | `Date` |
| decimal128 | `Decimal128` (exact text, no arithmetic) |
| calendar date | `KqDate` |
| binary, ObjectId, timestamp, regular expression, code, MinKey, MaxKey | classes of the same names |

Limitations to know about:

- Types are chosen by value on write: an integral `number` is stored as int32 when it fits and
  as int64 otherwise, any other `number` as a double, and a `bigint` as int64. To store a
  specific type, wrap the value: `new Int32(1)`, `new Int64(1)`, `new Double(1)` (from
  `@kdoq/kdoq/value`). On read the original integer width is not visible, and an int64 is a `number`
  when it is safe and a `bigint` when it is not.
- `collection<T>()` is a type hint. Documents are not validated against `T` at run time.
- `Decimal128` carries the exact value but has no arithmetic; convert with `toString()`.
- Bun and Node need a `WebTransport` implementation (see [Runtimes](#runtimes)).
- Browsers accept a self-signed certificate only through `certificateHash`, and only for
  certificates valid for at most 14 days.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
