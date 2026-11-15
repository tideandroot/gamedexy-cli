// Perceptual hash (DCT pHash, 64 bits as 16 hex characters), the same method
// as Python's imagehash.phash: 32x32 grayscale, 2D DCT, top-left 8x8, bits set
// where the coefficient is above the median.
import { grayGrid } from "./png.mjs";

function dct1d(v) {
  const n = v.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += v[i] * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
    out[k] = 2 * s;
  }
  return out;
}

export function phash(img) {
  const N = 32;
  const g = grayGrid(img, N);
  const rows = new Float64Array(N * N);
  for (let y = 0; y < N; y++) rows.set(dct1d(g.subarray(y * N, (y + 1) * N)), y * N);
  const low = [];
  for (let x = 0; x < 8; x++) {
    const col = new Float64Array(N);
    for (let y = 0; y < N; y++) col[y] = rows[y * N + x];
    const d = dct1d(col);
    for (let y = 0; y < 8; y++) low[y * 8 + x] = d[y];
  }
  const sorted = [...low].sort((a, b) => a - b);
  const med = (sorted[31] + sorted[32]) / 2;
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nib = 0;
    for (let b = 0; b < 4; b++) nib = (nib << 1) | (low[i + b] > med ? 1 : 0);
    hex += nib.toString(16);
  }
  return hex;
}

export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export function normText(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Loose text match: OCR of the same screen differs run to run ("HOLD" vs "HOlD"). */
export function sameText(a, b) {
  const x = normText(a), y = normText(b);
  if (x === y) return true;
  if (!x || !y) return false;
  // Similarity from the longest common subsequence, cheap enough for screen text.
  const n = x.length, m = y.length;
  if (Math.abs(n - m) / Math.max(n, m) > 0.2) return false;
  let prev = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const cur = new Uint16Array(m + 1);
    for (let j = 1; j <= m; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return (2 * prev[m]) / (n + m) >= 0.9;
}

export const NEAR_SAME = 4;
export const SAME_TEXT = 12;

/** Screen this capture repeats (earlier new step), or null if it is new. */
export function matchScreen(hash, text, steps) {
  for (const s of steps) {
    if (!s.new) continue;
    const d = hamming(hash, s.phash);
    if (d <= NEAR_SAME || (d <= SAME_TEXT && sameText(text, s.text))) return s.screen;
  }
  return null;
}
