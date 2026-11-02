import { KdoqConfigError } from "./errors.js";

export interface ParsedDsn {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
}

const DSN = /^kdoq:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]+\]|[^:/?#@]+)(?::(\d+))?(?:\/([^?#]*))?$/;

const decode = (s: string | undefined, what: string): string | undefined => {
  if (!s) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    throw new KdoqConfigError(`invalid percent-encoding in the DSN ${what}`);
  }
};

/** Parses `kdoq://[username[:password]@]<host>[:port][/database]`. */
export function parseDsn(dsn: string): ParsedDsn {
  const m = DSN.exec(dsn);
  if (!m) throw new KdoqConfigError("invalid DSN: expected kdoq://[username[:password]@]<host>[:port][/database]");
  const port = m[4] === undefined ? undefined : Number(m[4]);
  if (port !== undefined && !(port >= 1 && port <= 65535)) throw new KdoqConfigError("invalid DSN port");
  return {
    host: decode(m[3], "host")!,
    port,
    username: decode(m[1], "username"),
    password: decode(m[2], "password"),
    database: decode(m[5], "database"),
  };
}
