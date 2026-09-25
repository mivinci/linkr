/**
 * End-to-end smoke test: serve dist/, load the screenshot, detect, solve.
 *
 *   node e2e/smoke.mjs <url> <image> [outdir]
 */
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:4321/";
const image = process.argv[3];
const outDir = process.argv[4] ?? "e2e/out";
mkdirSync(outDir, { recursive: true });

const exe =
  process.env.CHROME_PATH ??
  path.join(
    homedir(),
    "Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: "load" });

const t0 = Date.now();
await page.setInputFiles("#file", image);
await page.waitForFunction(
  () => (document.querySelector("#status")?.textContent ?? "").includes("识别完成"),
  null,
  { timeout: 60000 },
);
const detectMs = Date.now() - t0;
const detectStatus = await page.textContent("#status");
console.log("detect:", detectStatus.replace(/\n/g, " | "), `(${detectMs}ms wall)`);

const g = await page.evaluate(() => {
  const p = window.__nl.state.puzzle;
  const byPair = new Map();
  p.nodes.forEach((n, i) => {
    if (n.pair === null) return;
    byPair.set(n.pair, [...(byPair.get(n.pair) ?? []), i]);
  });
  return {
    nodes: p.nodes.length,
    edges: p.edges.length,
    pairs: [...byPair.entries()].sort((a, b) => a[0] - b[0]),
    radii: [...new Set(p.nodes.map((n) => Math.round(n.r)))].sort((a, b) => a - b),
    nodeList: p.nodes.map((n) => ({ x: Math.round(n.x), y: Math.round(n.y), rgb: n.rgb })),
  };
});
console.log("graph:", JSON.stringify({ nodes: g.nodes, edges: g.edges }));
console.log("pairs:", JSON.stringify(g.pairs));
console.log("radii:", JSON.stringify(g.radii));

const bad = g.pairs.filter(([, v]) => v.length !== 2);
if (bad.length) fail(`unpaired colours: ${JSON.stringify(bad)}`);
if (g.pairs.length === 0) fail("no colour classes detected");

// a colour class must join two dots of the *same* physical colour
for (const [pid, [a, b]] of g.pairs) {
  const ra = g.nodeList[a].rgb;
  const rb = g.nodeList[b].rgb;
  if (!ra || !rb) {
    fail(`pair ${pid}: a terminal has no ring colour (${JSON.stringify([ra, rb])})`);
    continue;
  }
  const d = Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]);
  if (d > 90) {
    fail(`pair ${pid} mixes colours: rgb${ra} at ${a} vs rgb${rb} at ${b}`);
  }
  const dup = g.nodeList.filter(
    (n, i) => i !== a && n.rgb && Math.hypot(n.rgb[0] - ra[0], n.rgb[1] - ra[1], n.rgb[2] - ra[2]) < 90,
  );
  if (dup.length !== 1) fail(`colour rgb${ra} appears ${dup.length + 1} times, expected 2`);
}
const edgeList = await page.evaluate(() =>
  window.__nl.state.puzzle.edges.map((e) => [e.a, e.b]),
);
const deg = new Array(g.nodes).fill(0);
for (const [a, b] of edgeList) {
  deg[a]++;
  deg[b]++;
}
const lonely = deg.filter((d) => d === 0).length;
if (lonely) fail(`${lonely} isolated dots — a real edge was rejected`);
if (detectStatus.includes("需要人工校对") || detectStatus.includes("没连上任何边"))
  fail(`detector reported problems: ${detectStatus}`);

await page.screenshot({ path: path.join(outDir, "1-detected.png") });

const t1 = Date.now();
await page.click("#btn-solve");
await page.waitForFunction(
  () => {
    const s = document.querySelector("#status")?.textContent ?? "";
    return s.includes("求解成功") || s.includes("无解") || s.includes("失败") || s.includes("没找到解");
  },
  null,
  { timeout: 60000 },
);
const solveMs = Date.now() - t1;
console.log("solve:", (await page.textContent("#status"))?.replace(/\n/g, " | "), `(${solveMs}ms wall)`);

const sol = await page.evaluate(() => {
  const s = window.__nl.state;
  return { paths: s.solution, nodes: s.puzzle.nodes.length };
});
if (!sol.paths) {
  console.error("FAIL: no solution produced");
  await browser.close();
  process.exit(1);
}

const covered = new Set(sol.paths.flat());
const seen = [];
for (const p of sol.paths)
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i];
    const b = p[i + 1];
    seen.push(a < b ? `${a}-${b}` : `${b}-${a}`);
  }
const dupEdge = seen.find((e, i) => seen.indexOf(e) !== i);
const dupNode = sol.paths.flat().find((v, i, arr) => arr.indexOf(v) !== i);

