import "./style.css";
// ?worker&inline keeps the solver inside the bundle, so the single-file build
// stays a real single file
import SolverWorker from "./solver.worker.ts?worker&inline";
import { drawScene, fitView, latticeBounds, type Scene, type View } from "./render";
import { DEFAULT_VISION, extractPuzzle, type VisionParams } from "./vision";
import { nodeColor, PALETTE, type Puzzle } from "./types";
import {
  solve,
  type SolveRequest,
  type WorkerInit,
  type WorkerRequest,
  type WorkerResponse,
} from "./solver";
import { satSetBinary } from "./sat";
import { SAT_WASM_BASE64 } from "./sat.wasm";

type Tool = "pan" | "move" | "add" | "del" | "link" | "color";

interface Drag {
  kind: "node" | "pan";
  index: number;
  offX: number;
  offY: number;
  startX: number;
  startY: number;
  origOx: number;
  origOy: number;
}

const MAX_SIDE = 1600;

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const pairInfoEl = document.querySelector<HTMLParagraphElement>("#pairinfo")!;
const paletteEl = document.querySelector<HTMLDivElement>("#palette")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const secParams = document.querySelector<HTMLElement>("#sec-params")!;
const cbFull = document.querySelector<HTMLInputElement>("#cb-full")!;
const cbUniq = document.querySelector<HTMLInputElement>("#cb-uniq")!;
const cbOverlay = document.querySelector<HTMLInputElement>("#cb-overlay")!;
const appEl = document.querySelector<HTMLElement>("#app")!;
const btnSolve = document.querySelector<HTMLButtonElement>("#btn-solve")!;
const btnSolveM = document.querySelector<HTMLButtonElement>("#btn-solve-m")!;
const btnView = document.querySelector<HTMLButtonElement>("#btn-view")!;
const btnClearSol = document.querySelector<HTMLButtonElement>("#btn-clearsol")!;
const btnPng = document.querySelector<HTMLButtonElement>("#btn-png")!;
const btnJson = document.querySelector<HTMLButtonElement>("#btn-json")!;
const emptyEl = document.querySelector<HTMLElement>("#empty")!;

function setBusy(busy: boolean) {
  btnSolve.disabled = busy;
  btnSolveM.disabled = busy;
}

/**
 * Keep the result buttons honest: offer only what the current board can
 * actually do.  "算法演示" stays enabled on purpose — the write-up is worth
 * reading before there is an answer, and the dialog says so.
 */
function syncButtons() {
  const hasBoard = state.puzzle.nodes.length > 0;
  btnClearSol.disabled = state.solution === null;
  btnPng.disabled = !hasBoard;
  btnJson.disabled = !hasBoard;
}

function isPhone() {
  return window.matchMedia("(max-width: 699px)").matches;
}

/** Phone: the panel is a bottom sheet over the canvas. */
function setPanelOpen(open: boolean) {
  appEl.classList.toggle("panel-open", open);
  document
    .querySelector("#btn-panel")!
    .setAttribute("aria-expanded", String(open));
}

document.querySelector<HTMLButtonElement>("#btn-panel")!.addEventListener("click", () =>
  setPanelOpen(!appEl.classList.contains("panel-open")),
);
document
  .querySelector<HTMLButtonElement>("#btn-open-m")!
  .addEventListener("click", () => fileInput.click());
document
  .querySelector<HTMLButtonElement>("#btn-solve-m")!
  .addEventListener("click", solveNow);

const state = {
  puzzle: { nodes: [], edges: [], width: 0, height: 0 } as Puzzle,
  image: null as HTMLCanvasElement | null,
  imageData: null as ImageData | null,
  vision: { ...DEFAULT_VISION } as VisionParams,
  view: { scale: 1, ox: 0, oy: 0 } as View,
  tool: "move" as Tool,
  activePair: 0,
  hoverNode: null as number | null,
  hoverEdge: null as number | null,
  linkFrom: null as number | null,
  pointer: null as [number, number] | null,
  drag: null as Drag | null,
  solution: null as number[][] | null,
  /** How the winning solution was grown, step by step, for the algorithm demo. */
  trace: null as [number, number][] | null,
  /** True when `trace` replays the answer instead of recording the search. */
  traceSynthetic: false,
  stats: null as {
    nodes: number;
    ms: number;
    attempts: number;
    engine?: "sat" | "dfs";
    cuts?: number;
  } | null,
  busy: false,
  job: 0,
  lastR: 26,
  spaceDown: false,
};

/** First line is the verdict, every following line is supporting detail. */
function setStatus(text: string, kind: "" | "ok" | "warn" | "err" = "") {
  const [head, ...rest] = text.split("\n");
  statusEl.className = `status ${kind}`;
  statusEl.textContent = "";

  const dot = document.createElement("i");
  dot.className = "status-dot";

  const body = document.createElement("span");
  body.className = "status-body";

  const first = document.createElement("b");
  first.className = "status-head";
  first.textContent = head;
  body.append(first);

  for (const line of rest) {
    const sub = document.createElement("span");
    sub.className = "status-sub";
    sub.textContent = line;
    body.append(sub);
  }

  statusEl.append(dot, body);
}

