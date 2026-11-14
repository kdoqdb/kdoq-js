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

test("dashboard aggregatePage abort logs cancellation and closes its cursor", async () => {
  const { frame, enc } = await import("../src/internal/wire");
  const server = new FakeServer();
  server.handler = (command) =>
    command.operation === 0x0504
      ? [encodeFrame(Kind.BEGIN), encodeFrame(Kind.END)]
      : [frame(Kind.BEGIN, enc.u64(1, 123)), frame(Kind.PROGRESS, enc.u64(1, 1), enc.u64(2, 64)), encodeFrame(Kind.END)];
  const logs: string[] = [];
  const client = await connect("kdoq://localhost/app", { transport: server.factory, trace: (line) => logs.push(line) });
  const controller = new AbortController();
  const reason = new Error("Stop query button");
  await expect(
    client
      .db()
      .collection("items")
      .aggregatePage([{ match: "product.value = 'some'" }], {
        signal: controller.signal,
        onProgress: () => controller.abort(reason),
      }),
  ).rejects.toBe(reason);
  expect(logs.some((line) => line.includes("cancelled by the client"))).toBe(true);
  expect(server.commands.some((command) => command.operation === 0x0504)).toBe(true);
  await client.close();
});

test("aggregatePage abort before BEGIN logs cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("Stop before BEGIN");
  const server = new FakeServer();
  server.handler = () => {
    controller.abort(reason);
    return "hang";
  };
  const logs: string[] = [];
  const client = await connect("kdoq://localhost/app", { transport: server.factory, trace: (line) => logs.push(line) });
  await expect(
    client
      .db()
      .collection("items")
      .aggregatePage([{ match: "product.value = 'some'" }], { signal: controller.signal }),
  ).rejects.toBe(reason);
  expect(logs.some((line) => line.includes("cancelled by the client"))).toBe(true);
  await client.close();
});
