// More things a run can record (D-093): simulated days, the game's scheduled notifications,
// currency earned (for economy pacing), the store listing, and the agent's own design review.
// Everything lands in run.json or a .jsonl next to it and goes to Gamedexy inside the stats of
// map_finish_run. Pure helpers here; the commands that touch a device live in map.mjs.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scrub } from "./hints.mjs";

// ---- days -------------------------------------------------------------------------------

/** "1-7" or "1,2,3,7" -> [1,2,3,7]. Days are 1-based: day 1 is install day. At most 30. */
export function parseDays(s) {
  const out = new Set();
  for (const part of String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) throw new Error('--days takes "1-7" or "1,2,3,7"');
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    if (a < 1 || b < a || b > 30) throw new Error("--days must be between 1 and 30, low to high");
    for (let d = a; d <= b; d++) out.add(d);
  }
  if (!out.size) throw new Error('--days takes "1-7" or "1,2,3,7"');
  return [...out].sort((x, y) => x - y);
}

/** Debug state for simulated day N: the game's clock runs N-1 days ahead (`clock=2d`). */
export const clockState = (day, extra) => [`clock=${day - 1}d`, ...(extra ? [extra] : [])].join(",");

// ---- notifications ---------------------------------------------------------------------------

const TRIGGERS = new Set(["interval", "calendar", "location", "push", "unknown"]);

/** One notification, from the device dump or from the agent's reading of the code. */
export function cleanNotification(n, source) {
  if (!n || typeof n !== "object") return null;
  const t = n.trigger && typeof n.trigger === "object" ? n.trigger : {};
  const type = TRIGGERS.has(t.type) ? t.type : "unknown";
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const out = {
    id: String(n.id ?? n.identifier ?? "").slice(0, 80),
    title: String(n.title ?? "").slice(0, 120),
    body: String(n.body ?? "").slice(0, 240),
    source,
    trigger: {
      type,
      ...(num(t.seconds) !== undefined ? { seconds: num(t.seconds) } : {}),
      ...(num(t.hour) !== undefined ? { hour: num(t.hour) } : {}),
      ...(num(t.minute) !== undefined ? { minute: num(t.minute) } : {}),
      ...(num(t.weekday) !== undefined ? { weekday: num(t.weekday) } : {}),
      ...(t.repeats ? { repeats: true } : {}),
      ...(typeof t.next === "string" ? { next: t.next.slice(0, 30) } : {}),
    },
    // From code: when it is scheduled and what cancels it, in the agent's plain words.
    ...(n.when ? { when: scrub(n.when, 200) } : {}),
    ...(n.condition ? { condition: scrub(n.condition, 200) } : {}),
    ...(n.where ? { where: scrub(n.where, 160) } : {}),
  };
  return out.id || out.title || out.body ? out : null;
}

/** The debug dump the game writes (see the skill): {"at": ISO, "pending": [...]}. */
export function readDump(path) {
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, "utf8"));
  const pending = (Array.isArray(j.pending) ? j.pending : []).map((n) => cleanNotification(n, "device")).filter(Boolean);
  return { at: typeof j.at === "string" ? j.at : null, pending };
}

// ---- economy -----------------------------------------------------------------------------------

export const EARN_PER = ["run", "level", "day", "ad", "session", "other"];
export function earnRow({ currency, amount, per, note, step }) {
  const c = String(currency ?? "").trim().toLowerCase();
  const a = Number(amount);
  if (!/^[a-z][\w -]{0,30}$/.test(c)) throw new Error("--currency is the currency's name, e.g. coins");
  if (!Number.isFinite(a) || a < 0 || a > 1e9) throw new Error("--amount must be a number");
  const p = String(per ?? "run");
  if (!EARN_PER.includes(p)) throw new Error(`--per must be one of: ${EARN_PER.join(", ")}`);
  return { currency: c, amount: a, per: p, ...(note ? { note: scrub(note, 160) } : {}), ...(step ? { step } : {}) };
}

// ---- store listing ---------------------------------------------------------------------------

/** fastlane metadata in the repo: name, subtitle, description and screenshots for one locale. */
export function fastlaneListing(src, locale = "en-US") {
  const base = ["fastlane/metadata", "metadata"].map((d) => join(src, d, locale)).find((p) => existsSync(p));
  if (!base) return androidListing(src, locale);
  const read = (f) => (existsSync(join(base, f)) ? readFileSync(join(base, f), "utf8").trim() : "");
  const shotsDir = ["fastlane/screenshots", "screenshots"].map((d) => join(src, d, locale)).find((p) => existsSync(p));
  const shots = shotsDir ? readdirSync(shotsDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => join(shotsDir, f)) : [];
  return { source: "fastlane", name: read("name.txt"), subtitle: read("subtitle.txt"), description: read("description.txt"), keywords: read("keywords.txt"), promo: read("promotional_text.txt"), shots };
}

/** Word overlap between two texts (store screenshot vs a captured screen). */
export function overlap(a, b) {
  const w = (t) => new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2));
  const A = w(a);
  const B = w(b);
  if (A.size < 2 || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return Math.round((n / A.size) * 100) / 100;
}

// ---- the agent's design review -------------------------------------------------------------------

export const CRITIQUE_AREAS = ["onboarding", "clarity", "hierarchy", "feedback", "monetization", "accessibility", "delight", "other"];
export function cleanCritique(list) {
  if (!Array.isArray(list)) throw new Error("The critique file must hold a JSON array");
  return list.slice(0, 20).map((c, i) => {
    const area = CRITIQUE_AREAS.includes(c?.area) ? c.area : "other";
    const sev = ["high", "medium", "low"].includes(c?.severity) ? c.severity : "medium";
    const finding = scrub(c?.finding, 400);
    const suggestion = scrub(c?.suggestion, 400);
    if (finding.length < 5 || suggestion.length < 5) throw new Error(`Item ${i + 1} needs a finding and a suggestion`);
    return {
      area, severity: sev, finding, suggestion,
      ...(Number.isInteger(c.step) ? { step: c.step } : {}),
      ...(typeof c.screen_key === "string" ? { screen_key: c.screen_key.slice(0, 60) } : {}),
      ...(Array.isArray(c.library) ? { library: c.library.slice(0, 4).map((x) => String(x).slice(0, 80)) } : {}),
    };
  });
}

/** fastlane supply's Google Play layout: fastlane/metadata/android/<locale>/. */
export function androidListing(src, locale = "en-US") {
  const base = ["fastlane/metadata/android", "metadata/android"].map((d) => join(src, d, locale)).find((p) => existsSync(p));
  if (!base) return null;
  const read = (f) => (existsSync(join(base, f)) ? readFileSync(join(base, f), "utf8").trim() : "");
  const shotsDir = join(base, "images", "phoneScreenshots");
  const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => join(shotsDir, f)) : [];
  return { source: "fastlane", name: read("title.txt"), subtitle: read("short_description.txt"), description: read("full_description.txt"), keywords: "", promo: "", shots };
}