// ---------------------------------------------------------------- palette

for (let i = 0; i < PALETTE.length; i++) {
  const b = document.createElement("button");
  b.className = "swatch";
  const c = PALETTE[i];
  b.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
  b.title = `颜色 ${i + 1}`;
  // picking a colour is a clear signal of intent, so it also arms the tool
  b.addEventListener("click", () => {
    selectPair(i);
    selectTool("color");
  });
  paletteEl.appendChild(b);
}
function selectPair(i: number) {
  state.activePair = i;
  [...paletteEl.children].forEach((el, k) => el.classList.toggle("active", k === i));
  refreshPairInfo();
}
selectPair(0);

function refreshPairInfo() {
  const groups = pairGroups();
  const bad = [...groups.entries()].filter(([, v]) => v.length !== 2);
  const unpaired = state.puzzle.nodes.filter((n) => n.rgb && n.pair === null).length;
  if (bad.length === 0 && unpaired === 0) {
    pairInfoEl.textContent =
      groups.size > 0 ? `${groups.size} 组颜色已配好` : "还没有端点，用「设颜色」点两个点";
    pairInfoEl.style.color = "";
  } else {
    const parts: string[] = [];
    if (bad.length) parts.push(`颜色不合法：${bad.map(([k, v]) => `#${k + 1} 有 ${v.length} 个点`).join("，")}`);
    if (unpaired) parts.push(`${unpaired} 个识别出的端点没配对`);
    pairInfoEl.textContent = parts.join("；");
    pairInfoEl.style.color = "var(--warn)";
  }
}

/**
 * Click a dot with a palette colour selected: it joins an existing pair of that
 * colour if one is waiting, otherwise it starts a new pair.  Clicking a dot that
 * already has that colour clears it.
 */
function assignColor(index: number, swatch: number) {
  const node = state.puzzle.nodes[index];
  const want = PALETTE[swatch];
  const cur = node.pair !== null || node.rgb ? nodeColor(node) : null;
  const same =
    cur !== null && cur[0] === want[0] && cur[1] === want[1] && cur[2] === want[2];

  if (same) {
    node.pair = null;
    node.rgb = null;
    state.solution = null;
    refreshPairInfo();
    return;
  }

  node.pair = null;
  node.rgb = null;
  let target = -1;
  let maxId = -1;
  for (const [pid, members] of pairGroups()) {
    maxId = Math.max(maxId, pid);
    if (target >= 0 || members.length !== 1) continue;
    const other = state.puzzle.nodes[members[0]];
    const c = nodeColor(other);
    if (c[0] === want[0] && c[1] === want[1] && c[2] === want[2]) target = pid;
  }
  node.pair = target >= 0 ? target : maxId + 1;
  node.rgb = want;
  state.solution = null;
  refreshPairInfo();
}

function pairGroups(): Map<number, number[]> {
  const m = new Map<number, number[]>();
  state.puzzle.nodes.forEach((n, i) => {
    if (n.pair === null) return;
    const arr = m.get(n.pair) ?? [];
    arr.push(i);
    m.set(n.pair, arr);
  });
  return m;
}

// ---------------------------------------------------------------- canvas

function scene(): Scene {
  return {
    image: state.image,
    paths: state.solution,
    hoverNode: state.hoverNode,
    hoverEdge: state.hoverEdge,
    pendingLink:
      state.linkFrom !== null && state.pointer
        ? { from: state.linkFrom, to: state.pointer }
        : null,
    showOverlay: cbOverlay.checked,
  };
}

function redraw() {
  emptyEl.classList.toggle(
    "hidden",
    state.image !== null || state.puzzle.nodes.length > 0,
  );
  // cleared whenever the board changes, so a stale derivation is never replayed
  if (!state.solution && (state.trace || state.stats)) {
    state.trace = null;
    state.stats = null;
  }
  syncButtons();

  const dpr = window.devicePixelRatio || 1;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  drawScene(canvas, state.puzzle, scene(), state.view, dpr);
}

function refit() {
  state.view = fitView(state.puzzle, stage.clientWidth, stage.clientHeight);
  redraw();
}

new ResizeObserver(() => redraw()).observe(stage);
if (window.devicePixelRatio) {
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", redraw);
}

// ---------------------------------------------------------------- geometry

function toWorld(ev: { clientX: number; clientY: number }): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [
    (ev.clientX - rect.left - state.view.ox) / state.view.scale,
    (ev.clientY - rect.top - state.view.oy) / state.view.scale,
  ];
}

