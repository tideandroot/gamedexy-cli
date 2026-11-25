// `gamedexy codex ...`: the Game Codex. A catalog of what a game contains (dice, enemies, bosses,
// upgrades, perks, items, areas, quests...), read from the game's own code with plain static
// reading: no AI, nothing uploaded until `codex send`. Every entry keeps where it is defined
// (file:line), so a developer or their agent can jump to it. A game-side render hook can add a
// small picture of each entry (`codex render`). docs/game-codex.md has the design.
//
// Adapters, each heuristic and each marked in the entry's `found_by`:
//   gd-const    top-level `const NAME := [ {...}, ... ]` or `{ KEY: {...} }` tables of dictionaries
//   gd-ctor     calls of a project `make_x("Name", ...)` / `create_x("Name", ...)` that returns a Dictionary
//   gd-match    `match kind:` blocks whose string arms set the same stats (`"brute": hp = 165.0; ...`)
//   embedded    a `boss_name` field plus other `boss_*` fields inside an entry becomes its own entry
//   json        data files: a top-level array (or object of arrays) of objects with a name or id
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveGame } from "./games.mjs";
import { stripComments, walk } from "./scan.mjs";

export const CODEX_SCHEMA = "gamedexy.codex/1";
export const IMAGES_SCHEMA = "gamedexy.codex-images/1";
const MAX_BYTES = 1_000_000;
const MAX_ENTRIES = 1000;
// Tests, vendored addons, experiments and Gamedexy's own files (hooks, codex output kept in a gamedexy/ folder).
const TEST_PATH = /(^|\/)(tests?|Tests?|test_\w+|addons|experiments|prototypes?|gamedexy)(\/|$)|(^|\/)gamedexy_\w+\.gd$/;

// ---- secrets and personal data ---------------------------------------------------------------
// The codex is uploaded, so nothing that looks like a credential or an e-mail address may get into
// it. Two filters, the same in the server's cleanCodex (apps/web/src/lib/game-map/codex.ts):
// fields whose name looks sensitive, and values that look like keys whatever their field is called.

/** A field name that carries credentials or personal data (api_key, serverToken, "Auth header"...). */
const SENSITIVE_KEY = /(secret|token|passw|pwd|api_?key|access_?key|private|credential|(^|_)cert|auth(?!or)|e_?mail|webhook|bearer|cookie|passphrase|passcode|hmac|(^|_)pw($|_)|^pass$|(user|admin|db|root|login|account|wifi)_?pass($|_)|(^|_)salt$|(^|_)(phone|telephone|tel)(_?(number|no|num))?$|(session|license|signing|encryption|master|client)_?key($|_))/i;
/** Numbers are game stats ("tokens", "auth_level"); only clearly secret names drop a number. */
const SECRET_NUMBER_KEY = /(secret|passw|pwd|api_?key|access_?key|private|credential|(^|_)pin($|_)|passphrase|passcode|hmac|(^|_)pw($|_)|^pass$|(user|admin|db|root|login|account|wifi)_?pass($|_)|(^|_)(phone|telephone|tel)(_?(number|no|num))?$|(session|license|signing|encryption|client)_?key($|_))/i;
const SECRET_VALUES = [
  /-----BEGIN [A-Z ]+-----/, // PEM blocks
  /\beyJ[A-Za-z0-9_-]{17,}/, // JWT
  /\b[spr]k_(live|test)_[A-Za-z0-9]{8,}/, // Stripe
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI-style
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // URL with user:password
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, // e-mail address
  /\b[0-9a-fA-F]{32,}\b/, // long hex
];

const keyWords = (k) => String(k ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s.-]+/g, "_");
export const sensitiveKey = (k, numeric = false) => (numeric ? SECRET_NUMBER_KEY : SENSITIVE_KEY).test(keyWords(k));

