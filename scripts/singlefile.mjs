/** Inline dist/ into one self-contained HTML file you can just double-click. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const assets = path.join(dist, "assets");
let html = readFileSync(path.join(dist, "index.html"), "utf8");

const files = readdirSync(assets);
const css = files.filter((f) => f.endsWith(".css"));
const js = files.filter((f) => f.endsWith(".js"));

for (const f of css) {
  const body = readFileSync(path.join(assets, f), "utf8");
  html = html.replace(
    new RegExp(`<link[^>]*href="[^"]*${f}"[^>]*>`),
    `<style>\n${body}\n</style>`,
  );
}
for (const f of js) {
  const body = readFileSync(path.join(assets, f), "utf8");
  html = html.replace(
    new RegExp(`<script[^>]*src="[^"]*${f}"[^>]*></script>`),
    `<script type="module">\n${body}\n</script>`,
  );
}

const leftovers = [...html.matchAll(/(?:href|src)="([^"]*assets\/[^"]*)"/g)].map((m) => m[1]);
if (leftovers.length) {
  console.error("leftover external references — inlining failed:", leftovers);
  process.exit(1);
}

const out = path.resolve("linkr-solver.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} kB)`);
