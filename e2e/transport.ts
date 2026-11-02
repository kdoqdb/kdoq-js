// The WebTransport implementation the end-to-end suites pass through the `transport` option.
// It is a development dependency only; the library does not import it.
import type { TransportFactory } from "../src";

export async function loadTransport(): Promise<TransportFactory> {
  const { WebTransport, quicheLoaded } = await import("@fails-components/webtransport");
  await quicheLoaded;
  return (url, init) => new WebTransport(url, init as never) as never;
}
