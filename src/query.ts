import { ErrorCode, KdoqError, malformed } from "./errors.js";
import type { OperationStream, OpSpec } from "./internal/operation.js";
import { GroupKey, KeyBytes, type Value } from "./internal/codec.js";
import { enc, type Fields } from "./internal/wire.js";
import type { Runner } from "./internal/runner.js";
import type { Budget, Cursor as CursorApi, FindOptions, Item, PipelineStage, Query, QueryOptions, Statistics, N } from "./types.js";

export type {
  Budget,
  CountOptions,
  Diagnostic,
  FindOptions,
  Item,
  PipelineStage,
  Progress,
  Query,
  QueryOptions,
  Statistics,
} from "./types.js";

export const DEFAULT_PAGE_SIZE = 1000;

const stageFields = (s: PipelineStage): Uint8Array => {
  if ("project" in s) return enc.str(1, s.project);
  if ("reduce" in s) return enc.group(2, enc.str(1, s.reduce.key), enc.str(2, s.reduce.initial), enc.str(3, s.reduce.accumulate));
  if ("count" in s) return enc.group(3);
  return enc.str(4, s.match);
};

export const encodePipeline = (stages: PipelineStage[] | undefined): Uint8Array[] =>
  stages?.length ? [enc.group(4, ...stages.map(stageFields))] : [];

const optional = (fields: Array<Uint8Array | undefined>): Uint8Array[] => fields.filter((f): f is Uint8Array => f !== undefined);
const u64 = (id: number, v: number | undefined) => (v === undefined ? undefined : enc.u64(id, v));

function budgetGroup(b: Budget | undefined): Uint8Array[] {
  if (!b) return [];
  const fields = optional([
    u64(1, b.memoryBytes),
    u64(2, b.admissionWaitMs),
    u64(3, b.memoryWaitMs),
    u64(4, b.steps),
    u64(5, b.expressionBytes),
    u64(6, b.activeMs),
  ]);
  return fields.length ? [enc.group(4, ...fields)] : [];
}

function observeGroup(o: QueryOptions): Uint8Array {
  return enc.group(
    3,
    enc.bool(1, o.observe?.progress ?? !!o.onProgress),
    enc.bool(2, o.observe?.diagnostics ?? !!o.onDiagnostic),
    enc.bool(3, o.observe?.statistics ?? false),
  );
}

export function createSpec(
  db: string,
  coll: string,
  filter: string | undefined,
  pipeline: PipelineStage[] | undefined,
  o: FindOptions,
  pageSize: number | undefined,
): OpSpec {
  const page =
    pageSize === undefined && o.idleTtl === undefined
      ? []
      : [enc.group(1, ...optional([pageSize === undefined ? undefined : enc.u32(1, pageSize), u64(2, o.idleTtl)]))];
  const window =
    o.window && (o.window.skip !== undefined || o.window.limit !== undefined)
      ? [enc.group(2, ...optional([u64(1, o.window.skip), u64(2, o.window.limit)]))]
      : [];
  return {
    operation: 0x0501,
    payload: new Uint8Array([
      ...enc.str(1, db),
      ...enc.str(2, coll),
      ...(filter === undefined ? [] : enc.str(3, filter)),
      ...encodePipeline(pipeline).flatMap((f) => [...f]),
      ...enc.group(
        5,
        ...page,
        ...window,
        observeGroup(o),
        ...budgetGroup(o.budget),
        ...(o.pruning === undefined ? [] : [enc.bool(5, o.pruning)]),
      ),
    ]),
  };
}

export const readSpec = (cursorId: number | bigint, size: number | undefined): OpSpec => ({
  operation: 0x0503,
  payload: new Uint8Array([...enc.u64(1, cursorId), ...(size === undefined ? [] : enc.group(2, enc.group(1, enc.u32(1, size))))]),
});

export const closeSpec = (cursorId: number | bigint): OpSpec => ({ operation: 0x0504, payload: enc.u64(1, cursorId) });

export function parseItem(stream: OperationStream, f: Fields): Item {
  const context = f.need(f.u64(2), 2);
  const value = stream.decode(context, f.need(f.bin(3), 3));
  const k = f.group(1);
  if (!k) return { value };
  const bytes = k.need(k.bin(2), 2);
  const kind = k.need(k.u16(1), 1);
  if (kind === 1) return { key: KeyBytes.copyOf(bytes), value };
  if (kind === 2) return { key: new GroupKey(stream.decode(context, bytes)), value };
  throw malformed(`unknown item key kind ${kind}`);
}

export function parseStatistics(g: Fields): Statistics {
  const n = (grp: Fields, id: number): N => grp.need(grp.u64(id), id);
  const group = (id: number) => g.need(g.group(id), id);
  const s = group(1),
    d = group(2),
    b = group(3),
    m = group(4),
    r = g.group(5);
  return {
    source: { total: n(s, 1), processed: n(s, 2), bloomCandidates: n(s, 3) },
    documents: { processed: n(d, 1), selected: n(d, 2), rejected: n(d, 3), filterErrors: n(d, 4) },
    budgetUsed: { steps: n(b, 1), valueBytes: n(b, 2), activeNs: n(b, 3) },
    memory: { currentBytes: n(m, 1), peakBytes: n(m, 2) },
    ...(r ? { reduction: { accumulatedDocuments: n(r, 1), groupsCreated: n(r, 2) } } : {}),
  };
}