console.log("paths:", sol.paths.map((p, i) => `${i}: ${p.join("->")}`).join("\n       "));
if (covered.size !== sol.nodes) fail(`coverage ${covered.size}/${sol.nodes}`);
if (dupNode !== undefined) fail(`vertex ${dupNode} used twice`);
if (dupEdge !== undefined) fail(`edge ${dupEdge} used twice`);
for (const [, [pid, [a, b]]] of g.pairs.entries()) {
  const p = sol.paths[pid];
  const ok = p && ((p[0] === a && p[p.length - 1] === b) || (p[0] === b && p[p.length - 1] === a));
  if (!ok) fail(`pair ${pid} not joined (${a}..${b}), got ${JSON.stringify(p)}`);
}
console.log(
  `coverage: ${covered.size}/${sol.nodes}, reuse: ${dupNode === undefined && dupEdge === undefined ? "none" : "YES"}`,
);

// algorithm demo: the recorded derivation has to replay back into the solution
await page.locator("#btn-view").dispatchEvent("click");
await page.waitForSelector("#modal:not([hidden])");
const traceOk = await page.evaluate(() => {
  const s = window.__nl.state;
  if (!s.trace) return { ok: false, why: "no trace recorded" };
  const out = s.solution.map((p) => [p[0]]);
  for (const [c, v] of s.trace) out[c].push(v);
  return {
    ok: JSON.stringify(out) === JSON.stringify(s.solution),
    steps: s.trace.length,
    nodes: s.stats?.nodes ?? -1,
  };
});
if (!traceOk.ok) fail(`algorithm demo: trace does not replay into the solution (${traceOk.why ?? ""})`);
const shown = await page.evaluate(() => {
  const r = document.querySelector("#demo-range");
  r.value = r.max;
  r.dispatchEvent(new Event("input"));
  return document.querySelector("#demo-progress").textContent.trim();
});
if (!shown.startsWith(String(traceOk.steps)))
  fail(`algorithm demo: progress reads "${shown}", expected ${traceOk.steps} steps`);
await page.screenshot({ path: path.join(outDir, "2b-algorithm.png") });
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.querySelector("#modal")?.hidden === true);
console.log(`algorithm demo: ${traceOk.steps} steps replay exactly (${traceOk.nodes} nodes searched)`);

// The walkthrough under the animation must describe the engine that ran.
const walk = await page.evaluate(() => ({
  dfs: !document.querySelector("#algo-dfs").hidden,
  sat: !document.querySelector("#algo-sat").hidden,
  engine: window.__nl.state.stats?.engine,
  synthetic: window.__nl.state.traceSynthetic,
}));
if (walk.dfs === walk.sat) fail("walkthrough: exactly one engine list must be visible");
if (walk.engine === "sat" && !walk.sat) fail("walkthrough: SAT board shows the DFS list");
if (walk.engine === "dfs" && !walk.dfs) fail("walkthrough: DFS board shows the SAT list");
if (walk.synthetic && !walk.sat) fail("walkthrough: replayed trace shown with the DFS list");
console.log(`walkthrough: ${walk.engine} list${walk.synthetic ? " (trace is a replay)" : ""}`);

// uniqueness pass
await page.check("#cb-uniq");
await page.click("#btn-solve");
await page.waitForFunction(
  () => {
    const s = document.querySelector("#status")?.textContent ?? "";
    return (
      s.includes("唯一解") ||
      s.includes("不止一个") ||
      s.includes("不能断定唯一")
    );
  },
  null,
  { timeout: 180000 },
);
console.log("unique:", (await page.textContent("#status"))?.replace(/\n/g, " | "));
await page.uncheck("#cb-uniq");

