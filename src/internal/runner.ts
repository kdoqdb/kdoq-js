import type { OperationStream, OpSpec } from "./operation.js";
import type { Fields } from "./wire.js";
import type { OpOptions } from "../types.js";

export type { OpOptions };

export interface Unary {
  stream: OperationStream;
  begin: Fields;
  items: Fields[];
  end: Fields;
}

/** What handles need from the client: start an operation, with lazy connect and retries. */
export interface Runner {
  /** Starts an operation and resolves once its BEGIN arrived. Only the establishing phase is time-limited. */
  open(spec: OpSpec, options?: OpOptions): Promise<OperationStream>;
  /** Runs an operation to its END, collecting items. */
  unary(spec: OpSpec, options?: OpOptions): Promise<Unary>;
}

export const RUNNER = Symbol("kdoq.runner");
