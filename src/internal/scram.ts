import { KdoqError, ErrorCode } from "../errors.js";
import { utf8 } from "./wire.js";

const subtle = globalThis.crypto.subtle;

/** The Web Crypto typings accept only non-shared buffers. */
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, buf(data)));
}

const sha256 = async (data: Uint8Array) => new Uint8Array(await subtle.digest("SHA-256", buf(data)));

async function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", buf(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, k, 256));
}

const authFailure = (message: string) => new KdoqError(message, { code: ErrorCode.Authentication });

const attributes = (message: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of message.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
};

/** SCRAM-SHA-256 client without channel binding (`n,,`), as the native AUTH exchange uses it. */
export class ScramClient {
  private readonly bare: string;
  private expectedServerSignature?: string;

  constructor(
    username: string,
    private readonly password: string,
    private readonly nonce: string = randomNonce(),
  ) {
    this.bare = `n=${username.replace(/=/g, "=3D").replace(/,/g, "=2C")},r=${this.nonce}`;
  }

  first(): string {
    return `n,,${this.bare}`;
  }

  async final(serverFirst: string): Promise<string> {
    const a = attributes(serverFirst);
    const nonce = a.get("r"),
      salt = a.get("s"),
      iterations = Number(a.get("i"));
    if (!nonce?.startsWith(this.nonce) || !salt || !Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) {
      throw authFailure("invalid server-first message");
    }
    const withoutProof = `c=biws,r=${nonce}`;
    const authMessage = utf8(`${this.bare},${serverFirst},${withoutProof}`);
    const salted = await pbkdf2(utf8(this.password), fromBase64(salt), iterations);
    const clientKey = await hmac(salted, utf8("Client Key"));
    const signature = await hmac(await sha256(clientKey), authMessage);
    const proof = clientKey.map((b, i) => b ^ signature[i]);
    this.expectedServerSignature = toBase64(await hmac(await hmac(salted, utf8("Server Key")), authMessage));
    return `${withoutProof},p=${toBase64(proof)}`;
  }

  /** Verifies the server proof; READY must not be trusted before this passes. */
  verify(serverFinal: string): void {
    if (attributes(serverFinal).get("v") !== this.expectedServerSignature) throw authFailure("server signature mismatch");
  }
}

function randomNonce(): string {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(18)));
}