function hitNode(x: number, y: number): number | null {
  let best = -1;
  let bestD = Infinity;
  state.puzzle.nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < n.r && d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

function hitEdge(x: number, y: number): number | null {
  const tol = 12 / state.view.scale;
  let best = -1;
  let bestD = Infinity;
  state.puzzle.edges.forEach((e, i) => {
    const a = state.puzzle.nodes[e.a];
    const b = state.puzzle.nodes[e.b];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const L2 = vx * vx + vy * vy;
    if (L2 === 0) return;
    let t = ((x - a.x) * vx + (y - a.y) * vy) / L2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + t * vx), y - (a.y + t * vy));
    if (d < tol && d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

function edgeIndex(a: number, b: number): number {
  return state.puzzle.edges.findIndex(
    (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a),
  );
}

// ---------------------------------------------------------------- interaction

// Two fingers pan and pinch.  Single finger keeps doing whatever the current
// tool does, so tapping still works on touch.
const pointers = new Map<number, { x: number; y: number }>();
let gesture: { d0: number; wx: number; wy: number; s0: number } | null = null;

function canvasPoint(ev: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

function twoFinger() {
  if (pointers.size < 2) return null;
  const [a, b] = [...pointers.values()];
  return {
    d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}

function startGesture() {
  const g = twoFinger();
  if (!g) return;
  state.drag = null; // a second finger cancels any in-flight node drag
  state.linkFrom = null;
  gesture = {
    d0: g.d,
    wx: (g.mx - state.view.ox) / state.view.scale,
    wy: (g.my - state.view.oy) / state.view.scale,
    s0: state.view.scale,
  };
}

function updateGesture() {
  const g = twoFinger();
  if (!g || !gesture) return;
  const s = Math.max(0.08, Math.min(14, gesture.s0 * (g.d / gesture.d0)));
  state.view.scale = s;
  state.view.ox = g.mx - gesture.wx * s;
  state.view.oy = g.my - gesture.wy * s;
}

canvas.addEventListener("pointerdown", (ev) => {
  // capture fails when the pointer is already gone; the gesture still works
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  pointers.set(ev.pointerId, canvasPoint(ev));
  if (pointers.size >= 2) {
    startGesture();
    redraw();
    return;
  }

  const [x, y] = toWorld(ev);
  const n = hitNode(x, y);

  if (ev.button === 1 || state.spaceDown || state.tool === "pan") {
    state.drag = {
      kind: "pan",
      index: -1,
      offX: 0,
      offY: 0,
      startX: ev.clientX,
      startY: ev.clientY,
      origOx: state.view.ox,
      origOy: state.view.oy,
    };
    return;
  }

  switch (state.tool) {
    case "move":
      if (n !== null) {
        const node = state.puzzle.nodes[n];
        state.drag = {
          kind: "node",
          index: n,
          offX: node.x - x,
          offY: node.y - y,
          startX: ev.clientX,
          startY: ev.clientY,
          origOx: 0,
          origOy: 0,
        };
        state.hoverNode = n;
      }
      break;
    case "add":
      if (n === null) {
        const before = state.puzzle.nodes.length;
        state.puzzle.nodes.push({ x, y, r: state.lastR, pair: null, rgb: null });
        state.hoverNode = before;
        refreshPairInfo();
      }
      break;
    case "del": {
      if (n !== null) {
        removeNode(n);
      } else {
        const e = hitEdge(x, y);
        if (e !== null) state.puzzle.edges.splice(e, 1);
      }
      refreshPairInfo();
      break;
    }
    case "link":
      if (n !== null) {
        if (state.linkFrom === null) {
          state.linkFrom = n;
        } else if (state.linkFrom === n) {
          state.linkFrom = null;
        } else {
          const at = edgeIndex(state.linkFrom, n);
          if (at >= 0) state.puzzle.edges.splice(at, 1);
          else state.puzzle.edges.push({ a: state.linkFrom, b: n });
          state.linkFrom = null;
        }
      } else {
        state.linkFrom = null;
      }
      break;
    case "color":
      if (n !== null) assignColor(n, state.activePair);
      break;
  }
  redraw();
});

canvas.addEventListener("pointermove", (ev) => {
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, canvasPoint(ev));
  if (gesture && pointers.size >= 2) {
    updateGesture();
    redraw();
    return;
  }

  const [x, y] = toWorld(ev);
  state.pointer = [x, y];

  if (state.drag?.kind === "pan") {
    state.view.ox = state.drag.origOx + (ev.clientX - state.drag.startX);
    state.view.oy = state.drag.origOy + (ev.clientY - state.drag.startY);
    redraw();
    return;
  }
  if (state.drag?.kind === "node") {
    const node = state.puzzle.nodes[state.drag.index];
    node.x = x + state.drag.offX;
    node.y = y + state.drag.offY;
    state.hoverNode = state.drag.index;
    redraw();
    return;
  }

  const n = hitNode(x, y);
  const e = n === null && (state.tool === "del" || state.tool === "move") ? hitEdge(x, y) : null;
  const stale = n !== state.hoverNode || e !== state.hoverEdge;
  state.hoverNode = n;
  state.hoverEdge = e;
  if (stale || state.linkFrom !== null) redraw();
});

function endDrag(ev: PointerEvent) {
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) gesture = null;
  state.drag = null;
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("lostpointercapture", endDrag);

canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const factor = Math.exp(-ev.deltaY * 0.0015);
  const next = Math.max(0.08, Math.min(14, state.view.scale * factor));
  const k = next / state.view.scale;
  state.view.ox = sx - (sx - state.view.ox) * k;
  state.view.oy = sy - (sy - state.view.oy) * k;
  state.view.scale = next;
  redraw();
}, { passive: false });

function removeNode(i: number) {
  const p = state.puzzle;
  p.nodes.splice(i, 1);
  p.edges = p.edges
    .filter((e) => e.a !== i && e.b !== i)
    .map((e) => ({ a: e.a > i ? e.a - 1 : e.a, b: e.b > i ? e.b - 1 : e.b }));
  state.solution = null;
  state.hoverNode = null;
  state.linkFrom = null;
}

window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  if (ev.code === "Space") {
    state.spaceDown = true;
    ev.preventDefault();
  }
  if (ev.key === "Delete" || ev.key === "Backspace") {
    if (state.hoverNode !== null) {
      removeNode(state.hoverNode);
      refreshPairInfo();
      redraw();
    }
  }
  const n = Number(ev.key);
  if (n >= 1 && n <= 9 && n <= PALETTE.length) {
    selectPair(n - 1);
    selectTool("color");
  }
});
window.addEventListener("keyup", (ev) => {
  if (ev.code === "Space") state.spaceDown = false;
});

