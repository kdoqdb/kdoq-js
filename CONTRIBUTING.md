# Contributing

The library has no runtime dependencies. Development uses [Bun](https://bun.sh) for tests and
scripts, TypeScript for types and the build, and Biome for lint and formatting.

```sh
bun install
bun run lint        # Biome (use `bunx biome check --write .` to fix)
bun run typecheck   # tsc --noEmit
bun test tests      # unit tests against an in-memory fake server
bun run build       # emits dist/ with declarations
```

## Layout

- `src/index.ts`, `src/value/index.ts`: the two public entry points (`@kdoq/kdoq`, `@kdoq/kdoq/value`).
- `src/internal/`: frames, SCRAM, operation streams, the binary document codec. Not exported
  through `package.json` `exports`.
- `testdata/api.txt`: the exported identifiers of both entry points. `tests/api.test.ts` compares
  them, so growing the public surface shows up in a diff. After an intended change run
  `UPDATE_API=1 bun test tests/api.test.ts` and commit the file.

Relative imports in `src/` end in `.js` so the emitted modules run in Node and Deno unchanged.

## Wire contract

The protocol is specified in the kdoq repository (`docs/reference/proto/`). The reference bytes in
the tests are copied from its protocol tests; a change to them needs the same change there.
After a change to the protocol or to a native operation, run the end-to-end suite against a real
`kdoq` build (it needs OpenSSL; `KDOQ_BIN` names the binary):

```sh
KDOQ_BIN=/path/to/kdoq bun run test:e2e           # Bun, then Node
KDOQ_BIN=/path/to/kdoq bun run test:e2e:browser   # headless Chrome (KDOQ_BROWSER overrides its path)
```

Neither Bun nor Node has `WebTransport`, so the first suite passes
[`@fails-components/webtransport`](https://www.npmjs.com/package/@fails-components/webtransport)
through the `transport` option. It is a development dependency only; the library never imports it.
Its install script downloads a prebuilt native binary from the project's GitHub releases and
otherwise builds it from source, which takes more than 20 minutes; Bun runs it because the package
is listed in `trustedDependencies`. CI does not run the suites, since they need a `kdoq` binary.