/** A phone number: "+1 555 123 4567", "(555) 123-4567", "+15551234567" (10 or more digits, grouped like a number). */
function looksLikePhone(s) {
  if (/\+\d{10,15}\b/.test(s)) return true;
  const m = s.match(/(\+\d{1,3}[\s.-]?)?(\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/);
  return Boolean(m) && m[0].replace(/\D/g, "").length >= 10;
}

/** A value that looks like a key, a token, a private key or an e-mail address. */
export function looksLikeSecret(v) {
  const s = String(v ?? "");
  if (SECRET_VALUES.some((re) => re.test(s))) return true;
  // The same patterns once the separators of a split value are gone: ["sk_live_51Hx", "AbCdEf12"], "sk_live_" + "..."
  if (s.length <= 400) {
    const squashed = s.replace(/["'`,+·\s\[\]]+/g, "");
    if (squashed !== s && SECRET_VALUES.some((re) => re.test(squashed))) return true;
  }
  if (looksLikePhone(s)) return true;
  // A long base64-like run with upper case, lower case and digits.
  for (const m of s.matchAll(/[A-Za-z0-9+=_-]{32,}/g)) if (/[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /[0-9]/.test(m[0])) return true;
  return false;
}

/**
 * Drop facts and numbers that look sensitive, a description that looks like a key, and the whole
 * entry when its name or key does. Returns the entry (or null) and how many fields went.
 */
export function scrubEntry(e) {
  if (looksLikeSecret(e.name) || looksLikeSecret(e.key) || looksLikeSecret(e.id)) return { entry: null, removed: 1 };
  let removed = 0;
  const numbers = (e.numbers ?? []).filter((n) => {
    const numeric = typeof n.value === "number";
    const bad = sensitiveKey(n.label, numeric) || (!numeric && looksLikeSecret(n.value)) || (n.raw != null && looksLikeSecret(n.raw));
    if (bad) removed++;
    return !bad;
  });
  const facts = (e.facts ?? []).filter((f) => {
    const bad = sensitiveKey(f.label) || looksLikeSecret(f.value);
    if (bad) removed++;
    return !bad;
  });
  const out = { ...e, numbers, facts };
  if (e.what && looksLikeSecret(e.what)) {
    removed++;
    out.what = null;
    out.needs_description = true;
    delete out.what_from;
    delete out.recheck;
  }
  return { entry: out, removed };
}

// ---- categories ------------------------------------------------------------------------

/** Order matters: the first rule whose pattern matches the table, function or field name wins. */
const CATEGORY_RULES = [
  [/boss/, "bosses"],
  [/suit|face/, "dice_faces"],
  [/dice|\bdie\b|_die\b|^die/, "dice"],
  [/enem|mob|monster|creep|foe|spawn|minion/, "enemies"],
  [/companion|buddy|buddies|pet|ally|allies|helper/, "companions"],
  [/upgrade|workshop/, "upgrades"],
  [/perk|buff|relic|trait|talent|skill|abilit|power_?up|boon/, "perks"],
  [/skin|cosmetic|outfit|chassis|costume/, "cosmetics"],
  [/weapon|gun|projectile|attack|spell/, "weapons"],
  [/rarit|tier|grade/, "rarities"],
  [/collect|item|loot|treasure|relic|trinket|find/, "items"],
  [/chest|reward|milestone|prize|pity/, "rewards"],
  [/quest|mission|achiev|goal|task|objective/, "quests"],
  [/zone|stage|level|area|biome|world|region|chapter/, "areas"],
  [/currenc|coin|gem|gold/, "currencies"],
  [/mode/, "modes"],
  [/pad|build|structure|station|building/, "buildings"],
  [/unlock/, "unlocks"],
  [/card/, "cards"],
  [/combo|hand/, "combos"],
];

export const CATEGORY_LABELS = {
  dice: "Dice",
  dice_faces: "Dice faces",
  enemies: "Enemies",
  bosses: "Bosses",
  companions: "Companions",
  upgrades: "Upgrades",
  perks: "Perks",
  cosmetics: "Cosmetics",
  weapons: "Weapons",
  rarities: "Rarities",
  items: "Items",
  rewards: "Rewards",
  quests: "Quests",
  areas: "Areas",
  currencies: "Currencies",
  modes: "Modes",
  buildings: "Buildings",
  unlocks: "Unlocks",
  cards: "Cards",
  combos: "Combos",
};

export function guessCategory(...names) {
  for (const raw of names) {
    if (!raw) continue;
    const n = String(raw).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    for (const [re, cat] of CATEGORY_RULES) if (re.test(n)) return cat;
  }
  return null;
}

/** A label for a category key the rules do not know: SPECIAL_THINGS -> "Special things". */
export const categoryLabel = (key) => CATEGORY_LABELS[key] ?? humanize(key);

// ---- small text helpers --------------------------------------------------------------------

export function humanize(s) {
  const t = String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

export function slug(s) {
  return (
    String(s ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "x"
  );
}

const clip = (s, n) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---- GDScript literal parser -------------------------------------------------------------------
// A small recursive-descent reader for the literal part of GDScript (and close enough to JSON):
// arrays, dictionaries ("k": v and k = v), strings, numbers, true/false/null, calls such as
// Color(1, 0, 0) or make_face(Suit.CANNON, 2), dotted references, and anything else as a raw
// expression that keeps its leading number (36.0 * hp_m -> 36).

const PUNCT = new Set(["[", "]", "{", "}", "(", ")", ",", ":", "="]);

export function tokenize(text, from = 0, to = text.length) {
  const toks = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < to && text[j] !== c) {
        if (text[j] === "\\" && j + 1 < to) {
          const e = text[j + 1];
          v += e === "n" ? "\n" : e === "t" ? "\t" : e === "u" ? String.fromCharCode(parseInt(text.slice(j + 2, j + 6), 16) || 63) : e;
          j += e === "u" ? 6 : 2;
        } else v += text[j++];
      }
      toks.push({ t: "str", v, at: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = /^(0x[0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+(?:[eE][-+]?[0-9]+)?)/.exec(text.slice(i, Math.min(to, i + 40)));
      const raw = m ? m[0] : c;
      toks.push({ t: "num", v: Number(raw.replace(/_/g, "")), at: i });
      i += raw.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i, Math.min(to, i + 200)));
      toks.push({ t: "id", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (c === ":" && text[i + 1] === "=") {
      toks.push({ t: "op", v: ":=", at: i });
      i += 2;
      continue;
    }
    if (PUNCT.has(c)) {
      // "==" is a comparison, not a dictionary's "=".
      if (c === "=" && text[i + 1] === "=") {
        toks.push({ t: "op", v: "==", at: i });
        i += 2;
        continue;
      }
      toks.push({ t: c, at: i });
      i++;
      continue;
    }
    toks.push({ t: "op", v: c, at: i });
    i++;
  }
  return toks;
}

/** Parse one value starting at token k. Returns [value, nextK]. Values carry `at` (text index). */
export function parseValue(toks, k, text) {
  const tok = toks[k];
  if (!tok) return [{ t: "none" }, k];
  let v;
  let n = k + 1;
  if (tok.t === "[") {
    const items = [];
    n = k + 1;
    while (toks[n] && toks[n].t !== "]") {
      const [item, nn] = parseValue(toks, n, text);
      if (nn === n) break;
      items.push(item);
      n = nn;
      if (toks[n]?.t === ",") n++;
      else if (toks[n]?.t !== "]") n = skipTo(toks, n, [",", "]"]) + (toks[skipTo(toks, n, [",", "]"])]?.t === "," ? 1 : 0);
    }
    v = { t: "array", items, at: tok.at };
    n++;
  } else if (tok.t === "{") {
    const items = [];
    n = k + 1;
    while (toks[n] && toks[n].t !== "}") {
      const keyTok = toks[n];
      let key;
      let nn;
      if (keyTok.t === "id" && toks[n + 1]?.t === "=") {
        key = { t: "str", v: keyTok.v, at: keyTok.at };
        nn = n + 1;
      } else {
        [key, nn] = parseValue(toks, n, text);
        if (nn === n) break;
      }
      if (toks[nn]?.t !== ":" && toks[nn]?.t !== "=") {
        n = skipTo(toks, nn, [",", "}"]);
        if (toks[n]?.t === ",") n++;
        continue;
      }
      const [val, after] = parseValue(toks, nn + 1, text);
      items.push({ key, value: val, at: keyTok.at });
      n = after;
      if (toks[n]?.t === ",") n++;
      else if (toks[n]?.t !== "}") {
        n = skipTo(toks, n, [",", "}"]);
        if (toks[n]?.t === ",") n++;
      }
    }
    v = { t: "dict", items, at: tok.at };
    n++;
  } else if (tok.t === "str") v = { t: "str", v: tok.v, at: tok.at };
  else if (tok.t === "num") v = { t: "num", v: tok.v, at: tok.at };
  else if (tok.t === "op" && tok.v === "-" && toks[k + 1]?.t === "num") {
    v = { t: "num", v: -toks[k + 1].v, at: tok.at };
    n = k + 2;
  } else if (tok.t === "id") {
    if (tok.v === "true" || tok.v === "false") v = { t: "bool", v: tok.v === "true", at: tok.at };
    else if (tok.v === "null") v = { t: "null", at: tok.at };
    else if (toks[k + 1]?.t === "(") {
      const args = [];
      n = k + 2;
      while (toks[n] && toks[n].t !== ")") {
        const [a, nn] = parseValue(toks, n, text);
        if (nn === n) break;
        args.push(a);
        n = nn;
        if (toks[n]?.t === ",") n++;
        else if (toks[n]?.t !== ")") n = skipTo(toks, n, [",", ")"]) + (toks[skipTo(toks, n, [",", ")"])]?.t === "," ? 1 : 0);
      }
      v = { t: "call", name: tok.v, args, at: tok.at };
      n++;
    } else v = { t: "ref", v: tok.v, at: tok.at };
  } else return [{ t: "none" }, k];
  // An operator after a value makes it an expression: keep the text and the leading number.
  if (toks[n]?.t === "op" && !["==", ":="].includes(toks[n].v)) {
    const end = skipTo(toks, n, [",", "]", "}", ")"]);
    const stop = toks[end]?.at ?? text.length;
    const raw = text.slice(v.at, stop).replace(/\s+/g, " ").trim();
    return [{ t: "expr", raw: raw.slice(0, 120), lead: v.t === "num" ? v.v : null, at: v.at }, end];
  }
  return [v, n];
}

/** Index of the next token of one of these types at bracket depth 0. */
function skipTo(toks, k, types) {
  let depth = 0;
  for (let i = k; i < toks.length; i++) {
    const t = toks[i].t;
    if (depth === 0 && types.includes(t)) return i;
    if (t === "[" || t === "{" || t === "(") depth++;
    else if (t === "]" || t === "}" || t === ")") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return toks.length;
}

/** Plain JS value of a parsed literal (for tests and the JSON adapter). */
export function plain(v) {
  if (!v) return null;
  if (v.t === "array") return v.items.map(plain);
  if (v.t === "dict") return Object.fromEntries(v.items.map((it) => [String(plain(it.key)), plain(it.value)]));
  if (v.t === "call") return { call: v.name, args: v.args.map(plain) };
  if (v.t === "ref") return { ref: v.v };
  if (v.t === "expr") return { expr: v.raw };
  return v.v ?? null;
}

// ---- field roles ----------------------------------------------------------------------------------

const ID_KEYS = ["id", "key", "slug", "uid", "code"];
const NAME_KEYS = ["name", "title", "display_name", "displayName", "label", "boss_name"];
const WHAT_KEYS = ["desc", "description", "perk_desc", "effect", "effect_desc", "tooltip", "summary", "blurb", "text", "flavor", "subtitle", "hint", "details"];
const COLOR_KEYS = /^(color|colour|tint|body_color|chassis|main_color|base_color)$/;
// Fields that place or paint a thing: kept out of "key numbers".
const LAYOUT_KEYS = /(^|_)(pos|position|rect|center|centre|offset|size|radius|scale|rot|rotation|angle|x|y|z|w|h|width|height|col|color|colour|tint|rim|trim|bumper|cap|floor_a|floor_b|ground|accent|path|phase|anim|icon|sprite|texture|sound|sfx|music|scene|arrow_mode|zindex|z_index|layer)($|_)/;
const LAYOUT_CALLS = /^(Vector[234]i?|Rect2i?|Transform[23]D|Basis|Quaternion|Color|preload|load|NodePath|StringName)$/;

const numberLabel = (k) => humanize(k);

/** Godot Color(r,g,b[,a]) or Color("#hex") or Color.RED -> "#rrggbb", else null. */
export function colorHex(v) {
  if (!v) return null;
  if (v.t === "call" && v.name === "Color") {
    const a = v.args;
    if (a[0]?.t === "str" && /^#?[0-9a-f]{6}/i.test(a[0].v)) return "#" + a[0].v.replace(/^#/, "").slice(0, 6).toLowerCase();
    if (a.length >= 3 && a.slice(0, 3).every((x) => x.t === "num")) {
      return "#" + a.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x.v)) * 255).toString(16).padStart(2, "0")).join("");
    }
  }
  if (v.t === "str" && /^#[0-9a-f]{6}$/i.test(v.v)) return v.v.toLowerCase();
  return null;
}

/** A reference (DiceTypes.Suit.CANNON) as a readable word, using what the project calls it. */
function refWord(ref, ctx) {
  const last = String(ref).split(".").pop();
  return ctx.refNames.get(String(ref)) ?? ctx.refNames.get(String(ref).split(".").slice(-2).join(".")) ?? humanize(last);
}

/** Short text for a value that is not a plain number: a list, a call, a nested dictionary. */
function shortText(v, ctx, depth = 0) {
  if (!v || depth > 3) return "";
  switch (v.t) {
    case "str":
      return v.v;
    case "num":
      return fmtNum(v.v);
    case "bool":
      return v.v ? "yes" : "no";
    case "ref":
      return refWord(v.v, ctx);
    case "expr":
      return v.raw;
    case "array":
      return v.items.map((x) => shortText(x, ctx, depth + 1)).filter(Boolean).join(" · ");
    case "dict":
      return v.items
        .filter((it) => !sensitiveKey(it.key?.v))
        .map((it) => `${shortText(it.key, ctx, depth + 1)} ${shortText(it.value, ctx, depth + 1)}`)
        .join(" · ");
    case "call": {
      if (LAYOUT_CALLS.test(v.name)) return "";
      // A true flag reads as its parameter's name: make_face(Suit.CANNON, 6, true) -> "Cannon 6 upgraded".
      const params = ctx.funcParams.get(v.name.split(".").pop()) ?? [];
      return v.args
        .map((x, i) => (x.t === "bool" ? (x.v && params[i] ? humanize(params[i]).toLowerCase() : "") : shortText(x, ctx, depth + 1)))
        .filter(Boolean)
        .join(" ");
    }
    default:
      return "";
  }
}

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

// ---- entries -----------------------------------------------------------------------------------------

function fieldMap(dict) {
  const m = new Map();
  for (const it of dict.items) {
    if (it.key.t === "str" || it.key.t === "ref" || it.key.t === "num") m.set(String(it.key.v), it);
  }
  return m;
}

const strOf = (it) => (it && it.value.t === "str" ? it.value.v : null);

/**
 * One codex entry from a dictionary literal. `fallbackId` is the dictionary's key in a
 * dictionary-of-dictionaries table (an enum member or a string), or null in an array table.
 */
function entryFromDict(dict, o) {
  const { file, lineOf, category, table, ctx, fallbackId, foundBy } = o;
  const f = fieldMap(dict);
  const idIt = ID_KEYS.map((k) => f.get(k)).find((it) => it && (it.value.t === "str" || it.value.t === "num"));
  const nameIt = NAME_KEYS.map((k) => f.get(k)).find((it) => it && it.value.t === "str" && it.value.v.trim());
  const rawId = idIt ? String(idIt.value.v) : fallbackId;
  if (!nameIt && rawId == null) return null;
  const name = nameIt ? nameIt.value.v.trim() : humanize(rawId);
  const whatIt = WHAT_KEYS.map((k) => f.get(k)).find((it) => it && it.value.t === "str" && it.value.v.trim() && !looksLikeSecret(it.value.v));
  const used = new Set([idIt, nameIt, whatIt].filter(Boolean).map((it) => String(it.key.v)));

  // Embedded entities: boss_name + boss_hp + boss_xp... become a boss entry of their own.
  const embedded = [];
  const prefixes = new Map();
  for (const [k] of f) {
    const m = /^([a-z]+)_name$/.exec(k);
    if (m && m[1] !== "display" && f.get(k).value.t === "str") prefixes.set(m[1], k);
  }
  for (const [p, nameKey] of prefixes) {
    const sub = [...f.keys()].filter((k) => k.startsWith(p + "_") && k !== nameKey);
    if (sub.length < 2) continue;
    embedded.push({ prefix: p, nameKey, keys: sub });
    for (const k of [nameKey, ...sub]) used.add(k);
  }

  const numbers = [];
  const facts = [];
  let color = null;
  for (const [k, it] of f) {
    if (used.has(k)) continue;
    const v = it.value;
    if (COLOR_KEYS.test(k) && !color) color = colorHex(v);
    if (LAYOUT_KEYS.test(k)) continue;
    addField(k, v, numbers, facts, ctx);
  }
  for (const e of embedded) facts.push({ label: humanize(e.prefix), value: f.get(e.nameKey).value.v });

  // A bare number (stage 1, zone 1) only means something inside its table.
  const numeric = rawId != null && /^\d+$/.test(String(rawId));
  const entry = makeEntry({
    key: rawId == null ? slug(name) : numeric ? `${slug(table)}-${rawId}` : String(rawId),
    name,
    category,
    what: whatIt ? whatIt.value.v : null,
    numbers,
    facts,
    color,
    file,
    line: lineOf(dict.at),
    table,
    foundBy,
  });
  const out = [entry];
  for (const e of embedded) {
    const nums = [];
    const fcts = [{ label: "In", value: name }];
    for (const k of e.keys) {
      const v = f.get(k).value;
      if (LAYOUT_KEYS.test(k.slice(e.prefix.length + 1)) || LAYOUT_KEYS.test(k)) continue;
      addField(k.slice(e.prefix.length + 1), v, nums, fcts, ctx);
    }
    const kindIt = f.get(`${e.prefix}_kind`) ?? f.get(`${e.prefix}_id`);
    out.push(
      makeEntry({
        key: kindIt && kindIt.value.t === "str" ? kindIt.value.v : slug(f.get(e.nameKey).value.v),
        name: f.get(e.nameKey).value.v,
        category: guessCategory(e.prefix) ?? slug(e.prefix).replace(/-/g, "_") + "s",
        what: null,
        numbers: nums,
        facts: fcts,
        color: null,
        file,
        line: lineOf(f.get(e.nameKey).at),
        table: `${table}.${e.nameKey}`,
        foundBy: "embedded",
      }),
    );
  }
  return out;
}

function addField(k, v, numbers, facts, ctx) {
  const label = numberLabel(k);
  // Credentials and personal data never become facts (the codex is uploaded).
  const numeric = v.t === "num" || (v.t === "expr" && v.lead != null) || (v.t === "array" && v.items.length > 0 && v.items.every((x) => x.t === "num"));
  if (sensitiveKey(k, numeric)) return;
  if (v.t === "num") numbers.push({ label, value: v.v });
  else if (v.t === "expr" && v.lead != null) numbers.push({ label, value: v.lead, raw: v.raw });
  else if (v.t === "array" && v.items.length && v.items.every((x) => x.t === "num")) numbers.push({ label, value: v.items.map((x) => fmtNum(x.v)).join(" / ") });
  else if (v.t === "bool") facts.push({ label, value: v.v ? "yes" : "no" });
  else if (v.t === "str") {
    if (v.v.trim() && !looksLikeSecret(v.v)) facts.push({ label, value: v.v });
  } else if (v.t === "ref" || v.t === "array" || v.t === "dict" || (v.t === "call" && !LAYOUT_CALLS.test(v.name))) {
    const s = shortText(v, ctx);
    if (s && !looksLikeSecret(s)) facts.push({ label, value: s });
  }
}

function makeEntry(e) {
  const what = e.what ? clip(e.what, 300) : null;
  return {
    id: `${e.category}/${slug(e.key)}`,
    key: String(e.key).slice(0, 120),
    name: clip(e.name, 120),
    category: e.category,
    what,
    needs_description: !what,
    numbers: e.numbers.slice(0, 12).map((n) => ({ label: clip(n.label, 40), value: typeof n.value === "number" ? n.value : clip(n.value, 80), ...(n.raw ? { raw: clip(n.raw, 120) } : {}) })),
    facts: e.facts.slice(0, 10).map((x) => ({ label: clip(x.label, 40), value: clip(x.value, 160) })),
    ...(e.color ? { color: e.color } : {}),
    defined_at: { file: e.file, line: e.line },
    table: e.table,
    found_by: e.foundBy,
    image: null,
  };
}

// ---- GDScript adapters ---------------------------------------------------------------------------------

const CONST_RE = /^const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[A-Za-z_][\w\[\], ]*)?\s*:?=\s*([\[{])/gm;
const ENUM_RE = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;

function enumsOf(file, ctx) {
  for (const m of file.text.matchAll(ENUM_RE)) {
    const cls = file.className;
    for (const part of m[2].split(",")) {
      const member = part.split("=")[0].trim();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(member)) continue;
      ctx.enumMembers.add(`${m[1]}.${member}`);
      if (cls) ctx.enumMembers.add(`${cls}.${m[1]}.${member}`);
    }
  }
}

/** Every top-level const table of a .gd file, parsed. */
function constTables(file) {
  const out = [];
  for (const m of file.text.matchAll(CONST_RE)) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(file.text, open);
    // A table the reader cannot follow is reported (skipped_tables), never dropped silently. Godot's
    // triple-quoted strings span lines, which the single-line string reader below does not know.
    const body = end < 0 ? file.text.slice(open, open + 4000) : file.text.slice(open, end + 1);
    if (end < 0 || body.includes('"""')) {
      out.push({ name: m[1], value: null, at: m.index, unreadable: body.includes('"""') ? 'it holds a """ multi-line string, which the reader does not follow' : "its brackets could not be matched" });
      continue;
    }
    const toks = tokenize(file.text, open, end + 1);
    const [v] = parseValue(toks, 0, file.text);
    out.push({ name: m[1], value: v, at: m.index });
  }
  return out;
}

function closeOf(text, open) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === "]" || c === "}" || c === ")") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** A table of entries: an array of dictionaries, or a dictionary whose values are dictionaries. */
function tableEntries(t) {
  const v = t.value;
  if (v.t === "array") {
    const dicts = v.items.filter((x) => x.t === "dict");
    if (dicts.length < 2 || dicts.length < v.items.length * 0.8) return null;
    return dicts.map((d) => ({ dict: d, fallbackId: null }));
  }
  if (v.t === "dict") {
    const vals = v.items.filter((it) => it.value.t === "dict");
    if (vals.length < 2 || vals.length < v.items.length * 0.8) return null;
    return vals.map((it) => ({ dict: it.value, fallbackId: it.key.t === "ref" ? it.key.v.split(".").pop().toLowerCase() : String(it.key.v), refKey: it.key.t === "ref" ? it.key.v : null }));
  }
  return null;
}

function scanGdConsts(files, ctx, out, skipped) {
  // First pass: names for enum members (Suit.GEAR -> "Turbo") from enum-keyed tables.
  for (const f of files) {
    for (const t of f.tables) {
      if (t.unreadable) continue;
      const rows = tableEntries(t);
      if (!rows) continue;
      for (const r of rows) {
        if (!r.refKey) continue;
        const nameIt = NAME_KEYS.map((k) => fieldMap(r.dict).get(k)).find((it) => it && it.value.t === "str");
        if (!nameIt) continue;
        const parts = r.refKey.split(".");
        const names = [r.refKey, parts.slice(-2).join(".")];
        if (f.className) names.push(`${f.className}.${parts.slice(-2).join(".")}`);
        for (const n of names) ctx.refNames.set(n, nameIt.value.v);
      }
    }
  }
  for (const f of files) {
    const lineOf = lineIndex(f.text);
    for (const t of f.tables) {
      if (t.unreadable) {
        skipped.push({ where: `${f.rel}:${lineOf(t.at)}`, table: t.name, why: t.unreadable });
        continue;
      }
      const rows = tableEntries(t);
      if (!rows) continue;
      const category = guessCategory(t.name, f.className, basename(f.rel, ".gd"));
      if (!category) {
        skipped.push({ where: `${f.rel}:${lineOf(t.at)}`, table: t.name, why: "no category guessed from the table's name" });
        continue;
      }
      let kept = 0;
      for (const r of rows) {
        const es = entryFromDict(r.dict, { file: f.rel, lineOf, category, table: t.name, ctx, fallbackId: r.fallbackId, foundBy: "gd-const" });
        if (!es) continue;
        kept++;
        out.push(...es);
      }
      if (!kept) skipped.push({ where: `${f.rel}:${lineOf(t.at)}`, table: t.name, why: "its rows have no name, title or id" });
    }
  }
}

const FUNC_RE = /^(?:static\s+)?func\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([\w\[\]]+))?\s*:/gm;

/** Project functions shaped like constructors: make_x(name: String, ...) -> Dictionary. */
function ctorDefs(files) {
  const defs = new Map();
  for (const f of files) {
    for (const m of f.text.matchAll(FUNC_RE)) {
      const fn = m[1];
      if (!/^(make|create|new|define|build)_[a-z]\w*$/.test(fn)) continue;
      if (m[3] && m[3] !== "Dictionary") continue;
      const params = m[2].split(",").map((p) => p.trim().split(/[:=\s]/)[0]).filter(Boolean);
      if (!params.length || !/^(name|title|label|display_name|id)$/.test(params[0])) continue;
      if (!m[3] && !/^(name|title)$/.test(params[0])) continue;
      defs.set(fn, { params, file: f.rel });
    }
  }
  return defs;
}

function scanGdCtors(files, ctx, out) {
  const defs = ctorDefs(files);
  if (!defs.size) return;
  const callRe = new RegExp(`\\b(${[...defs.keys()].join("|")})\\s*\\(\\s*"`, "g");
  for (const f of files) {
    const lineOf = lineIndex(f.text);
    const funcs = [...f.text.matchAll(FUNC_RE)].map((m) => ({ name: m[1], at: m.index }));
    for (const m of f.text.matchAll(callRe)) {
      const def = defs.get(m[1]);
      const open = m.index + m[0].lastIndexOf("(");
      const end = closeOf(f.text, open);
      if (end < 0) continue;
      const toks = tokenize(f.text, m.index, end + 1);
      const [call] = parseValue(toks, 0, f.text);
      if (call.t !== "call" || call.args[0]?.t !== "str") continue;
      const noun = m[1].replace(/^(make|create|new|define|build)_/, "");
      const category = guessCategory(noun) ?? slug(noun).replace(/-/g, "_") + "s";
      const numbers = [];
      const facts = [];
      let color = null;
      call.args.slice(1).forEach((a, i) => {
        const p = def.params[i + 1] ?? `arg_${i + 2}`;
        if (COLOR_KEYS.test(p) || /color|colour/.test(p)) {
          color = color ?? colorHex(a);
          return;
        }
        if (a.t === "num" && a.v === -1) return; // "none" sentinel (weighted_suit = -1)
        addField(p, a, numbers, facts, ctx);
      });
      const inFn = funcs.filter((x) => x.at < m.index).pop();
      // The match arm it sits in, if any ("artillery": return make_die(...)).
      const before = f.text.slice(Math.max(0, m.index - 400), m.index);
      const arm = /\n\s*"([\w-]+)"\s*:\s*(?:\n\s*)?(?:return\s+)?$/.exec(before);
      if (inFn) facts.push({ label: "Made in", value: `${inFn.name}()${arm ? ` "${arm[1]}"` : ""}` });
      out.push(
        makeEntry({ key: call.args[0].v, name: call.args[0].v, category, what: null, numbers, facts, color, file: f.rel, line: lineOf(m.index), table: `${m[1]}()`, foundBy: "gd-ctor" }),
      );
    }
  }
}

/**
 * `match kind:` blocks where three or more string arms assign the same stats on their line:
 *   "brute": hp = 165.0 * hp_m; speed = 88.0 * sp_m; radius = 23.0
 */
function scanGdMatches(files, ctx, out) {
  for (const f of files) {
    const lines = f.text.split("\n");
    const funcs = [...f.text.matchAll(FUNC_RE)].map((m) => ({ name: m[1], line: f.text.slice(0, m.index).split("\n").length }));
    for (let i = 0; i < lines.length; i++) {
      const mm = /^(\s*)match\s+([\w.]+)\s*:\s*$/.exec(lines[i]);
      if (!mm) continue;
      const indent = mm[1].length;
      const arms = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") continue;
        const ind = /^\s*/.exec(l)[0].length;
        if (ind <= indent) break;
        const am = /^\s*((?:"[\w-]+"\s*,\s*)*"[\w-]+")\s*:\s*(.*)$/.exec(l);
        if (!am) continue;
        const keys = [...am[1].matchAll(/"([\w-]+)"/g)].map((x) => x[1]);
        const sets = am[2]
          .split(";")
          .map((s) => /^\s*([a-z_]\w*)\s*(?:\+|-|\*)?=\s*(.+?)\s*$/.exec(s))
          .filter(Boolean)
          .map((x) => ({ k: x[1], expr: x[2] }));
        if (sets.length >= 2) arms.push({ keys, sets, line: j + 1 });
      }
      if (arms.length < 3) continue;
      const common = arms[0].sets.map((s) => s.k).filter((k) => arms.filter((a) => a.sets.some((s) => s.k === k)).length >= Math.ceil(arms.length / 2));
      if (common.length < 2) continue;
      const fn = funcs.filter((x) => x.line <= i + 1).pop();
      const category = guessCategory(fn?.name, mm[2]) ?? "things";
      for (const a of arms) {
        const numbers = [];
        for (const s of a.sets) {
          if (LAYOUT_KEYS.test(s.k)) continue;
          const lead = /^(-?\d+(?:\.\d+)?)/.exec(s.expr);
          if (lead) numbers.push({ label: humanize(s.k), value: Number(lead[1]), ...(s.expr !== lead[1] ? { raw: s.expr } : {}) });
        }
        for (const key of a.keys) {
          out.push(
            makeEntry({
              key,
              name: humanize(key),
              category,
              what: null,
              numbers,
              facts: fn ? [{ label: "Set in", value: `${fn.name}()` }] : [],
              color: null,
              file: f.rel,
              line: a.line,
              table: `match ${mm[2]}`,
              foundBy: "gd-match",
            }),
          );
        }
      }
    }
  }
}

// ---- JSON adapter ---------------------------------------------------------------------------------------

const JSON_SKIP = /(^|\/)(package(-lock)?|tsconfig|jsconfig|composer|manifest|project|export_presets|app|codex|scan|inventory|labels|run|\.?eslintrc|vercel|firebase)\.json$|(^|\/)(\.vscode|\.github|Pods|node_modules|ios|android|build)\/|(^|\/)[^/]*(secret|credential|service[-_]?account|google-services|token|\.local)[^/]*\.json$/i;

function scanJson(files, ctx, out) {
  for (const f of files) {
    if (JSON_SKIP.test(f.rel)) continue;
    let data;
    try {
      data = JSON.parse(f.raw);
    } catch {
      continue;
    }
    const lineOf = lineIndex(f.raw);
    const tables = Array.isArray(data) ? [[basename(f.rel, ".json"), data]] : data && typeof data === "object" ? Object.entries(data).filter(([, v]) => Array.isArray(v)) : [];
    for (const [name, rows] of tables) {
      const objs = rows.filter((r) => r && typeof r === "object" && !Array.isArray(r));
      if (objs.length < 2 || !objs.every((r) => NAME_KEYS.some((k) => typeof r[k] === "string") || ID_KEYS.some((k) => typeof r[k] === "string"))) continue;
      const category = guessCategory(name, basename(f.rel, ".json"));
      if (!category) continue;
      let from = 0;
      for (const r of objs) {
        const id = ID_KEYS.map((k) => r[k]).find((v) => typeof v === "string" || typeof v === "number");
        const nm = NAME_KEYS.map((k) => r[k]).find((v) => typeof v === "string");
        const needle = JSON.stringify(id ?? nm);
        const at = f.raw.indexOf(needle, from);
        if (at >= 0) from = at + 1;
        const what = WHAT_KEYS.map((k) => r[k]).find((v) => typeof v === "string" && v.trim() && !looksLikeSecret(v));
        const numbers = [];
        const facts = [];
        for (const [k, v] of Object.entries(r)) {
          if ([...ID_KEYS, ...NAME_KEYS, ...WHAT_KEYS].includes(k) || LAYOUT_KEYS.test(k)) continue;
          const numeric = typeof v === "number" || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number"));
          if (sensitiveKey(k, numeric) || (typeof v === "string" && looksLikeSecret(v))) continue;
          if (typeof v === "number") numbers.push({ label: humanize(k), value: v });
          else if (Array.isArray(v) && v.length && v.every((x) => typeof x === "number")) numbers.push({ label: humanize(k), value: v.join(" / ") });
          else if (typeof v === "string" && v.trim()) facts.push({ label: humanize(k), value: v });
          else if (typeof v === "boolean") facts.push({ label: humanize(k), value: v ? "yes" : "no" });
        }
        out.push(
          makeEntry({ key: String(id ?? nm), name: String(nm ?? humanize(id)), category, what: what ?? null, numbers, facts, color: null, file: f.rel, line: at >= 0 ? lineOf(at) : 1, table: name, foundBy: "json" }),
        );
      }
    }
  }
}

// ---- scan ---------------------------------------------------------------------------------------------------

function git(src, args) {
  try {
    return execFileSync("git", ["-C", src, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function toolVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "?";
  }
}

/**
 * Files git would commit (tracked plus untracked, minus .gitignore), relative to src, or null when
 * src is not in a git repo. Ignored files (local configs, keys, build output) are never read.
 */
export function gitFiles(src) {
  try {
    const out = execFileSync("git", ["-C", src, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

/** Read a repo and return the codex object (nothing written). */
export function scanCodex(src, o = {}) {
  if (!src || !existsSync(src) || !statSync(src).isDirectory()) throw new Error(`--src must be the game's repo folder (not found: ${src})`);
  const tracked = gitFiles(src);
  // Dot files (.env, .secrets.json) and git-ignored files stay out.
  const all = walk(src).filter((f) => !TEST_PATH.test(f.rel) && !/(^|\/)\./.test(f.rel) && (!tracked || tracked.has(f.rel)));
  const godot = all.some((f) => f.rel === "project.godot" || f.rel.endsWith("/project.godot"));
  const ctx = { refNames: new Map(), enumMembers: new Set(), funcParams: new Map() };
  const gd = [];
  const json = [];
  for (const f of all) {
    if (f.ext !== ".gd" && f.ext !== ".json") continue;
    let raw;
    try {
      if (statSync(f.abs).size > MAX_BYTES) continue;
      raw = readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    if (f.ext === ".gd") {
      const text = stripComments(raw, true);
      const cls = /^class_name\s+(\w+)/m.exec(text);
      gd.push({ ...f, text, className: cls ? cls[1] : null });
    } else json.push({ ...f, raw });
  }
  for (const f of gd) {
    for (const m of f.text.matchAll(FUNC_RE)) ctx.funcParams.set(m[1], m[2].split(",").map((p) => p.trim().split(/[:=\s]/)[0]).filter(Boolean));
    enumsOf(f, ctx);
    f.tables = constTables(f);
  }
  const entries = [];
  const skipped = [];
  scanGdConsts(gd, ctx, entries, skipped);
  scanGdCtors(gd, ctx, entries);
  scanGdMatches(gd, ctx, entries);
  scanJson(json, ctx, entries);

  // Unique ids: a second "dice/striker-die" gets its table as a suffix, then a counter.
  const seen = new Map();
  for (const e of entries) {
    let id = e.id;
    if (seen.has(id)) {
      id = `${e.id}~${slug(e.table)}`;
      let n = 2;
      while (seen.has(id)) id = `${e.id}~${n++}`;
    }
    e.id = id;
    seen.set(id, e);
  }
  // Last line of defence before anything is written: the same filter the server applies.
  const clean = [];
  let redacted = 0;
  for (const e of entries) {
    const r = scrubEntry(e);
    redacted += r.removed;
    if (r.entry) clean.push(r.entry);
  }
  const kept = clean.slice(0, MAX_ENTRIES);
  const counts = {};
  for (const e of kept) counts[e.category] = (counts[e.category] ?? 0) + 1;
  const order = Object.keys(CATEGORY_LABELS);
  const categories = Object.keys(counts)
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b))
    .map((key) => ({ key, label: categoryLabel(key), count: counts[key] }));
  kept.sort((a, b) => categories.findIndex((c) => c.key === a.category) - categories.findIndex((c) => c.key === b.category));
  const commit = git(src, ["rev-parse", "HEAD"]);
  return {
    schema: CODEX_SCHEMA,
    game: { name: o.game ?? humanize(basename(resolve(src))), engine: godot ? "godot" : "unknown" },
    source: {
      commit: commit ?? null,
      branch: git(src, ["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: commit ? Boolean(git(src, ["status", "--porcelain", "--untracked-files=no"])) : null,
      scanned_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      tool: `gamedexy ${toolVersion()}`,
      files_read: gd.length + json.length,
    },
    categories,
    entries: kept,
    ...(clean.length > MAX_ENTRIES ? { truncated: clean.length - MAX_ENTRIES } : {}),
    ...(redacted ? { redacted } : {}),
    skipped_tables: skipped,
  };
}

export function defaultCodexDir(src) {
  return join(homedir(), ".gamedexy", "codex", slug(basename(resolve(src))));
}

/**
 * Keep what a person or agent added by hand to the last codex.json while the entry's id is the same:
 * a "what" the code does not have (marked what_from "written"; recheck when its numbers changed since)
 * and the picture from the last render.
 */
export function carryOver(prev, codex, dir) {
  const old = new Map((prev?.entries ?? []).map((e) => [e.id, e]));
  for (const e of codex.entries) {
    const p = old.get(e.id);
    if (!p) continue;
    if (!e.what && p.what) {
      e.what = clip(p.what, 300);
      e.needs_description = false;
      e.what_from = "written";
      const nums = (x) => JSON.stringify([(x.numbers ?? []).map((n) => [n.label, n.value]), (x.facts ?? []).map((f) => [f.label, f.value])]);
      if (p.recheck || nums(p) !== nums(e)) e.recheck = true;
    }
    if (p.image?.file && existsSync(join(dir, p.image.file))) e.image = p.image;
  }
}

/** `gamedexy codex scan`: write codex.json (and keep the one it replaces as codex.prev.json). */
export function codexScan(o) {
  const codex = scanCodex(o.src, { game: o.game });
  const dir = o.out ?? defaultCodexDir(o.src);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "codex.json");
  if (existsSync(file)) {
    const old = readFileSync(file, "utf8");
    writeFileSync(join(dir, "codex.prev.json"), old);
    try {
      carryOver(JSON.parse(old), codex, dir);
    } catch {
      /* an unreadable old codex just loses its pictures and written descriptions */
    }
  }
  writeFileSync(file, JSON.stringify(codex, null, 1));
  const prevFile = join(dir, "codex.prev.json");
  const changes = existsSync(prevFile) ? diffSummary(diffCodex(JSON.parse(readFileSync(prevFile, "utf8")), codex)) : null;
  return {
    ok: true,
    codex: file,
    entries: codex.entries.length,
    categories: Object.fromEntries(codex.categories.map((c) => [c.key, c.count])),
    needs_description: codex.entries.filter((e) => e.needs_description).length,
    with_picture: codex.entries.filter((e) => e.image).length,
    skipped_tables: codex.skipped_tables.length,
    ...(changes ? { since_last_scan: changes } : {}),
    next: `Fill "what" for entries with needs_description (read the code at defined_at; plain words, one line). Then optionally: gamedexy codex render --src ${o.src} --codex ${file}. Then: gamedexy codex send --codex ${file} --game "${codex.game.name}"`,
  };
}

// ---- diff -----------------------------------------------------------------------------------------------------

const sig = (e) => JSON.stringify({ name: e.name, numbers: (e.numbers ?? []).map((n) => [n.label, n.value]), facts: (e.facts ?? []).map((f) => [f.label, f.value]) });
// A description written for the first time is not a change to the game (same rule as the web diff).
const whatChanged = (a, b) => a.what != null && (a.what ?? null) !== (b.what ?? null);

/** What changed between two codex versions, by entry id (a renamed entry with the same key is "changed"). */
export function diffCodex(before, after) {
  const a = new Map((before?.entries ?? []).map((e) => [e.id, e]));
  const b = new Map((after?.entries ?? []).map((e) => [e.id, e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, e] of b) if (!a.has(id)) added.push(e);
  for (const [id, e] of a) if (!b.has(id)) removed.push(e);
  for (const [id, e] of b) {
    const old = a.get(id);
    if (!old || (sig(old) === sig(e) && !whatChanged(old, e))) continue;
    const fields = [];
    if (old.name !== e.name) fields.push({ field: "name", before: old.name, after: e.name });
    if (whatChanged(old, e)) fields.push({ field: "what", before: old.what ?? null, after: e.what ?? null });
    const kv = (list) => new Map((list ?? []).map((x) => [x.label, x.value]));
    for (const [kind, ka, kb] of [["number", kv(old.numbers), kv(e.numbers)], ["fact", kv(old.facts), kv(e.facts)]]) {
      for (const [label, v] of kb) if (!ka.has(label) || String(ka.get(label)) !== String(v)) fields.push({ field: `${kind}:${label}`, before: ka.has(label) ? ka.get(label) : null, after: v });
      for (const [label, v] of ka) if (!kb.has(label)) fields.push({ field: `${kind}:${label}`, before: v, after: null });
    }
    changed.push({ id, name: e.name, category: e.category, fields });
  }
  return { added, removed, changed };
}

/** One line per category: "Dice faces: Toy Bot removed; Buddies added; Turbo changed". */
export function diffSummary(d) {
  const by = new Map();
  const put = (cat, s) => by.set(cat, [...(by.get(cat) ?? []), s]);
  for (const e of d.removed) put(e.category, `${e.name} removed`);
  for (const e of d.added) put(e.category, `${e.name} added`);
  for (const c of d.changed) {
    const rename = c.fields.find((f) => f.field === "name");
    put(c.category, rename ? `${rename.before} renamed ${rename.after}` : `${c.name} changed (${c.fields.map((f) => f.field.replace(/^(number|fact):/, "")).slice(0, 3).join(", ")})`);
  }
  return { added: d.added.length, removed: d.removed.length, changed: d.changed.length, lines: [...by].map(([cat, parts]) => `${categoryLabel(cat)}: ${parts.join("; ")}`) };
}

export function codexDiff(o) {
  if (!o.old || !o.new) throw new Error("Use: gamedexy codex diff --old codex.prev.json --new codex.json");
  const d = diffCodex(JSON.parse(readFileSync(o.old, "utf8")), JSON.parse(readFileSync(o.new, "utf8")));
  return { ...diffSummary(d), details: d.changed.map((c) => ({ id: c.id, fields: c.fields })) };
}

// ---- render (game-side hook) ------------------------------------------------------------------------------

/**
 * Windows: Node (>= 18.20 / 20.12) refuses to spawn a .cmd or .bat without a shell, so a GODOT that
 * points at a shim fails. Say so plainly instead of a bare EINVAL.
 */
export function checkGodotBin(bin, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(String(bin))) {
    throw new Error(`${bin} is a .cmd/.bat shim, which Node cannot start without a shell. Point --godot or GODOT at the Godot .exe itself (for example Godot_v4.4-stable_win64.exe).`);
  }
  return bin;
}

/** Find a Godot editor binary: --godot, $GODOT, then PATH. */
function godotBin(o) {
  if (o.godot) return checkGodotBin(o.godot);
  if (process.env.GODOT) return checkGodotBin(process.env.GODOT);
  for (const c of ["godot", "godot4", "/Applications/Godot.app/Contents/MacOS/Godot"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

/**
 * Merge a render hook's images.json into the codex. The hook contract (any engine): write PNGs
 * into the images folder and an images.json { schema, images: [{ id, file, w, h }], skipped: [...] }.
 */
export function mergeImages(codex, codexDir, imagesDir) {
  const manifestFile = join(imagesDir, "images.json");
  if (!existsSync(manifestFile)) throw new Error(`The render hook wrote no ${manifestFile}`);
  const man = JSON.parse(readFileSync(manifestFile, "utf8"));
  const byId = new Map(codex.entries.map((e) => [e.id, e]));
  let attached = 0;
  const problems = [];
  for (const im of man.images ?? []) {
    const e = byId.get(im.id);
    const abs = join(imagesDir, basename(String(im.file ?? "")));
    if (!e) {
      problems.push({ id: im.id, why: "no such entry in codex.json" });
      continue;
    }
    if (!/\.png$/i.test(abs) || !existsSync(abs)) {
      problems.push({ id: im.id, why: "image file missing" });
      continue;
    }
    const bytes = readFileSync(abs);
    if (bytes.length > 300_000) {
      problems.push({ id: im.id, why: "image over 300 KB; render it smaller" });
      continue;
    }
    const rel = join(relativeTo(codexDir, imagesDir), basename(abs)).split("\\").join("/");
    e.image = { file: rel, w: Number(im.w) || null, h: Number(im.h) || null, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    attached++;
  }
  return { attached, problems, skipped: man.skipped ?? [] };
}

/** `to` relative to `from` when it is inside it, else `to` as an absolute path. */
export function relativeTo(from, to) {
  const b = resolve(to);
  const r = relative(resolve(from), b);
  if (!r) return ".";
  return r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r) ? b : r;
}

/** The hook as a res:// path: forward slashes, no leading ./ (a Windows --hook can use backslashes). */
export function hookResPath(hook) {
  return `res://${String(hook).replace(/\\/g, "/").replace(/^res:\/\//, "").replace(/^(\.\/)+/, "").replace(/^\/+/, "")}`;
}

/**
 * `gamedexy codex render`: run the game's own render hook, then attach the pictures.
 * Godot: res://gamedexy/codex.gd (or the older res://gamedexy_codex.gd; a SceneTree script) is run with a window (headless Godot has
 * no renderer, so nothing could be drawn). --no-run only merges images a hook already wrote.
 */
export function codexRender(o) {
  if (!o.codex) throw new Error("Use: gamedexy codex render --src <repo> --codex codex.json");
  const codexFile = resolve(o.codex);
  const codexDir = dirname(codexFile);
  const codex = JSON.parse(readFileSync(codexFile, "utf8"));
  const imagesDir = resolve(o.images ?? join(codexDir, "images"));
  let ran = null;
  if (!o.noRun) {
    if (!o.src) throw new Error("--src is required (the game's repo), or pass --no-run to merge images already rendered");
    const src = resolve(o.src);
    // The hook lives in the game's gamedexy/ dev folder (never exported); the older root-level file still works.
    const hook = hookResPath(o.hook ?? (existsSync(join(src, "gamedexy", "codex.gd")) ? "gamedexy/codex.gd" : "gamedexy_codex.gd")).slice("res://".length);
    if (!existsSync(join(src, hook))) {
      return {
        ok: false,
        refused: `No render hook at ${join(src, hook)}. The game draws its own pictures: add a debug-only hook (docs/game-codex.md "Render hook"; Rattlepop's is an example), on its own branch, with the developer's yes.`,
      };
    }
    const bin = godotBin(o);
    if (!bin) throw new Error("Godot was not found. Pass --godot <path to the Godot editor> or set GODOT.");
    mkdirSync(imagesDir, { recursive: true });
    // Class names (class_name) need the project's import cache; a fresh checkout has none.
    if (!existsSync(join(src, ".godot", "global_script_class_cache.cfg"))) spawnSync(bin, ["--headless", "--path", src, "--import"], { stdio: "ignore", timeout: 180_000 });
    const t0 = Date.now();
    const r = spawnSync(bin, ["--path", src, "--resolution", "256x256", "--script", hookResPath(hook), "--", "--gdx-codex", codexFile, "--gdx-out", imagesDir], {
      encoding: "utf8",
      timeout: (Number(o.timeout) || 120) * 1000,
    });
    ran = { exit: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10, ...(r.status !== 0 ? { log_tail: String(r.stdout ?? "").split("\n").concat(String(r.stderr ?? "").split("\n")).filter(Boolean).slice(-12) } : {}) };
    if (r.error) throw new Error(`Godot did not run: ${r.error.message}`);
  }
  const merged = mergeImages(codex, codexDir, imagesDir);
  writeFileSync(codexFile, JSON.stringify(codex, null, 1));
  return {
    ok: true,
    ...(ran ? { godot: ran } : {}),
    attached: merged.attached,
    without_picture: codex.entries.filter((e) => !e.image).length,
    ...(merged.problems.length ? { problems: merged.problems } : {}),
    ...(merged.skipped.length ? { hook_skipped: merged.skipped.length } : {}),
    codex: codexFile,
    next: `gamedexy codex send --codex ${codexFile} --game "${codex.game?.name ?? "My Game"}"`,
  };
}

// ---- send ---------------------------------------------------------------------------------------------------------

/** What map_set_codex takes: the codex without local-only fields (file paths of images stay out). */
export function codexPayload(codex) {
  // A codex.json written by an older CLI, or edited by hand, is filtered again before it leaves.
  const entries = codex.entries.map((e) => scrubEntry(e).entry).filter(Boolean);
  return {
    schema: codex.schema,
    source: { commit: codex.source?.commit ?? null, branch: codex.source?.branch ?? null, dirty: codex.source?.dirty ?? null, scanned_at: codex.source?.scanned_at ?? null, tool: codex.source?.tool ?? null },
    entries: entries.map((e) => ({
      id: e.id,
      key: e.key,
      name: e.name,
      category: e.category,
      what: e.what ?? null,
      numbers: e.numbers ?? [],
      facts: e.facts ?? [],
      ...(e.color ? { color: e.color } : {}),
      defined_at: e.defined_at,
      found_by: e.found_by,
      ...(e.image?.sha256 ? { image: { sha256: e.image.sha256, w: e.image.w, h: e.image.h, bytes: e.image.bytes } } : {}),
      ...(e.what && e.what_from === "written" ? { what_from: "written" } : {}),
      ...(e.what && e.recheck ? { recheck: true } : {}),
    })),
  };
}

/** `gamedexy codex send`: create or find the Game Map game, store this codex version, upload pictures. */
export async function codexSend(o, deps = {}) {
  if (!o.codex) throw new Error('Use: gamedexy codex send --codex codex.json --game "My Game" [--platform ios]');
  const codexFile = resolve(o.codex);
  const codex = JSON.parse(readFileSync(codexFile, "utf8"));
  if (codex.schema !== CODEX_SCHEMA) throw new Error(`${codexFile} is not a ${CODEX_SCHEMA} file`);
  const call = deps.callTool ?? (await import("./auth.mjs")).callTool;
  const f = deps.fetch ?? fetch;
  const name = String(o.game ?? codex.game?.name ?? "");
  if (!name) throw new Error("--game is required");
  // Look the account's games up first: reuse one that matches (slug, then name), never guess between several.
  const g = await resolveGame(call, { game: name, platform: o.platform ?? "ios", createNew: o.createNew, ...(codex.game?.engine && codex.game.engine !== "unknown" ? { engine: codex.game.engine } : {}) });
  const payload = codexPayload(codex);
  let reply = await call("map_set_codex", { game: g.game_id, codex: payload });
  const byHash = new Map(codex.entries.filter((e) => e.image?.sha256).map((e) => [e.image.sha256, e]));
  let uploaded = 0;
  const failed = [];
  // One bad picture (missing file, refused PUT, network error) must not stop the rest: every file is tried,
  // the failures are listed at the end and the command exits non-zero (see bin/gamedexy.mjs).
  for (const up of reply?.uploads ?? []) {
    const e = byHash.get(up.sha256);
    if (!e) continue;
    try {
      const file = isAbsolute(e.image.file) ? e.image.file : join(dirname(codexFile), e.image.file);
      const res = await f(up.url, { method: "PUT", headers: { "content-type": "image/png" }, body: readFileSync(file) });
      if (res.ok) uploaded++;
      else failed.push({ id: e.id, status: res.status });
    } catch (err) {
      failed.push({ id: e.id, error: String(err?.code ?? err?.message ?? err).slice(0, 120) });
    }
  }
  // The server only counts a picture once it finds the object in the bucket: send again to confirm
  // (an unchanged codex adds no version) and to get fresh links for any that did not arrive.
  const warnings = [...(reply?.warnings ?? [])];
  let stillMissing = [];
  if (reply?.uploads?.length) {
    const again = await call("map_set_codex", { game: g.game_id, codex: payload });
    stillMissing = again?.uploads ?? [];
    for (const w of again?.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
    reply = { ...reply, ...again, version: again?.version ?? reply.version, changes: reply.changes ?? again?.changes };
  }
  return {
    ok: failed.length === 0,
    // Which game this went to, and whether it was found or made.
    game: { id: g.game_id, slug: g.slug, name: g.name ?? name, created: g.created === true, ...(g.reused ? { reused: true } : {}), map_url: g.map_url },
    ...(g.created === true ? { note: `No game named "${name}" existed, so this created a new Game Map game (platform ${o.platform ?? "ios"}). If it should go to an existing game, run again with --game <slug|id>.` } : {}),
    ...(g.lookup ? { lookup: g.lookup } : {}),
    version: reply?.version,
    entries: reply?.entries,
    changes: reply?.changes ?? null,
    images: { uploaded, already_stored: reply?.images_already_stored ?? 0, ...(failed.length ? { failed } : {}), ...(stillMissing.length ? { missing: stillMissing.length } : {}) },
    ...(failed.length ? { failed_uploads: failed.length, next: `${failed.length} picture(s) did not upload (listed in images.failed). The codex version is stored; send again to retry just those.` } : {}),
    ...(warnings.length ? { warnings } : {}),
    codex_url: reply?.codex_url,
  };
}

export const _internal = { constTables, entryFromDict, tableEntries };
