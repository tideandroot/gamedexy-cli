// Measurements the agent cannot see by looking: how long screens take to settle, how fast
// the game starts, text size and contrast, where text sits relative to the Dynamic Island
// and home indicator, the screen's palette, and the app's size. All computed locally from
// screenshots that already exist; only numbers go to Gamedexy (in map_finish_run's stats).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const lum = (r, g, b) => {
  const c = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};

/** WCAG contrast ratio between the text and its background inside one box (pixels). */
export function boxContrast(img, box) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(img.width, Math.ceil(box.x1));
  const y1 = Math.min(img.height, Math.ceil(box.y1));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 2500)));
  const ls = [];
  for (let y = y0; y < y1; y += step)
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * 4;
      ls.push(lum(img.data[i], img.data[i + 1], img.data[i + 2]));
    }
  if (ls.length < 8) return null;
  ls.sort((a, b) => a - b);
  // Glyphs are the minority of pixels in a text box: compare the extremes, not the mean.
  const dark = ls[Math.floor(ls.length * 0.08)];
  const light = ls[Math.floor(ls.length * 0.92)];
  return Math.round(((light + 0.05) / (dark + 0.05)) * 10) / 10;
}

/** Up to six dominant colours as hex, most common first. */
export function palette(img, max = 6) {
  const buckets = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 6000)));
  for (let y = 0; y < img.height; y += step)
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      const key = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
      const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      b.n++;
      b.r += img.data[i];
      b.g += img.data[i + 1];
      b.b += img.data[i + 2];
      buckets.set(key, b);
    }
  const total = [...buckets.values()].reduce((n, b) => n + b.n, 0);
  const picked = [];
  for (const b of [...buckets.values()].sort((a, c) => c.n - a.n)) {
    const c = [b.r / b.n, b.g / b.n, b.b / b.n].map(Math.round);
    if (picked.some((p) => Math.abs(p.c[0] - c[0]) + Math.abs(p.c[1] - c[1]) + Math.abs(p.c[2] - c[2]) < 60)) continue;
    picked.push({ c, share: b.n / total });
    if (picked.length >= max) break;
  }
  return picked.filter((p) => p.share >= 0.01).map((p) => "#" + p.c.map((v) => v.toString(16).padStart(2, "0")).join(""));
}

/**
 * Cold start: from the launch command to the first moment the game shows readable text that
 * holds steady across two screenshots (animated games never hold still pixel for pixel, so text
 * is the signal). Screenshots take most of a second, so this is accurate to about one second.
 */
export async function coldStart(grabText, launch, { maxMs = 45000 } = {}) {
  const t0 = Date.now();
  launch();
  let prev = null;
  let prevAt = t0;
  while (Date.now() - t0 < maxMs) {
    let words = null;
    try {
      words = new Set(grabText().flatMap((b) => String(b.text).toLowerCase().split(/\s+/)).filter((x) => x.length > 1));
    } catch {
      words = null;
    }
    // Steady = the same words twice in a row, give or take a few: animated screens (moving
    // sprites read as stray letters) never repeat exactly. Found on Gloamwick's home screen.
    // The time is when the first of the two matching frames was taken: the screen was already readable then.
    if (words?.size && prev && steady(prev, words)) return prevAt - t0;
    prev = words?.size ? words : null;
    prevAt = Date.now();
  }
  return null;
}

/** Two word sets share at least 85% of their words (and at least 3 of them). */
export function steady(a, b) {
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common >= 3 && common / Math.max(a.size, b.size) >= 0.85;
}

/** On-disk size of a built app or APK, in MB. */
export function appSizeMb(path) {
  if (!path || !existsSync(path)) return null;
  let bytes = 0;
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    else bytes += st.size;
  };
  walk(path);
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

/** Per-step layout facts in points: text boxes with size and contrast, plus the palette. */
export function layoutOf(img, boxes, scale) {
  const text = [];
  for (const b of boxes) {
    const t = String(b.text ?? "").trim();
    if (!t) continue;
    text.push([
      Math.round(b.x0 / scale), Math.round(b.y0 / scale),
      Math.round((b.x1 - b.x0) / scale), Math.round((b.y1 - b.y0) / scale),
      boxContrast(img, b), t.slice(0, 32),
    ]);
  }
  return { w: Math.round(img.width / scale), h: Math.round(img.height / scale), palette: palette(img), text };
}
