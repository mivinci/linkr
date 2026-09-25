import { solve, type WorkerInit, type WorkerRequest, type WorkerResponse } from "./solver";
import { satSetBinary } from "./sat";

self.onmessage = (ev: MessageEvent<WorkerRequest | WorkerInit>) => {
  // The wasm travels as base64 text: a worker cannot reach into the parent's
  // bundle, and a shared binary copy would mean bundling it twice.
  if ("wasmB64" in ev.data) {
    satSetBinary(ev.data.wasmB64);
    return;
  }
  const { id, ...req } = ev.data;
  try {
    const out = solve(req);
    (self as unknown as Worker).postMessage({ id, ...out } satisfies WorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      solutions: [],
      nodes: 0,
      ms: 0,
      timedOut: false,
      error: String(err),
    } satisfies WorkerResponse);
  }
};