function observe(o: QueryOptions, kind: "progress" | "diagnostic", f: Fields): void {
  if (kind === "progress") o.onProgress?.({ processed: f.need(f.u64(1), 1), total: f.need(f.u64(2), 2) });
  else {
    const span = f.need(f.group(3), 3);
    o.onDiagnostic?.({
      expression: f.need(f.str(1), 1),
      stage: f.u64(2),
      span: { start: span.need(span.u64(1), 1), end: span.need(span.u64(2), 2) },
      reason: f.need(f.str(4), 4),
    });
  }
}

/** Reads one response (page or whole result) and reports its end. */
async function* readResponse(stream: OperationStream, o: QueryOptions, onEnd: (end: Fields) => void): AsyncGenerator<Item> {
  for (;;) {
    const e = await stream.next();
    if (!e) return;
    if (e.kind === "item") yield parseItem(stream, e.fields);
    else if (e.kind === "progress" || e.kind === "diagnostic") observe(o, e.kind, e.fields);
    else if (e.kind === "end") {
      onEnd(e.fields);
      return;
    }
  }
}

export type PaginateMode = boolean | "manual";

/** `find` with `paginate: true` (pages read transparently) or `false` (one stream). */
export class QueryImpl implements Query {
  cursorId: number | bigint | null = null;
  readonly statistics: Promise<Statistics | undefined>;
  private resolveStats!: (s: Statistics | undefined) => void;
  private started = false;
  private cancelled = false;
  private current?: OperationStream;

  constructor(
    private readonly runner: Runner,
    private readonly db: string,
    private readonly coll: string,
    private readonly filter: string | undefined,
    private readonly pipeline: PipelineStage[] | undefined,
    private readonly options: FindOptions,
    private readonly paginate: boolean,
  ) {
    this.statistics = new Promise((resolve) => {
      this.resolveStats = resolve;
    });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.current?.cancel();
  }

  async *values(): AsyncGenerator<Value> {
    for await (const item of this) yield item.value;
  }

  async first(): Promise<Item | undefined> {
    for await (const item of this) return item;
    return undefined;
  }

  async toArray(): Promise<Item[]> {
    const out: Item[] = [];
    for await (const item of this) out.push(item);
    return out;
  }

  [Symbol.asyncIterator](): AsyncGenerator<Item> {
    if (this.started) throw new KdoqError("a query can be iterated only once", { code: ErrorCode.Malformed });
    this.started = true;
    return this.run();
  }

  private async *run(): AsyncGenerator<Item> {
    const o = this.options;
    const size = this.paginate ? Math.min(o.pageSize ?? DEFAULT_PAGE_SIZE, 10000) : undefined;
    let completed = false;
    try {
      let spec = createSpec(this.db, this.coll, this.filter, this.pipeline, o, size);
      for (;;) {
        const stream = (this.current = await this.runner.open(spec, o));
        if (this.cancelled) {
          await stream.cancel();
          return;
        }
        const begin = stream.begin;
        const id = begin?.u64(1);
        if (id) this.cursorId = id;
        let next: number | bigint = 0;
        for await (const item of readResponse(stream, o, (end) => {
          next = end.u64(1) ?? 0;
          const stats = end.group(2);
          if (stats) this.resolveStats(parseStatistics(stats));
        })) {
          yield item;
          if (this.cancelled) return;
        }
        if (this.cancelled) return;
        this.cursorId = next || null;
        if (!next) {
          completed = true;
          return;
        }
        spec = readSpec(next, size);
      }
    } finally {
      this.resolveStats(undefined);
      if (!completed && this.cursorId) {
        const id = this.cursorId;
        this.cursorId = null;
        await this.current?.cancel().catch(() => {});
        await this.runner.unary(closeSpec(id), { timeout: 5000 }).catch(() => {});
      }
    }
  }
}

/** A cursor read page by page. */
export class Cursor implements CursorApi {
  private open = true;

  constructor(
    private readonly runner: Runner,
    readonly id: number | bigint,
    private readonly pageSize = DEFAULT_PAGE_SIZE,
  ) {}

  /** Continues a cursor of the same identity, for example one created on another connection. */
  static attach(runner: Runner, id: number | bigint): Cursor {
    return new Cursor(runner, id);
  }

  async next(
    options: { size?: number; signal?: AbortSignal } & Pick<QueryOptions, "onProgress" | "onDiagnostic"> = {},
  ): Promise<{ items: Item[]; done: boolean; statistics?: Statistics }> {
    if (!this.open) return { items: [], done: true };
    const stream = await this.runner.open(readSpec(this.id, Math.min(options.size ?? this.pageSize, 10000)), options);
    const items: Item[] = [];
    let next: number | bigint = 0;
    let statistics: Statistics | undefined;
    for await (const item of readResponse(stream, options, (end) => {
      next = end.u64(1) ?? 0;
      const stats = end.group(2);
      if (stats) statistics = parseStatistics(stats);
    }))
      items.push(item);
    if (!next) this.open = false;
    return { items, done: !next, ...(statistics ? { statistics } : {}) };
  }

  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    await this.runner.unary(closeSpec(this.id));
  }
}
