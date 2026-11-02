import { invalidDocument } from "../errors.js";
import { encodeDocument, NameDictionary, type Doc, type Value } from "./codec.js";
import { enc, frame, Kind } from "./wire.js";
import type { Operand } from "../expr.js";
import type { Stage, Target } from "../types.js";

export { expr, type Operand } from "../expr.js";
export type { BulkStatement, Stage, Target } from "../types.js";

const isOperand = (v: unknown): v is Operand =>
  typeof v === "object" && v !== null && Object.keys(v).length === 1 && typeof (v as Operand).expression === "string";

/** The dictionary context shared by every INPUT_VALUE of one operation stream. */
export const CONTEXT = 1;

const path = (p: string | string[]): string[] => {
  const parts = Array.isArray(p) ? p : p.split(".");
  if (parts.length === 0 || parts.some((c) => c === "")) throw invalidDocument(`invalid field path ${JSON.stringify(p)}`);
  return parts;
};
const pathGroup = (id: number, p: string[]) => enc.group(id, ...p.map((c) => enc.str(1, c)));

/** A DICTIONARY frame for the names added to `dict` since the last call; none when there are no new names. */
export function dictionaryFrames(dict: NameDictionary): Uint8Array[] {
  const entries = dict.drain();
  if (!entries.length) return [];
  return [frame(Kind.DICTIONARY, enc.u64(1, CONTEXT), ...entries.map(([id, name]) => enc.group(2, enc.u32(1, id), enc.str(2, name))))];
}

export const isFilter = (t: Target): t is { filter: string; multi?: boolean } => typeof t === "object" && !(t instanceof Uint8Array);

/** Builds the DICTIONARY and INPUT_VALUE frames of one statement. `extra` carries key and mode (bulk). */
export function encodeStatement(
  dict: NameDictionary,
  stages: Stage[],
  target: Target,
  extra: { key?: Uint8Array; mode?: number } = {},
): Uint8Array[] {
  const pool: Value[] = [];
  const operand = (v: Operand | Value): Uint8Array => {
    if (isOperand(v)) return enc.str(2, v.expression);
    pool.push(v);
    return enc.u32(1, pool.length - 1);
  };
  const encoded = stages.map((stage) => {
    if ("set" in stage) {
      const pairs = Array.isArray(stage.set) ? stage.set : Object.entries(stage.set);
      return enc.group(1, ...pairs.map(([p, v]) => enc.group(1, pathGroup(1, path(p)), enc.group(2, operand(v)))));
    }
    if ("unset" in stage) return enc.group(2, ...stage.unset.map((p) => pathGroup(1, path(p))));
    return enc.group(3, enc.group(1, operand(stage.replace as Operand | Value)));
  });
  let poolField: Uint8Array[] = [];
  if (pool.length) {
    const object: Doc = {};
    pool.forEach((v, i) => {
      object[String(i)] = v;
    });
    poolField = [enc.group(1, enc.u64(1, CONTEXT), enc.bin(2, encodeDocument(object, dict)))];
  }
  const fields = [
    ...poolField,
    enc.group(2, ...encoded),
    ...(extra.key ? [enc.bin(3, extra.key)] : []),
    ...(extra.mode !== undefined ? [enc.u16(4, extra.mode)] : []),
    ...(isFilter(target) ? [enc.str(5, target.filter), ...(target.multi ? [enc.u8(6, 1)] : [])] : []),
  ];
  return [...dictionaryFrames(dict), frame(Kind.INPUT_VALUE, ...fields)];
}

/** DICTIONARY and INPUT_VALUE frames for a stored document. */
export function encodeDocumentInput(doc: Doc): Uint8Array[] {
  const dict = new NameDictionary();
  const bytes = encodeDocument(doc, dict);
  return [...dictionaryFrames(dict), frame(Kind.INPUT_VALUE, enc.u64(1, CONTEXT), enc.bin(2, bytes))];
}
