export type RGB = [number, number, number];

/** A dot on the board. `pair` is a colour-class id shared by exactly two dots. */
export interface PNode {
  x: number;
  y: number;
  r: number;
  pair: number | null;
  rgb: RGB | null;
}

export interface PEdge {
  a: number;
  b: number;
  /** Set when the pixel test rejected the edge and `completeEdges` added it
   *  back because the board's structure requires it.  Drawn dashed. */
  inferred?: boolean;
}

/** Scale-dependent values derived from the image, for display and debugging. */
export interface PuzzleMeta {
  radius: number;
  minDist: number;
  maxHole: number;
  spacing: number;
  spread: number;
  /** Page furniture dropped by the radius-consistency filter. */
  dropped: number;
  /** Edges the pixel test missed and `completeEdges` added back. */
  inferred: number;
}

export interface Puzzle {
  nodes: PNode[];
  edges: PEdge[];
  width: number;
  height: number;
  meta?: PuzzleMeta;
}

/**
 * Palette used for manual colour assignment.  Detected pairs keep their real
 * colour in `rgb`, so the palette only needs to be long enough for hand-drawn
 * boards — the pair id is an identity, not a palette index.
 */
export const PALETTE: RGB[] = [
  [229, 57, 53],
  [30, 108, 232],
  [67, 160, 71],
  [0, 172, 193],
  [142, 68, 220],
  [235, 160, 20],
  [27, 94, 32],
  [216, 60, 150],
  [141, 85, 52],
  [0, 131, 143],
  [57, 73, 171],
  [124, 179, 66],
];

export function nodeColor(node: PNode): RGB {
  if (node.rgb) return node.rgb;
  if (node.pair !== null) return PALETTE[node.pair % PALETTE.length];
  return [150, 150, 160];
}

export const EMPTY_PUZZLE: Puzzle = { nodes: [], edges: [], width: 0, height: 0 };
