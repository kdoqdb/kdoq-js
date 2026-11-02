import type { TransportFactory, TransportLike } from "../src/internal/connection";
import { decodeValue, encodeDocument, NameDictionary, type Doc } from "../src/internal/codec";
import { enc, Fields, frame, FrameReader, Kind, encodeFrame, utf8 } from "../src/internal/wire";
import { dictionaryFrames } from "../src/internal/mutations";

const subtle = globalThis.crypto.subtle;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hmac = async (k: Uint8Array, d: Uint8Array) =>
  new Uint8Array(
    await subtle.sign(
      "HMAC",
      await subtle.importKey("raw", k as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      d as Uint8Array<ArrayBuffer>,
    ),
  );

export interface Command {
  operation: number;
  requestId: number;
  payload: Fields;
  inputs: Array<{ kind: number; fields: Fields }>;
}

/** A response is the frames to send, or `"hang"` (leave the stream open) or `"cut"` (end without END). */
export type Reply = Uint8Array[] | "hang" | "cut";
export type Handler = (cmd: Command, server: FakeServer) => Reply | Promise<Reply>;

export interface FakeOptions {
  auth?: { user: string; password: string };
  accessLevel?: number;
}

/** An in-memory native server speaking the wire format, for client tests. */
export class FakeServer {
  transports: FakeTransport[] = [];
  commands: Command[] = [];
  cancels: number[] = [];
  handler: Handler = () => [encodeFrame(Kind.BEGIN), encodeFrame(Kind.END)];

  constructor(readonly options: FakeOptions = {}) {}

  factory: TransportFactory = () => {
    const t = new FakeTransport(this);
    this.transports.push(t);
    return t;
  };
}

class FakeTransport implements TransportLike {
  readonly ready = Promise.resolve();
  readonly closed: Promise<unknown>;
  private resolveClosed!: (v: unknown) => void;
  private streams = 0;
  private failures: Array<(e: unknown) => void> = [];
  isClosed = false;

  constructor(private readonly server: FakeServer) {
    this.closed = new Promise((r) => {
      this.resolveClosed = r;
    });
  }

  async createBidirectionalStream() {
    const c2s = new TransformStream<Uint8Array, Uint8Array>();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const s2c = {
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          controller.enqueue(chunk);
        },
        close() {
          try {
            controller.close();
          } catch {
            /* already errored */
          }
        },
      }),
    };
    this.failures.push((e) => {
      try {
        controller.error(e);
      } catch {
        /* already closed */
      }
    });
    const first = this.streams++ === 0;
    void (first ? this.control(c2s.readable, s2c.writable) : this.operation(c2s.readable, s2c.writable));
    return { readable: s2c.readable, writable: c2s.writable };
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.resolveClosed({ closeCode: 0 });
  }

  /** Simulates the server dropping the connection. */
  drop(closeCode = 0) {
    this.isClosed = true;
    for (const fail of this.failures) fail(new Error("connection lost"));
    this.resolveClosed({ closeCode });
  }

  private async control(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>) {
    const reader = new FrameReader(readable, 1 << 20);
    const writer = writable.getWriter();
    const { auth, accessLevel = 3 } = this.server.options;
    const hello = await reader.read();
    const f = new Fields(hello!.payload);
    await writer.write(
      frame(
        Kind.HELLO,
        enc.u32(1, 1),
        enc.u16(2, 4),
        enc.u64(3, (Number(f.u64(4)) | Number(f.u64(5))) & 0x1d),
        enc.u16(4, auth ? 1 : 0),
        enc.u64(5, 1 << 20),
      ),
    );
    if (auth) {
      const first = new Fields((await reader.read())!.payload).str(1)!;
      const bare = first.slice(3);
      const clientNonce = bare.split(",r=")[1];
      const salt = utf8("0123456789abcdef");
      const serverFirst = `r=${clientNonce}srvnonce,s=${b64(salt)},i=4096`;
      await writer.write(frame(Kind.AUTH, enc.str(1, serverFirst)));
      const clientFinal = new Fields((await reader.read())!.payload).str(1)!;
      const withoutProof = clientFinal.slice(0, clientFinal.indexOf(",p="));
      const key = await subtle.importKey("raw", utf8(auth.password) as Uint8Array<ArrayBuffer>, "PBKDF2", false, ["deriveBits"]);
      const salted = new Uint8Array(
        await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations: 4096 }, key, 256),
      );
      const message = utf8(`${bare},${serverFirst},${withoutProof}`);
      const clientKey = await hmac(salted, utf8("Client Key"));
      const stored = new Uint8Array(await subtle.digest("SHA-256", clientKey));
      const signature = await hmac(stored, message);
      const proof = unb64(clientFinal.slice(clientFinal.indexOf(",p=") + 3));
      const recovered = proof.map((x, i) => x ^ signature[i]);
      const ok = b64(recovered) === b64(clientKey) && bare.startsWith(`n=${auth.user},`);
      if (!ok) {
        await writer.write(frame(Kind.ERROR, enc.u64(1, 0), enc.u16(2, 3)));
        this.drop(0);
        return;
      }
      const serverSig = await hmac(await hmac(salted, utf8("Server Key")), message);
      await writer.write(frame(Kind.AUTH, enc.str(1, `v=${b64(serverSig)}`)));
    }
    await writer.write(frame(Kind.READY, enc.u64(1, 7), enc.u8(2, accessLevel)));
    for (;;) {
      const m = await reader.read();
      if (!m) return;
      const body = new Fields(m.payload);
      if (m.kind === Kind.CANCEL) {
        this.server.cancels.push(Number(body.u64(2)));
        await writer.write(frame(Kind.CONTROL_ACK, enc.u64(1, body.u64(1)!), enc.u16(2, Kind.CANCEL), enc.u8(3, 1)));
      } else if (m.kind === Kind.LOGOUT) {
        await writer.write(frame(Kind.CONTROL_ACK, enc.u64(1, body.u64(1)!), enc.u16(2, Kind.LOGOUT)));
        this.close();
        return;
      }
    }
  }

  private async operation(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>) {
    const reader = new FrameReader(readable, 1 << 20);
    const writer = writable.getWriter();
    const command = new Fields((await reader.read())!.payload);
    const cmd: Command = {
      operation: command.u16(1)!,
      requestId: Number(command.u64(2)),
      payload: command.group(3) ?? new Fields(new Uint8Array()),
      inputs: [],
    };
    for (;;) {
      const m = await reader.read();
      if (!m) return;
      if (m.kind === Kind.INPUT_END) break;
      cmd.inputs.push({ kind: m.kind, fields: new Fields(m.payload) });
    }
    this.server.commands.push(cmd);
    const reply = await this.server.handler(cmd, this.server);
    if (reply === "hang") return;
    for (const f of reply) await writer.write(f as Uint8Array<ArrayBuffer>);
    await writer.close().catch(() => {});
  }
}