/** The single place that decides which tool is live, so the button states and
 *  state.tool can never disagree. */
function selectTool(name: Tool) {
  state.tool = name;
  state.linkFrom = null;
  document
    .querySelectorAll<HTMLButtonElement>("#tools .tool")
    .forEach((el) => el.classList.toggle("active", el.dataset.tool === name));
  redraw();
}

document.querySelectorAll<HTMLButtonElement>("#tools .tool").forEach((btn) => {
  btn.addEventListener("click", () => selectTool(btn.dataset.tool as Tool));
});

// pan by default: the first thing anyone does with a fresh screenshot is look
// around it, not edit it
selectTool("pan");

// ---------------------------------------------------------------- loading

async function loadFile(file: File | Blob) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("图片解码失败"));
      img.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0, w, h);
    state.image = c;
    state.imageData = cx.getImageData(0, 0, w, h);
    state.puzzle = { nodes: [], edges: [], width: w, height: h };
    state.solution = null;
    secParams.hidden = false;
    detect();
  } catch (err) {
    setStatus(String(err), "err");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function detect() {
  if (!state.imageData) return;
  const t0 = performance.now();
  try {
    const p = extractPuzzle(state.imageData, state.vision);
    p.width = state.puzzle.width;
    p.height = state.puzzle.height;
    state.puzzle = p;
    state.solution = null;
    const radii = p.nodes.map((n) => n.r).sort((a, b) => a - b);
    if (radii.length) state.lastR = radii[radii.length >> 1];
    const dt = Math.round(performance.now() - t0);
    const groups = pairGroups();
    const bad = [...groups.entries()].filter(([, v]) => v.length !== 2);
    const unpaired = p.nodes.filter((n) => n.rgb && n.pair === null).length;

    // a dot with no edge means the pixel test rejected everything around it —
    // almost always a real edge that fell outside the candidate distance cap
    const degree = new Array<number>(p.nodes.length).fill(0);
    for (const e of p.edges) {
      degree[e.a]++;
      degree[e.b]++;
    }
    const isolated = degree.filter((d) => d === 0).length;

    const m = p.meta;
    const scaleEl = document.querySelector<HTMLParagraphElement>("#scale")!;
    scaleEl.textContent = m
      ? `点半径 ${m.radius}px · 网格间距 ${m.spacing}px · 最小点 ${m.minDist}px · ` +
        `孔洞上限 ${m.maxHole}${m.dropped ? ` · 忽略干扰 ${m.dropped}` : ""}` +
        `${m.inferred ? ` · 推断补边 ${m.inferred}` : ""}`
      : "";

    // verdict on the first line, numbers and caveats underneath
    const notes: string[] = [`${dt}ms`];
    if (bad.length || unpaired) notes.push(`有 ${bad.length + unpaired} 处颜色需要人工校对`);
    if (isolated) notes.push(`有 ${isolated} 个点没连上任何边，试着调大「连边距离系数」`);
    if (p.meta?.inferred) notes.push(`虚线是推断补的边（${p.meta.inferred} 条），可用连边工具核对`);
    setStatus(
      `识别完成：${p.nodes.length} 个点 · ${p.edges.length} 条边\n${notes.join("\n")}`,
      bad.length || unpaired || isolated ? "warn" : "",
    );
    refreshPairInfo();
    refit();
  } catch (err) {
    setStatus(`识别失败：${err}`, "err");
  }
}

document.querySelector<HTMLButtonElement>("#btn-open")!.addEventListener("click", () =>
  fileInput.click(),
);
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = "";
});
document.querySelector<HTMLButtonElement>("#btn-blank")!.addEventListener("click", () => {
  state.image = null;
  state.imageData = null;
  state.puzzle = { nodes: [], edges: [], width: 1400, height: 1000 };
  state.solution = null;
  secParams.hidden = true;
  state.view = { scale: 1, ox: 0, oy: 0 };
  setStatus("空白画布：用「加点」「连边」「设颜色」画题");
  refreshPairInfo();
  refit();
});
document.querySelector<HTMLButtonElement>("#btn-redetect")!.addEventListener("click", detect);

