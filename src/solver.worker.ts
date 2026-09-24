import { solve, type WorkerRequest, type WorkerResponse } from "./solver";

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
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