/** The documents sent by a client with INPUT_VALUE frames, decoded with its announced dictionary. */
export function inputDocuments(cmd: Command): Doc[] {
  const names = new Map<number, Map<number, string>>();
  const docs: Doc[] = [];
  for (const input of cmd.inputs) {
    if (input.kind === Kind.DICTIONARY) {
      const ctx = Number(input.fields.u64(1));
      const map = names.get(ctx) ?? new Map();
      names.set(ctx, map);
      for (const e of input.fields.groups(2)) map.set(e.u32(1)!, e.str(2)!);
    } else if (input.kind === Kind.INPUT_VALUE && input.fields.has(2) && input.fields.has(1)) {
      docs.push(decodeValue(input.fields.bin(2)!, names.get(Number(input.fields.u64(1))) ?? new Map()) as Doc);
    }
  }
  return docs;
}

/** BEGIN, DICTIONARY and ITEM frames for a document result, then END. */
export function documentReply(key: Uint8Array, doc: Doc): Uint8Array[] {
  const dict = new NameDictionary();
  const bytes = encodeDocument(doc, dict);
  return [
    frame(Kind.BEGIN, enc.u64(1, 1)),
    ...dictionaryFrames(dict),
    frame(Kind.ITEM, enc.bin(1, key), enc.u64(2, 1), enc.bin(3, bytes)),
    encodeFrame(Kind.END),
  ];
}

export const errorFrame = (code: number, outcome?: number): Uint8Array =>
  frame(Kind.ERROR, enc.u64(1, 0), enc.u16(2, code), ...(outcome === undefined ? [] : [enc.u16(3, outcome)]));
