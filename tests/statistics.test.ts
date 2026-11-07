import { expect, test } from "bun:test";
import { Cursor } from "../src/query.js";
import { Fields } from "../src/internal/wire.js";

// Independent wire fixture: required statistics groups with zero counters.
const counters = (id: number, count: number) => [
  0x80 | id,
  count * 10,
  ...Array.from({ length: count }, (_, i) => [0x81 + i, 8, 0, 0, 0, 0, 0, 0, 0, 0]).flat(),
];
const statistics = [...counters(1, 3), ...counters(2, 4), ...counters(3, 3), ...counters(4, 2)];

async function page(duration: number[] = []) {
  const stats = [...statistics, ...duration];
  // CURSOR_READ END: cursor 0, then the skippable statistics group (id 2).
  const end = new Fields(Uint8Array.from([0x81, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, stats.length | 0x80, 1, ...stats]));
  const runner = {
    async open() {
      let sent = false;
      return {
        async next() {
          if (sent) return null;
          sent = true;
          return { kind: "end", fields: end };
        },
      };
    },
  } as unknown as ConstructorParameters<typeof Cursor>[0];
  return new Cursor(runner, 1).next();
}

test("native cursor exposes page handling time with zero budget usage", async () => {
  // Field 6 (R=0), u64 1234 microseconds.
  const result = await page([0x06, 8, 0xd2, 0x04, 0, 0, 0, 0, 0, 0]);
  expect(result.done).toBe(true);
  expect(result.statistics?.budgetUsed.activeNs).toBe(0);
  expect(result.statistics?.durationUs).toBe(1234);
});

test("native page duration keeps zero and large integers", async () => {
  expect((await page([0x06, 8, 0, 0, 0, 0, 0, 0, 0, 0])).statistics?.durationUs).toBe(0);
  expect((await page([0x06, 8, 1, 0, 0, 0, 0, 0, 0x20, 0])).statistics?.durationUs).toBe(9007199254740993n);
});

test("older native statistics remain readable without a duration", async () => {
  const result = await page();
  expect(result.statistics).toBeDefined();
  expect(result.statistics?.durationUs).toBeUndefined();
});
