import {
  solve,
  type WorkerCancel,
  type WorkerInit,
  type WorkerProgress,
  type WorkerRequest,
  type WorkerResponse,
} from "./solver";
import { satSetBinary } from "./sat";

// Set by the parent; read between SAT chunks, which is the only point at which
// this worker can notice anything while the solver is running.
let cancelled = false;

const post = (msg: WorkerResponse | WorkerProgress) =>
  (self as unknown as Worker).postMessage(msg);

self.onmessage = async (ev: MessageEvent<WorkerRequest | WorkerInit | WorkerCancel>) => {
  // The wasm travels as base64 text: a worker cannot reach into the parent's
  // bundle, and a shared binary copy would mean bundling it twice.
  if ("wasmB64" in ev.data) {
    satSetBinary(ev.data.wasmB64);
    return;
  }
  if ("cancel" in ev.data) {
    cancelled = true;
    return;
  }
  const { id, ...req } = ev.data;
  cancelled = false;
  try {
    const out = await solve(req, {
      shouldStop: () => cancelled,
      onProgress: (conflicts) => post({ id, progress: conflicts }),
    });
    post({ id, ...out } satisfies WorkerResponse);
  } catch (err) {
    post({
      id,
      solutions: [],
      nodes: 0,
      ms: 0,
      timedOut: false,
      error: String(err),
    } satisfies WorkerResponse);
  }
};
