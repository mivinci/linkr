/**
 * Run e2e/smoke.mjs over every screenshot in e2e/screenshots/.
 *
 *   node e2e/smoke.run.mjs            # builds dist/ only if it is missing
 *   node e2e/smoke.run.mjs --rebuild  # always rebuild
 *
 * The unit tests feed the detector synthetic masks, so they cannot catch a
 * regression on a real phone screenshot.  These two boards are the ones that
 * were reported as unsolvable, which is exactly the failure class worth
 * freezing.  A missing browser is a hard failure: that would silently drop the
 * whole vision half from `npm test`.
 */
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const shots = path.join(root, "e2e/screenshots");
const outRoot = path.join(root, "e2e/out");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

if (!existsSync(path.join(dist, "index.html")) || process.argv.includes("--rebuild")) {
  console.log("smoke: building dist/ ...");
  const r = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const server = createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // path.join collapses "..", so this cannot escape dist/
  let file = path.join(dist, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !path.extname(file)) file = path.join(dist, "index.html");
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    // the app ships content-hashed assets; never let a stale copy answer
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/`;

const images = readdirSync(shots)
  .filter((f) => /\.(png|jpe?g)$/i.test(f))
  .sort();
if (images.length === 0) {
  console.error(`FAIL: no screenshots in ${path.relative(root, shots)}`);
  server.close();
  process.exit(1);
}

// One browser launch per screenshot: detection mutates page state, and a
// shared page would let board N's residue leak into board N+1's assertion.
rmSync(outRoot, { recursive: true, force: true });
let failed = 0;
for (const f of images) {
  const out = path.join(outRoot, createHash("sha1").update(f).digest("hex").slice(0, 8));
  mkdirSync(out, { recursive: true });
  console.log(`\n=== ${f} ===`);
  // async spawn on purpose: the static server lives in *this* event loop, and
  // spawnSync would block it, so the browser would time out fetching dist/
  const code = await new Promise((ok) => {
    const kid = spawn(process.execPath, ["e2e/smoke.mjs", url, path.join(shots, f), out], {
      cwd: root,
      stdio: "inherit",
    });
    kid.on("close", ok);
  });
  if (code !== 0) failed++;
}

server.close();
console.log(
  `\nsmoke: ${images.length - failed}/${images.length} screenshots passed` +
    (failed ? " — see failures above" : ""),
);
process.exit(failed ? 1 : 0);