stage.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  stage.classList.add("dragover");
});
stage.addEventListener("dragleave", () => stage.classList.remove("dragover"));
stage.addEventListener("drop", (ev) => {
  ev.preventDefault();
  stage.classList.remove("dragover");
  const f = ev.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});
window.addEventListener("paste", (ev) => {
  const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  const f = item?.getAsFile();
  if (f) loadFile(f);
});

// ---------------------------------------------------------------- params

function bindSlider(id: string, key: keyof VisionParams, fmt: (v: number) => string) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
  const out = document.querySelector<HTMLElement>(`#v-${id.replace("p-", "")}`)!;
  const sync = () => {
    const v = Number(input.value);
    (state.vision as unknown as Record<string, number>)[key] = v;
    out.textContent = fmt(v);
  };
  input.addEventListener("input", sync);
  sync();
}
bindSlider("p-thresh", "thresh", (v) => String(v));
bindSlider("p-sat", "satMin", (v) => String(v));
bindSlider("p-mindist", "minDist", (v) => (v === 0 ? "自动" : String(v)));
bindSlider("p-ratio", "ratio", (v) => v.toFixed(2));
bindSlider("p-hole", "maxHole", (v) => (v === 0 ? "自动" : String(v)));

// ---------------------------------------------------------------- solving

// The solver runs in a worker so the UI stays responsive.  Browsers refuse to
// start a worker from a file:// page (opaque origin), and that is exactly how
// the single-file build gets opened — so fall back to running it inline.
interface Job {
  id: number;
  req: SolveRequest;
  cb: (r: WorkerResponse) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
const pending = new Map<number, Job>();

// The inline path — a file:// page cannot start a worker at all — needs the
// engine too, so seed it here whether or not a worker ever comes up.
satSetBinary(SAT_WASM_BASE64);

function runInline(req: SolveRequest, id: number): WorkerResponse {
  try {
    return { id, ...solve(req) };
  } catch (err) {
    return { id, solutions: [], nodes: 0, ms: 0, timedOut: false, error: String(err) };
  }
}

function fallBackToInline() {
  workerBroken = true;
  worker = null;
  const jobs = [...pending.values()];
  pending.clear();
  for (const job of jobs) job.cb(runInline(job.req, job.id));
}

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    const w = new SolverWorker();
    // The engine is 60 kB of wasm held here as base64; the worker gets a copy
    // by message so the bundle only carries one.
    w.postMessage({ wasmB64: SAT_WASM_BASE64 } satisfies WorkerInit);
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const job = pending.get(ev.data.id);
      if (job) {
        pending.delete(ev.data.id);
        job.cb(ev.data);
      }
    };
    w.onerror = () => fallBackToInline();
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

function runSolver(req: SolveRequest): Promise<WorkerResponse> {
  const id = ++state.job;
  const w = getWorker();
  if (!w) return Promise.resolve(runInline(req, id));
  return new Promise((res) => {
    pending.set(id, { id, req, cb: res });
    w.postMessage({ ...req, id } satisfies WorkerRequest);
  });
}

