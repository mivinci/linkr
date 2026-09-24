/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
 * Returns the SQUARED distance from every pixel of `mask` to the nearest
 * non-mask pixel, rounded to the nearest integer.
 */
export function edtSquared(mask: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e12;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float64Array(w * h);

  for (let i = 0; i < w * h; i++) out[i] = mask[i] ? INF : 0;

  // columns first
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    dt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  // then rows
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) f[x] = out[base + x];
    dt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) out[base + x] = d[x];
  }
  return out;
}

function dt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dist = q - v[k];
    d[q] = dist * dist + f[v[k]];
  }
}
