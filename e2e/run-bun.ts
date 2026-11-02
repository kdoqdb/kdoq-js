// Runs the end-to-end scenario in Bun, then in Node, against a real kdoq process, with
// `@fails-components/webtransport` (a native WebTransport) passed through the `transport` option.
// Needs OpenSSL.
// Usage: KDOQ_BIN=/path/to/kdoq bun e2e/run-bun.ts
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, runScenario } from "./scenario";
import { loadTransport } from "./transport";

const server = process.env.KDOQ_BIN ?? "kdoq";
const directory = mkdtempSync(join(tmpdir(), "kdoq-js-e2e-"));
const run = (command: string[]) => {
  const result = Bun.spawnSync(command, { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr}`);
  return result.stdout;
};

let process_: ReturnType<typeof Bun.spawn> | undefined;
try {
  run([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-days",
    "7",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const der = run(["openssl", "x509", "-in", join(directory, "cert.pem"), "-outform", "DER"]);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    hash: createHash("sha256").update(der).digest("hex"),
    username: "Alice",
    password: "secret-marker",
  };

  mkdirSync(join(directory, "db"));
  writeFileSync(
    join(directory, "config.yml"),
    JSON.stringify({
      data: { path: "db" },
      http: {
        listen: { http: "127.0.0.1:0", quic: "127.0.0.1:0" },
        tls: { certificate: "cert.pem", private_key: "key.pem", allow_self_signed: true },
      },
      logging: { format: "json" },
      auth: { enabled: true, users: [{ username: config.username, password: config.password }] },
      native: { enabled: true },
    }),
  );
  process_ = Bun.spawn([server, "--config", join(directory, "config.yml")], { cwd: directory, stderr: "pipe", stdout: "ignore" });

  const decoder = new TextDecoder();
  let buffered = "";
  const reader = (process_.stderr as ReadableStream<Uint8Array>).getReader();
  ready: for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffered += decoder.decode(chunk.value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const fields = event.fields ?? event;
        if (fields.event === "server_ready") {
          config.port = Number(/127\.0\.0\.1:(\d+)/.exec(fields.native_address)?.[1]);
          break ready;
        }
      } catch {}
    }
  }
  if (!config.port) throw new Error("the server exited before it was ready");

  const transport = await loadTransport();
  const outcome = await runScenario(config, transport);
  console.log(JSON.stringify({ bun: outcome }, null, 2));
  if (!outcome.ok) process.exitCode = 1;

  // The same scenario in Node, to check that the library and the polyfill work there too.
  const bundleDirectory = join(import.meta.dir, "..", ".e2e");
  const bundle = join(bundleDirectory, "node.mjs");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "node.ts")],
    target: "node",
    external: ["*.node", "@fails-components/*"],
    outdir: bundleDirectory,
    naming: "node.mjs",
  });
  if (!built.success) throw new Error(`building the Node entry failed: ${built.logs.join("\n")}`);
  const node = Bun.spawnSync(["node", bundle, JSON.stringify({ ...config, database: "WebNode" })], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  console.log(`{ "node": ${decoder.decode(node.stdout) || "null"} }`);
  if (node.exitCode !== 0) {
    console.error(decoder.decode(node.stderr));
    process.exitCode = 1;
  }
} finally {
  rmSync(join(import.meta.dir, "..", ".e2e"), { recursive: true, force: true });
  process_?.kill();
  rmSync(directory, { recursive: true, force: true });
}