async function solveNow() {
  if (state.busy) return;
  const groups = pairGroups();
  const bad = [...groups.entries()].filter(([, v]) => v.length !== 2);
  if (bad.length) {
    setStatus(`颜色不合法：${bad.map(([k, v]) => `#${k + 1} 有 ${v.length} 个点`).join("，")}`, "err");
    return;
  }
  if (groups.size === 0) {
    setStatus("还没有端点：先用「设颜色」给两个点标上同一种颜色", "err");
    return;
  }
  const pairs = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v as [number, number]);
  const edges = state.puzzle.edges.map((e) => [e.a, e.b] as [number, number]);

  state.busy = true;
  setBusy(true);
  setStatus("求解中…");
  const base = {
    n: state.puzzle.nodes.length,
    edges,
    pairs,
    requireFull: cbFull.checked,
  };
  const total = state.puzzle.nodes.length;

  // Restarts with a permuted colour numbering rescue the boards the plain
  // search cannot finish; see the note in solver.ts.
  const res = await runSolver({
    ...base,
    maxSolutions: 1,
    timeLimitMs: 20000,
    restarts: 64,
    nodeBudget: 12000,
    trace: true,
  });
  if (res.error) {
    state.busy = false;
    setBusy(false);
    setStatus(`求解失败：${res.error}`, "err");
    return;
  }
  if (res.solutions.length === 0) {
    state.busy = false;
    setBusy(false);
    setStatus(
      res.timedOut
        ? `20s 内没找到解（搜索了 ${res.nodes} 个节点）` +
          `\n先核对识别结果（点数/边数/颜色配对）；也可取消「必须覆盖所有点」再试`
        : res.engine === "sat"
          ? `无解（SAT 已证明，${res.nodes} 次冲突，${res.ms}ms）` +
            `\n真实关卡不会无解，优先怀疑识别结果`
          : `无解（搜索了 ${res.nodes} 个节点，${res.ms}ms）` +
            `\n真实关卡不会无解，优先怀疑识别`,
      "warn",
    );
    return;
  }

  // show the answer immediately, then verify uniqueness in the background
  state.solution = res.solutions[0];
  state.trace = res.trace ?? null;
  state.traceSynthetic = res.syntheticTrace ?? false;
  state.stats = {
    nodes: res.nodes,
    ms: res.ms,
    attempts: res.attempts ?? 1,
    engine: res.engine,
    cuts: res.cuts ?? 0,
  };
  cbOverlay.checked = false;
  redraw();
  if (isPhone()) setPanelOpen(false); // the sheet covers the whole canvas
  const covered = res.solutions[0].reduce((s, p) => s + p.length, 0);
  const headline = `求解成功：覆盖 ${covered}/${total} 个点`;
  const detail =
    res.engine === "sat"
      ? `SAT 求解 · ${res.nodes} 次冲突${res.cuts ? ` · ${res.cuts} 次割` : ""} · ${res.ms}ms`
      : `DFS 搜索 · ${res.nodes} 个搜索节点 · ${res.ms}ms`;

  if (!cbUniq.checked) {
    state.busy = false;
    setBusy(false);
    setStatus(`${headline}\n${detail}`, "ok");
    return;
  }

  setStatus(`${headline}\n${detail}\n正在验证唯一性…`);
  const uniq = await runSolver({
    ...base,
    maxSolutions: 2,
    timeLimitMs: 10000,
    restarts: 8,
    nodeBudget: 12000,
  });
  state.busy = false;
  setBusy(false);

  let distinct = false;
  if (uniq.solutions.length >= 2) {
    for (let i = 0; i < uniq.solutions[0].length && !distinct; i++) {
      const a = uniq.solutions[0][i].join(",");
      const b = uniq.solutions[1][i].join(",");
      const c = [...uniq.solutions[1][i]].reverse().join(",");
      if (a !== b && a !== c) distinct = true;
    }
  }
  // `detail` describes how the answer was found; the uniqueness verdict is a
  // separate run and, on a board the search could handle, a different engine.
  const proven = uniq.engine === "sat" && res.engine !== "sat" ? "（唯一性由 SAT 证明）" : "";
  if (uniq.solutions.length >= 2 && distinct) {
    setStatus(`${headline}\n这个题目不止一个解（至少找到 2 个）\n${detail}`, "warn");
  } else if (uniq.timedOut) {
    setStatus(`${headline}\n没能穷尽搜索，不能断定唯一\n${detail}`, "");
  } else {
    setStatus(`${headline}\n唯一解${proven}\n${detail}`, "ok");
  }
}

document.querySelector<HTMLButtonElement>("#btn-solve")!.addEventListener("click", solveNow);
cbOverlay.addEventListener("change", redraw);
btnClearSol.addEventListener("click", () => {
  state.solution = null;
  cbOverlay.checked = true;
  redraw();
});

// ---------------------------------------------------------------- solution modal

const modal = document.querySelector<HTMLElement>("#modal")!;
const modalCanvas = document.querySelector<HTMLCanvasElement>("#modal-canvas")!;

/** Cluster dot coordinates into rows/columns so a path can be read out in words. */
function gridLabels(): ((i: number) => string) | null {
  const p = state.puzzle;
  const step = p.meta?.spacing ?? 0;
  if (!step || !p.nodes.length) return null;
  const tol = step * 0.4;

  const axis = (values: number[]): number[] => {
    const sorted = [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b);
    const groups: number[] = [];
    for (const v of sorted) {
      if (!groups.length || v - groups[groups.length - 1] > tol) groups.push(v);
    }
    return groups;
  };
  const cols = axis(p.nodes.map((n) => n.x));
  const rows = axis(p.nodes.map((n) => n.y));
  if (cols.length > 40 || rows.length > 40) return null;

  const slot = (groups: number[], v: number) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const d = Math.abs(v - groups[i]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best + 1;
  };
  return (i: number) => {
    const n = p.nodes[i];
    return `${slot(rows, n.y)}行${slot(cols, n.x)}列`;
  };
}

