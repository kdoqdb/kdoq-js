import { expect, test } from "bun:test";
import { connect } from "../src";
import type { Runner } from "../src/internal/runner";
import { encodeFrame, Kind } from "../src/internal/wire";
import { FakeServer } from "./fake";

test("AbortSignal still cancels an operation after BEGIN", async () => {
  const server = new FakeServer();
  server.handler = () => [encodeFrame(Kind.BEGIN)];
  const client = await connect("kdoq://localhost/app", { transport: server.factory });
  const abort = new AbortController();
  const stream = await (client as unknown as Runner).open({ operation: 0x0505 }, { signal: abort.signal });
  abort.abort(new Error("cancel active query"));
  const stopped = stream.done;
  await client.close();
  expect(stopped).toBe(true);
});

test("query.cancel interrupts opening before BEGIN", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: (stream: import("../src/internal/operation").OperationStream) => void;
  let signal: AbortSignal | undefined;
  const runner = {
    open: (_spec, options) => {
      signal = options?.signal;
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    unary: () => {
      throw new Error("unexpected unary call");
    },
  } satisfies Runner;
  const { QueryImpl } = await import("../src/query");
  const query = new QueryImpl(runner, "app", "items", [], {}, false);
  const pending = query[Symbol.asyncIterator]().next();
  await started;
  await query.cancel();
  const stopped = signal?.aborted;
  release({ cancel: async () => {} } as import("../src/internal/operation").OperationStream);
  await pending;
  expect(stopped).toBe(true);
});

test("protocol CANCEL does not wait for read cancellation to settle", async () => {
  const { OperationStream } = await import("../src/internal/operation");
  let finishRead!: () => void;
  const readClosed = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const requests: number[] = [];
  const operation = OperationStream.start(
    {
      alive: true,
      cancel: async (id) => {
        requests.push(id);
      },
    },
    {
      readable: new ReadableStream({ cancel: () => readClosed }),
      writable: new WritableStream(),
    },
    1 << 20,
    42,
    { operation: 0x0505 },
  );
  const pending = operation.cancel();
  const sent = [...requests];
  finishRead();
  await pending;
  expect(sent).toEqual([42]);
});
