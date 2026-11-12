/** One line of the protocol trace; `scope` names the connection or operation, `message` what happened. */
export type Trace = (scope: string, message: string) => void;

const NAMES: Record<number, string> = {
  1: "SERVER_HEALTH",
  2: "SERVER_CAPABILITIES",
  257: "SESSION_LIST",
  258: "SESSION_GET",
  259: "SESSION_REVOKE",
  513: "DATABASE_LIST",
  514: "DATABASE_GET",
  515: "DATABASE_CREATE",
  516: "DATABASE_LOAD",
  517: "DATABASE_UNLOAD",
  769: "COLLECTION_LIST",
  770: "COLLECTION_GET",
  771: "COLLECTION_CREATE",
  772: "COLLECTION_LOAD",
  773: "COLLECTION_UNLOAD",
  1025: "DOCUMENT_GET",
  1026: "DOCUMENT_PUT",
  1027: "DOCUMENT_INSERT",
  1028: "DOCUMENT_DELETE",
  1029: "DOCUMENT_UPDATE",
  1030: "DOCUMENT_UPSERT",
  1031: "DOCUMENT_BULK",
  1281: "QUERY_CREATE",
  1283: "CURSOR_READ",
  1284: "CURSOR_CLOSE",
  1285: "AGGREGATE",
  1537: "WAL_SYNC",
  1538: "CHECKPOINT",
};

export const opName = (code: number): string => `${NAMES[code] ?? "OP"}(0x${code.toString(16).padStart(4, "0")})`;

export const ms = (since: number): string => `${(performance.now() - since).toFixed(1)}ms`;

/**
 * The trace sink for the `trace` connect option: `true` prints with `console.log`, a function receives each
 * line. Lines carry operation codes, request ids, frame kinds, sizes and timings only, never document or
 * result values, keys, expressions or credentials.
 */
export function makeTrace(option: boolean | ((line: string) => void) | undefined): Trace | undefined {
  if (!option) return undefined;
  const sink = typeof option === "function" ? option : (line: string) => console.log(line);
  return (scope, message) => sink(`[kdoq ${performance.now().toFixed(1)}ms] ${scope} ${message}`);
}