const demoRange = document.querySelector<HTMLInputElement>("#demo-range")!;
const demoProgress = document.querySelector<HTMLElement>("#demo-progress")!;
const demoNote = document.querySelector<HTMLElement>("#demo-note")!;
const modalStats = document.querySelector<HTMLElement>("#modal-stats")!;
const btnPlay = document.querySelector<HTMLButtonElement>("#btn-play")!;

const demo = { idx: 0, playing: false, timer: 0 };

/** Rebuild every path as it stood after `upto` growth steps. */
function demoPaths(upto: number): number[][] {
  const sol = state.solution;
  const tr = state.trace;
  if (!sol) return [];
  const out = sol.map((p) => [p[0]]);
  if (tr) {
    for (let i = 0; i < upto && i < tr.length; i++) out[tr[i][0]].push(tr[i][1]);
  }
  return out;
}

function totalSteps(): number {
  return state.trace ? state.trace.length : 0;
}

function renderModal() {
  if (modal.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = modalCanvas.clientWidth || 360;
  const ch = modalCanvas.clientHeight || 320;
  modalCanvas.width = Math.round(cw * dpr);
  modalCanvas.height = Math.round(ch * dpr);

  const total = totalSteps();
  const upto = Math.min(demo.idx, total);
  const tr = state.trace;
  const head = tr && upto > 0 ? tr[upto - 1][1] : null;

  drawScene(
    modalCanvas,
    state.puzzle,
    {
      image: null,
      paths: tr ? demoPaths(upto) : null,
      hoverNode: head,
      hoverEdge: null,
      pendingLink: null,
      showOverlay: false,
      ghostEdges: true,
    },
    fitView(state.puzzle, cw, ch, 10),
    dpr,
  );

  demoRange.max = String(total);
  demoRange.value = String(upto);
  demoProgress.textContent = total ? `${upto} / ${total} 步` : "—";

  if (!tr) {
    demoNote.textContent = "还没有解，先点「求解」再看过程";
  } else if (upto === 0) {
    demoNote.textContent = "起点：每条路径站在自己的端点上，还没开始生长";
  } else {
    const [c, v] = tr[upto - 1];
    const label = gridLabels();
    const at = label ? label(v) : `#${v}`;
    const col = nodeColor(state.puzzle.nodes[v]);
    const done = demoPaths(upto).every((p, i) => {
      const end = state.solution![i][state.solution![i].length - 1];
      return p[p.length - 1] === end;
    });
    demoNote.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "sol-dot";
    dot.style.background = `rgb(${col[0]},${col[1]},${col[2]})`;
    const text = document.createElement("span");
    text.textContent = `第 ${upto} 步 · 颜色 ${c + 1} 伸展到 ${at}` +
      (done ? " · 已完成" : "");
    demoNote.append(dot, text);
  }

  renderStats();
}

const algoLead = document.querySelector<HTMLElement>("#algo-lead")!;

/**
 * The demo advertises the solver's own derivation, which is only true when the
 * search produced the answer.  SAT decides variables and never walks a path, so
 * for those boards the identical animation is a replay of the answer.  Say which
 * one it is rather than letting the lead paragraph claim the wrong thing.
 */
function renderAlgoLead(): void {
  algoLead.innerHTML = state.traceSynthetic
    ? "这一道题是 <b>SAT 解出的</b>：它判定变量，不长路径，所以没有“实际生长顺序”可以重放。" +
      "下面是<b>答案本身的回放</b> —— 按颜色轮转铺开，看起来像推导，其实不是。" +
      "SAT 那一栏的冲突次数才是它真正的工作量。"
    : "下面这段动画是求解器在<b>这一道题上真实走过的那条推导</b> —— 按它实际的生长顺序" +
      "重放，不是答案的美化回放。中途走进死路又退回去的分支没有画出来，那部分量级见下方统计。";
}

function renderStats() {
  renderAlgoLead();
  const p = state.puzzle;
  const groups = pairGroups().size;
  const rows: [string, string][] = [
    ["棋盘", `${p.nodes.length} 个点 · ${p.edges.length} 条边 · ${groups} 组颜色`],
    [
      "求解引擎",
      state.stats
        ? state.stats.engine === "sat"
          ? `SAT（wasm）${state.stats.cuts ? ` · ${state.stats.cuts} 次割` : ""}`
          : "DFS 搜索"
        : "—",
    ],
    [
      state.stats?.engine === "sat" ? "冲突次数" : "搜索节点",
      state.stats ? String(state.stats.nodes) : "—",
    ],
    ["耗时", state.stats ? `${state.stats.ms} ms` : "—"],
    [
      "颜色顺序",
      state.stats
        ? state.stats.engine === "sat"
          ? "不适用（SAT 不做颜色排序）"
          : state.stats.attempts === 1
            ? "第 1 次命中"
            : `第 ${state.stats.attempts} 次才命中（前几次都放弃了）`
        : "—",
    ],
    [
      "生长步数",
      state.trace && state.stats
        ? state.traceSynthetic
          ? `${state.trace.length} 步（回放，非搜索记录）`
          : `${state.trace.length} 步（另有 ${Math.max(0, state.stats.nodes - state.trace.length)} 次尝试被回退）`
        : "—",
    ],
  ];
  modalStats.textContent = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    modalStats.append(dt, dd);
  }
}

