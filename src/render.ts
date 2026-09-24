import { nodeColor, type Puzzle } from "./types";

export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export interface Scene {
  image: CanvasImageSource | null;
  paths: number[][] | null;
  hoverNode: number | null;
  hoverEdge: number | null;
  pendingLink: { from: number; to: [number, number] } | null;
  showOverlay: boolean;
  /** Draw faint lattice edges underneath a solution, for the algorithm demo. */
  ghostEdges?: boolean;
}

export function drawScene(
  canvas: HTMLCanvasElement,
  puzzle: Puzzle,
  scene: Scene,
  view: View,
  dpr: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0e0e12";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(
    dpr * view.scale,
    0,
    0,
    dpr * view.scale,
    dpr * view.ox,
    dpr * view.oy,
  );

  if (scene.image) {
    ctx.drawImage(scene.image, 0, 0, puzzle.width, puzzle.height);
  }

  // ---- edges ---------------------------------------------------------------
  ctx.lineCap = "round";
  if (!scene.paths || scene.ghostEdges) {
    const drawDetected = scene.showOverlay;
    ctx.strokeStyle = scene.ghostEdges
      ? "rgba(120, 120, 135, 0.28)"
      : drawDetected
        ? "rgba(70, 220, 150, 0.55)"
        : "rgba(150, 150, 160, 0.7)";
    ctx.lineWidth = scene.ghostEdges ? 9 : 6;
    ctx.beginPath();
    for (let i = 0; i < puzzle.edges.length; i++) {
      if (i === scene.hoverEdge) continue;
      const e = puzzle.edges[i];
      const a = puzzle.nodes[e.a];
      const b = puzzle.nodes[e.b];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    if (scene.hoverEdge !== null && puzzle.edges[scene.hoverEdge]) {
      const e = puzzle.edges[scene.hoverEdge];
      const a = puzzle.nodes[e.a];
      const b = puzzle.nodes[e.b];
      ctx.strokeStyle = "rgba(255, 90, 90, 0.95)";
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // ---- solution ------------------------------------------------------------
  if (scene.paths) {
    for (let c = 0; c < scene.paths.length; c++) {
      const path = scene.paths[c];
      if (path.length < 2) continue;
      const col = nodeColor(puzzle.nodes[path[0]]);
      const rgb = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.strokeStyle = rgb;
      ctx.lineWidth = puzzle.nodes[path[0]].r * 0.62;
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const n = puzzle.nodes[path[i]];
        if (i === 0) ctx.moveTo(n.x, n.y);
        else ctx.lineTo(n.x, n.y);
      }
      ctx.stroke();
      ctx.fillStyle = rgb;
      for (const idx of path) {
        const n = puzzle.nodes[idx];
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 0.62, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---- nodes ---------------------------------------------------------------
  // once a solution is on screen the markers shrink so they do not fight the paths
  const marker = scene.paths ? 0.42 : 0.92;
  for (let i = 0; i < puzzle.nodes.length; i++) {
    const n = puzzle.nodes[i];
    const col = nodeColor(n);
    const rgb = `rgb(${col[0]},${col[1]},${col[2]})`;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r * marker, 0, Math.PI * 2);
    ctx.fillStyle =
      n.pair !== null
        ? `rgba(${col[0]},${col[1]},${col[2]},0.28)`
        : `rgba(0,0,0,${scene.paths ? 0.55 : 0.3})`;
    ctx.fill();
    ctx.lineWidth = n.r * (n.pair !== null ? 0.16 : 0.09);
    ctx.strokeStyle = n.pair !== null ? rgb : "rgba(215,215,235,0.45)";
    ctx.stroke();
    if (i === scene.hoverNode) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * 1.15, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke();
    }
  }

  // ---- pending link --------------------------------------------------------
  if (scene.pendingLink) {
    const a = puzzle.nodes[scene.pendingLink.from];
    const [tx, ty] = scene.pendingLink.to;
    ctx.setLineDash([12, 10]);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * Fit the *lattice*, not the image: on a full-page game screenshot the board is
 * only part of the picture, and fitting the whole image leaves the puzzle small
 * and off to one side.
 */
/** Bounding box of the lattice itself, which is not the whole image. */
export function latticeBounds(puzzle: Puzzle): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  if (!puzzle.nodes.length) return { x0: 0, y0: 0, x1: puzzle.width, y1: puzzle.height };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of puzzle.nodes) {
    x0 = Math.min(x0, n.x - n.r);
    y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r);
    y1 = Math.max(y1, n.y + n.r);
  }
  if (!(x1 > x0 && y1 > y0)) return { x0: 0, y0: 0, x1: puzzle.width, y1: puzzle.height };
  return { x0, y0, x1, y1 };
}

export function fitView(puzzle: Puzzle, cw: number, ch: number, pad = 24): View {
  const { x0, y0, x1, y1 } = latticeBounds(puzzle);
  if (!(x1 > x0 && y1 > y0)) return { scale: 1, ox: 0, oy: 0 };
  const bw = x1 - x0;
  const bh = y1 - y0;
  const scale = Math.max(
    0.01,
    Math.min((cw - pad * 2) / bw, (ch - pad * 2) / bh),
  );
  return {
    scale,
    ox: (cw - bw * scale) / 2 - x0 * scale,
    oy: (ch - bh * scale) / 2 - y0 * scale,
  };
}