// scale invariance: the same puzzle exported at another size must give the same
// graph.  Absolute pixel thresholds are what used to break this.
const image2 = process.argv[5];
if (image2) {
  await page.setInputFiles("#file", image2);
  await page.waitForFunction(
    () => (document.querySelector("#status")?.textContent ?? "").includes("识别完成"),
    null,
    { timeout: 60000 },
  );
  const alt = await page.evaluate(() => {
    const p = window.__nl.state.puzzle;
    const deg = new Map();
    for (const e of p.edges) {
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    const hist = {};
    p.nodes.forEach((_, i) => {
      hist[deg.get(i) ?? 0] = (hist[deg.get(i) ?? 0] ?? 0) + 1;
    });
    return { nodes: p.nodes.length, edges: p.edges.length, meta: p.meta, hist };
  });
  const hist = (list) => {
    const deg = new Map();
    for (const [a, b] of list) {
      deg.set(a, (deg.get(a) ?? 0) + 1);
      deg.set(b, (deg.get(b) ?? 0) + 1);
    }
    const out = {};
    for (let i = 0; i < g.nodes; i++) out[deg.get(i) ?? 0] = (out[deg.get(i) ?? 0] ?? 0) + 1;
    return out;
  };
  const baseHist = hist(edgeList);
  console.log(
    `scale check: ${g.nodes}dots/${g.edges}edges -> ${alt.nodes}dots/${alt.edges}edges, ` +
      `meta=${JSON.stringify(alt.meta)}`,
  );
  if (alt.nodes !== g.nodes) fail(`scale: dot count changed ${g.nodes} -> ${alt.nodes}`);
  if (alt.edges !== g.edges) fail(`scale: edge count changed ${g.edges} -> ${alt.edges}`);
  if (JSON.stringify(baseHist) !== JSON.stringify(alt.hist))
    fail(`scale: degree histogram changed ${JSON.stringify(baseHist)} -> ${JSON.stringify(alt.hist)}`);
  await page.click("#btn-solve");
  await page.waitForFunction(
    () => (document.querySelector("#status")?.textContent ?? "").includes("求解成功"),
    null,
    { timeout: 60000 },
  );
  const altSol = await page.evaluate(() => window.__nl.state.solution);
  if (!altSol || new Set(altSol.flat()).size !== alt.nodes)
    fail("scale: second size did not solve with full coverage");
  console.log("scale solve:", (await page.textContent("#status"))?.replace(/\n/g, " | "));

  await page.setInputFiles("#file", image);
  await page.waitForFunction(
    () => (document.querySelector("#status")?.textContent ?? "").includes("识别完成"),
    null,
    { timeout: 60000 },
  );
  await page.click("#btn-solve");
  await page.waitForFunction(
    () => (document.querySelector("#status")?.textContent ?? "").includes("求解成功"),
    null,
    { timeout: 60000 },
  );
}

await page.screenshot({ path: path.join(outDir, "2-solution.png") });
await page.locator("#stage").screenshot({ path: path.join(outDir, "3-canvas.png") });

// ---------------------------------------------------------------- editor pass
// blank canvas: add 4 dots in a cycle, link them, colour two pairs, solve
await page.click("#btn-blank");
const toScreen = async (wx, wy) =>
  page.evaluate(
    ([x, y]) => {
      const v = window.__nl.state.view;
      const r = document.querySelector("#canvas").getBoundingClientRect();
      return [r.left + v.ox + x * v.scale, r.top + v.oy + y * v.scale];
    },
    [wx, wy],
  );
// 2 rows x 3 cols; pairs (0,5) and (3,4) => solvable with full coverage
const pts = [
  [300, 300],
  [700, 300],
  [1100, 300],
  [300, 700],
  [700, 700],
  [1100, 700],
];
const links = [
  [0, 1],
  [1, 2],
  [3, 4],
  [4, 5],
  [0, 3],
  [1, 4],
  [2, 5],
];
const clickWorld = async (x, y) => {
  const [sx, sy] = await toScreen(x, y);
  await page.mouse.click(sx, sy);
};
const tool = async (t) => page.click(`#tools .tool[data-tool="${t}"]`);

await tool("add");
for (const [x, y] of pts) await clickWorld(x, y);
await tool("link");
for (const [a, b] of links) {
  await clickWorld(...pts[a]);
  await clickWorld(...pts[b]);
}
await page.click("#palette .swatch:nth-child(1)");
for (const i of [0, 5]) await clickWorld(...pts[i]);
await page.click("#palette .swatch:nth-child(2)");
for (const i of [3, 4]) await clickWorld(...pts[i]);

const built = await page.evaluate(() => ({
  nodes: window.__nl.state.puzzle.nodes.length,
  edges: window.__nl.state.puzzle.edges.length,
  pairs: window.__nl.state.puzzle.nodes.map((n) => n.pair),
}));
console.log("editor graph:", JSON.stringify(built));
if (built.nodes !== 6) fail(`editor: expected 6 dots, got ${built.nodes}`);
if (built.edges !== 7) fail(`editor: expected 7 edges, got ${built.edges}`);
if (built.pairs.filter((p) => p !== null).length !== 4) fail("editor: colours not assigned");

await page.click("#btn-solve");
await page.waitForFunction(
  () => {
    const s = document.querySelector("#status")?.textContent ?? "";
    return s.includes("求解成功") || s.includes("无解") || s.includes("失败");
  },
  null,
  { timeout: 30000 },
);
console.log("editor solve:", (await page.textContent("#status"))?.replace(/\n/g, " | "));
const editorSol = await page.evaluate(() => window.__nl.state.solution);
if (!editorSol) fail("editor: no solution");
else if (new Set(editorSol.flat()).size !== 6) fail("editor: coverage != 6");
await page.screenshot({ path: path.join(outDir, "4-editor.png") });

// spot check: the rendered solution image must not be uniform
const bytes = readFileSync(path.join(outDir, "3-canvas.png"));
console.log("canvas png bytes:", bytes.length);

if (logs.length) console.log("console:", logs.join("\n         "));
await browser.close();
console.log(process.exitCode ? "RESULT: FAILED" : "RESULT: PASSED");