function stopPlay() {
  demo.playing = false;
  if (demo.timer) {
    clearInterval(demo.timer);
    demo.timer = 0;
  }
  btnPlay.textContent = "▶ 播放";
}

function play() {
  if (!state.trace) return;
  if (demo.idx >= totalSteps()) demo.idx = 0;
  demo.playing = true;
  btnPlay.textContent = "❚❚ 暂停";
  stopTimerOnly();
  demo.timer = window.setInterval(() => {
    if (demo.idx >= totalSteps()) {
      stopPlay();
      return;
    }
    demo.idx++;
    renderModal();
  }, 90);
}

function stopTimerOnly() {
  if (demo.timer) {
    clearInterval(demo.timer);
    demo.timer = 0;
  }
}

function stepBy(d: number) {
  stopPlay();
  const total = totalSteps();
  demo.idx = Math.max(0, Math.min(total, demo.idx + d));
  renderModal();
}

function openModal() {
  modal.hidden = false;
  demo.idx = 0;
  renderModal();
  if (state.trace) play();
}

function closeModal() {
  stopPlay();
  modal.hidden = true;
}

btnPlay.addEventListener("click", () => {
  if (demo.playing) stopPlay();
  else play();
});
document.querySelector<HTMLButtonElement>("#btn-step")!.addEventListener("click", () => stepBy(1));
document.querySelector<HTMLButtonElement>("#btn-back")!.addEventListener("click", () => stepBy(-1));
document.querySelector<HTMLButtonElement>("#btn-reset")!.addEventListener("click", () => {
  stopPlay();
  demo.idx = 0;
  renderModal();
});
demoRange.addEventListener("input", () => {
  stopPlay();
  demo.idx = Number(demoRange.value);
  renderModal();
});

btnView.addEventListener("click", openModal);
document
  .querySelector<HTMLButtonElement>("#btn-modal-close")!
  .addEventListener("click", closeModal);
modal.addEventListener("click", (ev) => {
  if (ev.target === modal) closeModal();
});
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !modal.hidden) closeModal();
});
window.addEventListener("resize", () => {
  if (!modal.hidden) renderModal();
});

// ---------------------------------------------------------------- export

function download(name: string, url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

btnPng.addEventListener("click", () => {
  if (!state.puzzle.width || !state.puzzle.nodes.length) return;
  // Crop to the lattice.  On a full-page screenshot the board is only part of
  // the picture, and exporting 1:1 buries the answer in unrelated UI.
  const { x0, y0, x1, y1 } = latticeBounds(state.puzzle);
  const pad = Math.max((x1 - x0), (y1 - y0)) * 0.04;
  const c = document.createElement("canvas");
  c.width = Math.round(x1 - x0 + pad * 2);
  c.height = Math.round(y1 - y0 + pad * 2);
  drawScene(
    c,
    state.puzzle,
    { ...scene(), showOverlay: !state.solution && cbOverlay.checked, pendingLink: null, hoverNode: null, hoverEdge: null },
    { scale: 1, ox: -(x0 - pad), oy: -(y0 - pad) },
    1,
  );
  download(
    state.solution ? "linkr-solution.png" : "linkr-board.png",
    c.toDataURL("image/png"),
  );
});

btnJson.addEventListener("click", () => {
  const groups = pairGroups();
  const payload = {
    width: state.puzzle.width,
    height: state.puzzle.height,
    nodes: state.puzzle.nodes.map((n) => ({
      x: Math.round(n.x * 100) / 100,
      y: Math.round(n.y * 100) / 100,
      r: Math.round(n.r * 100) / 100,
      pair: n.pair,
      rgb: n.rgb,
    })),
    edges: state.puzzle.edges.map((e) => [e.a, e.b]),
    pairs: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    solution: state.solution,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  download("linkr.json", url);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

refit();
setStatus("打开一张 Linkr 截图开始");

// debug / automation hook
declare global {
  interface Window {
    __nl?: { state: typeof state; detect: () => void; solveNow: () => Promise<void> };
  }
}
window.__nl = { state, detect, solveNow };
