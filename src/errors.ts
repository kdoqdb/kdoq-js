export const ErrorCode = {
  Malformed: 1,
  Incompatible: 2,
  Authentication: 3,
  NotReady: 4,
  Unsupported: 5,
  NotFound: 6,
  Overloaded: 7,
  Revoked: 8,
  InvalidDocument: 9,
  LimitExceeded: 10,
  AlreadyExists: 11,
  Unavailable: 12,
  Conflict: 13,
  Cancelled: 14,
  Storage: 15,
  WrongCase: 16,
  Unloaded: 17,
  CursorInUse: 18,
  CursorExpired: 19,
  AdmissionTimeout: 20,
  WouldWait: 21,
  MemoryWaitTimeout: 22,
  ExecutionMemoryLimit: 23,
  QueryQueueFull: 24,
  SendStalled: 25,
  Forbidden: 26,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const AccessLevel = { Connect: 0, Read: 1, Write: 2, Admin: 3 } as const;
export type AccessLevel = 0 | 1 | 2 | 3;

export type Outcome = "NotApplied" | "Unknown";

const names = new Map<number, string>(Object.entries(ErrorCode).map(([name, code]) => [code, name]));
export const errorName = (code: number): string => names.get(code) ?? `Code${code}`;

export interface ErrorInit {
  code?: number | null;
  outcome?: Outcome;
  requestId?: bigint | number;
  cause?: unknown;
}

export class KdoqError extends Error {
  readonly code: number | null;
  outcome: Outcome;
  readonly requestId?: bigint | number;

  constructor(message: string, init: ErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code ?? null;
    this.outcome = init.outcome ?? "NotApplied";
    this.requestId = init.requestId;
  }

  /** Whether `error` is a server error with the given code; the counterpart of `errors.Is` with a sentinel in Go. */
  static hasCode(error: unknown, code: ErrorCode): error is KdoqError {
    return error instanceof KdoqError && error.code === code;
  }

  /** The symbolic name of `code`, when this is a server error. */
  get codeName(): string | null {
    return this.code === null ? null : errorName(this.code);
  }
}

/** Bad DSN or options, raised before any network activity. */
export class KdoqConfigError extends KdoqError {}
/** The connection could not be made, or was lost. */
export class KdoqConnectionError extends KdoqError {}
/** A stream ended or was reset without END or ERROR. */
export class KdoqIncompleteError extends KdoqError {
  resetCode?: number;
}
/** The operation exceeded its time limit. */
export class KdoqTimeoutError extends KdoqError {}
/** A bulk command failed after some statements were already reported. */
export class KdoqBulkError extends KdoqError {
  items: unknown[] = [];
}

export const malformed = (message: string): KdoqError => new KdoqError(message, { code: ErrorCode.Malformed });
export const invalidDocument = (message: string): KdoqError => new KdoqError(message, { code: ErrorCode.InvalidDocument });
