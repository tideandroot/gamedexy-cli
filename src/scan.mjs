// gamedexy scan: read a game's repo with plain code (no AI) and list what Game Map should capture.
// Screens, which screen opens which (navigation edges), tabs inside a screen, store products, ad
// placements, scheduled notifications, review prompts, places that read today's date, currencies,
// and a capture checklist. Names and file locations only: nothing here leaves the machine
// (Slice 26 Part G, D-102). Anything the scan cannot decide goes under `unsure` with its file, so
// the agent reads only those files.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, sep } from "node:path";

import { findLevels } from "./levels.mjs";

export const SCAN_SCHEMA = "gamedexy.scan/1";

const SKIP_DIRS = new Set([
  ".git", ".svn", "node_modules", "build", "Build", "Builds", "DerivedData", "Pods", ".build", "Carthage",
  "Library", "Temp", "Logs", "obj", "UserSettings", ".gradle", ".idea", ".godot", ".import", ".venv",
  "vendor", "dist", "out", "xcuserdata", "fastlane", "Packages", "TextMesh Pro", "Plugins",
]);
const READ_EXT = new Set([".swift", ".kt", ".java", ".gd", ".tscn", ".cs", ".storekit", ".json", ".xml", ".godot", ".asset"]);
const MAX_FILES = 20000;
const MAX_BYTES = 2_000_000;
const TEST_PATH = /(^|[\\/])(Tests?|UITests|androidTest|test|tests|Editor)([\\/]|$)|Tests?\.(swift|kt|cs)$/;

// ---- files ---------------------------------------------------------------------

export function walk(src) {
  const out = [];
  const stack = [src];
  while (stack.length && out.length < MAX_FILES) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") {
        if (e.isDirectory()) continue;
      }
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.endsWith(".xcassets") && !e.name.endsWith(".xcodeproj") && !e.name.endsWith(".app")) stack.push(p);
      } else out.push({ abs: p, rel: relative(src, p).split(sep).join("/"), ext: extname(e.name).toLowerCase(), name: e.name });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function read(f) {
  try {
    if (statSync(f.abs).size > MAX_BYTES) return null;
    return readFileSync(f.abs, "utf8");
  } catch {
    return null;
  }
}

export function detectEngine(files) {
  const has = (re) => files.some((f) => re.test(f.rel));
  if (has(/(^|\/)project\.godot$/)) return "godot";
  if (has(/(^|\/)ProjectSettings\/ProjectVersion\.txt$/) || (has(/(^|\/)Assets\//) && has(/\.cs$/))) return "unity";
  const swift = files.filter((f) => f.ext === ".swift").length;
  const kotlin = files.filter((f) => f.ext === ".kt" || f.ext === ".java").length;
  if (swift && swift >= kotlin) return "swift";
  if (kotlin) return "kotlin";
  return "unknown";
}

// ---- text helpers ----------------------------------------------------------------

/** Blank out // and /* *\/ comments (and # for GDScript) but keep strings and line numbers. */
export function stripComments(text, hash = false) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '"' || (c === "'" && hash)) {
      const q = c;
      let j = i + 1;
      while (j < n && text[j] !== q && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (!hash && c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") (out += " "), i++;
    } else if (!hash && c === "/" && d === "*") {
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) (out += text[i] === "\n" ? "\n" : " "), i++;
      out += "  ";
      i += 2;
    } else if (hash && c === "#") {
      while (i < n && text[i] !== "\n") (out += " "), i++;
    } else (out += c), i++;
  }
  return out;
}

export function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Index of the bracket that closes the one at `open` (strings skipped), or -1. */
export function matchBracket(text, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const o = text[open];
  const c = pairs[o];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

const SUFFIX = /(ViewController|Controller|View|Screen|Sheet|Scene|Page|Panel|Popup|Dialog|Modal|Overlay|Fragment|Activity|Window|Menu)$/;

/** Map screen key from a code name: ShopSheet -> shop, FakeAdView -> fake_ad, HUDView -> hud. */
export function screenKey(name) {
  let base = String(name).replace(/\.(tscn|unity|prefab)$/i, "");
  if (base.length > 4 && SUFFIX.test(base) && base.replace(SUFFIX, "").length >= 2) base = base.replace(SUFFIX, "");
  return (
    base
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "screen"
  );
}

// Gamedexy screen categories (CATEGORY_LABELS in the web app), guessed from a name. First match wins.
const CATEGORY_RULES = [
  [/tutorial|onboard|intro|how_?to|coach|first_?time|ftue/, "tutorial"],
  [/splash|loading|launch|boot/, "first_launch"],
  [/consent|privacy|gdpr|tracking|att_/, "consent"],
  [/log_?in_?reward|daily|streak|calendar|check_?in/, "daily_reward"],
  [/login|sign_?in|sign_?up|account|auth|profile/, "account"],
  [/calibrat|setting|option|preference/, "settings"],
  [/leaderboard|score|ranking|board/, "leaderboard"],
  [/season|pass\b|_pass|battle_?pass/, "battle_pass"],
  [/interstitial/, "interstitial"],
  [/(^|_)ads?(_|$)|rewarded|ad_?view/, "rewarded_ad"],
  [/paywall|subscri|vip|club|purchase|iap/, "iap_sheet"],
  [/offer|starter|bundle|deal|sale|promo/, "offer"],
  [/shop|store|market|merchant/, "shop"],
  [/gacha|chest|loot|spin|wheel|lucky/, "gacha"],
  [/revive|continue|second_?chance/, "revival"],
  [/win|victory|complete|cleared|success/, "victory"],
  [/lose|lost|defeat|fail|game_?over|snuff/, "defeat"],
  [/result|summary|recap|tally|over$/, "results"],
  [/troph|achiev|mission|quest|task|challenge/, "missions"],
  [/rank|level_?up|tier|progress|world|level_?select|stage_?select|map$/, "progression_map"],
  [/cosmetic|skin|wardrobe|customi|outfit/, "cosmetics"],
  [/inventory|bag|backpack/, "inventory"],
  [/upgrade|forge|enhance/, "upgrade"],
  [/energy|lives|hearts|refill/, "energy_lives"],
  [/notif|inbox|mail/, "notification"],
  [/guild|clan|team/, "guild"],
  [/friend|social|share|invite|chat/, "social"],
  [/event/, "events"],
  [/character|hero|select/, "character_select"],
  [/loadout|equip/, "loadout"],
  [/collection|album|codex|bestiary/, "collection"],
  [/menu|home|main|lobby|hub|title/, "home"],
  [/hud|game|play|level|countdown|pause|night|battle|arena|run$/, "gameplay"],
];

export function guessCategory(key) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(key)) return cat;
  return null;
}

const CURRENCY_WORDS = new Set([
  "coins", "coin", "gems", "gem", "gold", "diamonds", "crystals", "cash", "bucks", "tokens", "tickets", "keys",
  "stars", "motes", "shards", "orbs", "credits", "points", "jewels", "pearls", "rubies", "energy", "lives", "hearts",
  "starlight", "souls", "essence", "mana", "silver", "bolts", "scrap", "acorns", "seeds", "candy",
]);

// ---- result builder ----------------------------------------------------------------

function newResult(src, engine) {
  return {
    schema: SCAN_SCHEMA,
    engine,
    repo: basename(src),
    files_read: 0,
    screens: [],
    edges: [],
    products: [],
    ads: [],
    notifications: [],
    review_prompts: [],
    date_reads: [],
    currencies: [],
    levels: [],
    unsure: [],
  };
}

function addScreen(r, s) {
  const have = r.screens.find((x) => x.key === s.key);
  if (have) {
    if (s.sure && !have.sure) Object.assign(have, { sure: true, why: s.why });
    if (s.tabs && !have.tabs) have.tabs = s.tabs;
    return have;
  }
  const row = { key: s.key, name: s.name, kind: s.kind, where: s.where, sure: Boolean(s.sure), why: s.why };
  if (s.tabs) row.tabs = s.tabs;
  r.screens.push(row);
  return row;
}

function addEdge(r, e) {
  if (!e.from || !e.to || e.from === e.to) return;
  if (r.edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind && x.trigger === e.trigger)) return;
  r.edges.push({ from: e.from, to: e.to, kind: e.kind, trigger: e.trigger ?? null, where: e.where });
}

function addProduct(r, p) {
  const have = r.products.find((x) => x.id === p.id);
  if (have) {
    for (const k of ["type", "price", "grants"]) if (!have[k] && p[k]) have[k] = p[k];
    if (p.sure) have.sure = true;
    return;
  }
  r.products.push({ id: p.id, type: p.type ?? null, price: p.price ?? null, grants: p.grants ?? null, where: p.where, sure: Boolean(p.sure) });
}

function addAd(r, a) {
  const have = r.ads.find((x) => x.key === a.key);
  if (have) {
    if (a.call && !have.calls.includes(a.call)) have.calls.push(a.call);
    if (!have.format && a.format) have.format = a.format;
    return;
  }
  r.ads.push({ key: a.key, format: a.format ?? null, where: a.where, calls: a.call ? [a.call] : [] });
}

const WALLET_FILE = /save|progress|wallet|economy|currenc|player|inventory|bank|profile|state|data/i;

function addCurrency(r, key, where, why) {
  const have = r.currencies.find((c) => c.key === key);
  if (have) {
    if (!WALLET_FILE.test(have.where.split(":")[0].split("/").pop()) && WALLET_FILE.test(where.split(":")[0].split("/").pop())) have.where = where;
    return;
  }
  r.currencies.push({ key, where, why });
}

function addDateRead(r, file, line) {
  const have = r.date_reads.find((d) => d.file === file);
  if (have) {
    if (have.lines.length < 12 && !have.lines.includes(line)) have.lines.push(line);
  } else r.date_reads.push({ file, lines: [line] });
}

const adFormat = (s) => (/interstitial/i.test(s) ? "interstitial" : /banner/i.test(s) ? "banner" : /app_?open/i.test(s) ? "app_open" : /reward/i.test(s) ? "rewarded" : null);

/** Ads, notifications, review prompts, date reads and reverse-DNS product ids: the same idea in every language. */
function commonScan(r, f, text, lang) {
  const lines = text.split("\n");
  const dateRe = {
    swift: /\bDate\(\)|\bDate\.now\b|\bCFAbsoluteTimeGetCurrent\(/,
    kotlin: /System\.currentTimeMillis\(|Instant\.now\(|LocalDate(Time)?\.now\(|Calendar\.getInstance\(|\bDate\(\)/,
    cs: /DateTime(Offset)?\.(Now|UtcNow|Today)\b/,
    gd: /Time\.get_(unix_time_from_system|datetime|date)\w*\(|OS\.get_(datetime|date|unix_time)\w*\(/,
  }[lang];
  const notifRe = /UNNotificationRequest\(|UNMutableNotificationContent\(|NotificationCompat\.Builder\(|AndroidNotificationCenter\.SendNotification|iOSNotificationCenter\.ScheduleNotification|NotificationManagerCompat\.from\(.*\)\.notify|LocalNotification/;
  const reviewRe = /requestReview\b|SKStoreReviewController|ReviewManagerFactory|launchReviewFlow|RequestStoreReview|Device\.RequestStoreReview|request_review/;
  const adSdkRe = /\b(GADRewardedAd|GADInterstitialAd|GADBannerView|GADAppOpenAd|RewardedAd|InterstitialAd|RewardedInterstitialAd|AdView|MARewardedAd|MAInterstitialAd|MAAdView|LevelPlay\w*|IronSource\w*|Advertisement\.Show|MaxSdk\.Show\w+|showRewardedVideo|showInterstitial|ShowRewardedAd|ShowInterstitial)\b/;
  const testFile = TEST_PATH.test(f.rel);
  lines.forEach((ln, i) => {
    const where = `${f.rel}:${i + 1}`;
    if (!testFile && dateRe && dateRe.test(ln)) addDateRead(r, f.rel, i + 1);
    if (testFile) return;
    if (notifRe.test(ln)) {
      const near = lines.slice(Math.max(0, i - 4), i + 10).join("\n");
      const title = near.match(/(?:\.title|setContentTitle|Title)\s*[=(]\s*(?:NSString\.localizedUserNotificationString\(forKey:\s*)?"([^"]{1,80})"/);
      if (!r.notifications.some((n) => n.where === where)) r.notifications.push({ where, title: title ? title[1] : null });
    }
    if (reviewRe.test(ln) && !/^\s*(import|using)\b/.test(ln) && !r.review_prompts.some((p) => p.file === where)) r.review_prompts.push({ file: where, trigger: "" });
    const sdk = ln.match(adSdkRe);
    if (sdk && !/^\s*(import|using)\b/.test(ln)) {
      const fmt = adFormat(sdk[1]) ?? adFormat(ln);
      addAd(r, { key: `${fmt ?? "ad"}_${screenKey(basename(f.rel, f.ext))}`, format: fmt, where, call: where });
    }
    for (const m of ln.matchAll(/"((?:[a-z][a-z0-9_-]*\.){2,}[a-z0-9_.-]+)"/gi)) {
      if (/product|sku|\biap\b|purchase|billing/i.test(ln + (lines[i - 1] ?? "")) && !/\.(png|jpg|json|wav|mp3|plist|storyboard|tscn|gd)$/i.test(m[1]) && !/^(com\.apple|android\.|java\.|kotlin\.|res\.)/.test(m[1]))
        addProduct(r, { id: m[1], where, sure: false });
    }
  });
}

// ---- Swift (SwiftUI, SpriteKit, UIKit) ------------------------------------------------

const PRESENT_RE = /\.(sheet|fullScreenCover|popover|navigationDestination|alert|confirmationDialog)\s*\(/g;
const PRESENT_KIND = { sheet: "sheet", fullScreenCover: "cover", popover: "popover", navigationDestination: "push", alert: "alert", confirmationDialog: "alert" };

function swiftTypes(files) {
  const types = new Map(); // name -> {name, kind, file, line, start, end, private}
  const enums = new Map(); // name -> [cases]
  for (const f of files) {
    const text = f.text;
    for (const m of text.matchAll(/(^|\n)([ \t]*)((?:@\w+\s+)*(?:(?:private|fileprivate|public|internal|final|open)\s+)*)(struct|class|enum)\s+(\w+)\s*(?:<[^>{]*>)?\s*(?::\s*([^{]+))?\{/g)) {
      const [, , indent, mods, what, name, conf = ""] = m;
      const braceAt = m.index + m[0].length - 1;
      const end = matchBracket(text, braceAt);
      if (what === "enum") {
        const body = text.slice(braceAt + 1, end > 0 ? end : undefined);
        const cases = [];
        for (const c of body.matchAll(/\bcase\s+([^\n{]+)/g)) for (const part of c[1].split(",")) {
          const k = part.trim().match(/^(\w+)/);
          if (k && !cases.includes(k[1])) cases.push(k[1]);
        }
        enums.set(name, cases);
        continue;
      }
      let kind = null;
      if (/\bApp\b/.test(conf)) kind = "app";
      else if (/\bView\b/.test(conf)) kind = "view";
      else if (/\bSKScene\b/.test(conf)) kind = "scene";
      else if (/\bUI\w*ViewController\b/.test(conf)) kind = "controller";
      if (!kind) continue;
      types.set(name, { name, kind, file: f, line: lineAt(text, m.index + m[1].length), start: braceAt, end: end > 0 ? end : text.length, private: /private/.test(mods), nested: indent.length > 0 });
    }
  }
  return { types, enums };
}

function viewsIn(snippet, types) {
  const out = [];
  for (const m of snippet.matchAll(/\b([A-Z]\w+)\s*[({]/g)) if (types.get(m[1])?.kind && types.get(m[1]).kind !== "app" && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The enclosing type at an index of a file. */
function ownerAt(types, f, idx) {
  let best = null;
  for (const t of types.values()) if (t.file === f && t.start < idx && idx < t.end && (!best || t.start > best.start)) best = t;
  return best;
}

function scanSwift(r, files) {
  const { types, enums } = swiftTypes(files);
  const key = (name) => screenKey(name);
  const target = new Set();
  const where = (f, idx) => `${f.rel}:${lineAt(f.text, idx)}`;

  for (const f of files) {
    const text = f.text;
    // App root: WindowGroup { RootView() }
    for (const m of text.matchAll(/WindowGroup\s*(?:\([^)]*\))?\s*\{/g)) {
      const end = matchBracket(text, m.index + m[0].length - 1);
      for (const v of viewsIn(text.slice(m.index, end), types)) {
        target.add(v);
        addEdge(r, { from: "launch", to: key(v), kind: "root", trigger: "app start", where: where(f, m.index) });
      }
    }
    // Presentation modifiers.
    for (const m of text.matchAll(PRESENT_RE)) {
      const owner = ownerAt(types, f, m.index);
      if (!owner) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBracket(text, open);
      if (close < 0) continue;
      const args = text.slice(open + 1, close);
      let body = args;
      let k = close + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === "{") body += text.slice(k, matchBracket(text, k) + 1);
      const binding = args.match(/(?:item|isPresented|for)\s*:\s*\$?([\w.]+)/)?.[1] ?? null;
      const kind = PRESENT_KIND[m[1]];
      if (kind === "alert") {
        const title = args.match(/^\s*"([^"]{1,60})"/)?.[1];
        const ak = `${key(owner.name)}_${screenKey(title ?? binding ?? "alert")}`;
        addScreen(r, { key: ak, name: title ?? ak, kind: "alert", where: where(f, m.index), sure: true, why: `.${m[1]} in ${owner.name}` });
        addEdge(r, { from: key(owner.name), to: ak, kind: "alert", trigger: binding ? `${binding} = true` : null, where: where(f, m.index) });
        continue;
      }
      const cases = [...body.matchAll(/\bcase\s+\.(\w+)[^:]*:\s*([^\n]*)/g)];
      const pairs = cases.length ? cases.flatMap((c) => viewsIn(c[2], types).map((v) => [v, c[1]])) : viewsIn(body, types).map((v) => [v, null]);
      for (const [v, caseName] of pairs) {
        target.add(v);
        let trigger = null;
        if (binding) {
          const bare = binding.split(".").pop();
          const re = caseName ? new RegExp(`\\b${bare}\\s*=\\s*\\.${caseName}\\b`) : new RegExp(`\\b${bare}\\s*=\\s*true\\b|\\b${bare}\\.toggle\\(\\)`);
          const owners = [owner.file.text];
          const hit = owners[0].match(re);
          trigger = caseName ? `${bare} = .${caseName}` : `${bare} = true`;
          if (!hit) trigger += " (set elsewhere)";
        }
        addEdge(r, { from: key(owner.name), to: key(v), kind, trigger, where: where(f, m.index) });
      }
    }
    // NavigationLink(destination: X()) and NavigationLink { X() } label: {...}
    for (const m of text.matchAll(/NavigationLink\s*(\(|\{)/g)) {
      const owner = ownerAt(types, f, m.index);
      if (!owner) continue;
      const open = m.index + m[0].length - 1;
      const snippet = text.slice(open, matchBracket(text, open) + 1);
      const dest = snippet.match(/destination\s*:\s*\{?\s*([A-Z]\w+)/)?.[1] ?? (m[1] === "{" ? viewsIn(snippet, types)[0] : null);
      if (dest && types.has(dest)) {
        target.add(dest);
        addEdge(r, { from: key(owner.name), to: key(dest), kind: "push", trigger: "NavigationLink", where: where(f, m.index) });
      }
    }
    // switch on a state inside a view body: `switch session.phase { case .menu: MenuView() ... }`
    for (const m of text.matchAll(/\bswitch\s+([\w.]+)\s*\{/g)) {
      const owner = ownerAt(types, f, m.index);
      if (!owner || owner.kind !== "view") continue;
      const open = m.index + m[0].length - 1;
      const body = text.slice(open, matchBracket(text, open));
      if (/\.sheet|\.fullScreenCover/.test(text.slice(Math.max(0, m.index - 400), m.index))) continue; // handled above
      const cases = [...body.matchAll(/\bcase\s+\.(\w+)[^:]*:\s*([^\n]*)/g)];
      const hits = cases.map((c) => [c[1], viewsIn(c[2], types)]).filter(([, vs]) => vs.length);
      if (hits.length < 2) continue;
      owner.container = true;
      for (const [c, vs] of hits) for (const v of vs) {
        target.add(v);
        addEdge(r, { from: key(owner.name), to: key(v), kind: "state", trigger: `${m[1]} = .${c}`, where: where(f, m.index) });
      }
    }
    // Conditional overlays: `if let r = env.loginReward { LoginRewardCard(...) }`, `if showX { XView() }`
    for (const m of text.matchAll(/\bif\s+((?:let\s+\w+\s*=\s*)?[^{\n]{1,80})\{\s*([A-Z]\w+)\s*[({]/g)) {
      const owner = ownerAt(types, f, m.index);
      const v = m[2];
      const t = types.get(v);
      if (!owner || !t || t.kind !== "view" || owner.name === v) continue;
      if (t.private || t.nested) continue;
      // Only views that look like a screen of their own: a screen-like name, or a body that fills the screen.
      const tb = t.file.text.slice(t.start, t.end);
      if (!/(View|Screen|Sheet|Popup|Dialog|Card|Ceremony|Celebration|Reward|Banner|Overlay|Modal|Panel|Prompt|Offer)$/.test(v) && !/ignoresSafeArea|maxHeight:\s*\.infinity/.test(tb)) continue;
      target.add(v);
      addEdge(r, { from: key(owner.name), to: key(v), kind: /debug/i.test(v) ? "debug" : "overlay", trigger: m[1].trim(), where: where(f, m.index) });
    }
    // SpriteKit and UIKit transitions.
    for (const m of text.matchAll(/presentScene\s*\(\s*([A-Z]\w+)|\b(?:present|pushViewController|show)\s*\(\s*([A-Z]\w+)\s*\(/g)) {
      const owner = ownerAt(types, f, m.index);
      const v = m[1] ?? m[2];
      if (!owner || !types.has(v)) continue;
      target.add(v);
      addEdge(r, { from: key(owner.name), to: key(v), kind: m[1] ? "scene" : "push", trigger: null, where: where(f, m.index) });
    }
    // SpriteView(scene:) embeds a SpriteKit scene.
    for (const m of text.matchAll(/SpriteView\s*\(\s*scene\s*:/g)) {
      const owner = ownerAt(types, f, m.index);
      if (!owner) continue;
      for (const t of types.values()) if (t.kind === "scene" && !t.private) addEdge(r, { from: key(owner.name), to: key(t.name), kind: "embed", trigger: "SpriteView", where: where(f, m.index) });
    }
  }

  // Tabs: `@State var kind: CosmeticKind = .wick` used by Picker/TabView(selection: $kind).
  const tabsOf = (t) => {
    const body = t.file.text.slice(t.start, t.end);
    const out = [];
    for (const m of body.matchAll(/@State\s+(?:private\s+)?var\s+(\w+)\s*:\s*(\w+)\s*=\s*\.(\w+)/g)) {
      if (!new RegExp(`(Picker|TabView)\\s*\\([^)]*selection\\s*:\\s*\\$${m[1]}\\b`).test(body)) continue;
      const cases = enums.get(m[2]);
      if (cases && cases.length > 1 && cases.length <= 12) out.push({ state: m[1], type: m[2], values: cases });
    }
    return out.length ? out : null;
  };

  for (const t of types.values()) {
    if (t.kind === "app") continue;
    const k = key(t.name);
    const w = `${t.file.rel}:${t.line}`;
    const edgeIn = r.edges.find((e) => e.to === k);
    if (t.container && !edgeIn?.kind?.match(/sheet|cover|push/)) {
      addScreen(r, { key: k, name: t.name, kind: "container", where: w, sure: true, why: "switches between other screens" });
      continue;
    }
    if (target.has(t.name)) {
      const kind = t.kind === "scene" ? "scene" : edgeIn ? { sheet: "sheet", cover: "modal", popover: "modal", push: "screen", state: "screen", root: "screen", overlay: "overlay", debug: "debug", embed: "scene" }[edgeIn.kind] ?? "screen" : "screen";
      addScreen(r, { key: k, name: t.name, kind, where: w, sure: kind !== "overlay" && kind !== "scene", why: edgeIn ? `${edgeIn.kind} from ${edgeIn.from}` : "presented", tabs: tabsOf(t) });
    } else if (t.kind === "scene" || t.kind === "controller") {
      addScreen(r, { key: k, name: t.name, kind: t.kind === "scene" ? "scene" : "screen", where: w, sure: false, why: `${t.kind} with no transition found` });
    } else if (!t.private && !t.nested && /(View|Screen|Sheet|Page|Popup|Dialog|Overlay|Modal)$/.test(t.name)) {
      r.unsure.push({ where: w, name: t.name, reason: "a view named like a screen, but nothing in the code opens it (subview, or opened another way)" });
    }
  }

  // Products: .storekit files, then ProductID constants.
  for (const f of files.filter((f) => f.ext === ".storekit")) {
    let j;
    try {
      j = JSON.parse(f.text);
    } catch {
      continue;
    }
    const subs = (j.subscriptionGroups ?? []).flatMap((g) => g.subscriptions ?? []);
    for (const p of [...(j.products ?? []), ...(j.nonRenewingSubscriptions ?? []), ...subs]) {
      if (!p?.productID) continue;
      const type = { Consumable: "consumable", NonConsumable: "non_consumable", RecurringSubscription: "subscription", NonRenewingSubscription: "non_renewing" }[p.type] ?? (p.recurringSubscriptionPeriod ? "subscription" : null);
      addProduct(r, { id: p.productID, type, price: p.displayPrice ? String(p.displayPrice) : null, grants: p.localizations?.[0]?.displayName ?? p.referenceName ?? null, where: f.rel, sure: true });
    }
  }
  // Ad placements: `enum AdPlacement { case doubleXP, ... }` and call sites `placement: .doubleXP`.
  for (const [name, cases] of enums) {
    if (!/Ad\w*Placement|Placement\w*Ad|AdSlot|AdUnit/.test(name)) continue;
    const def = files.find((f) => new RegExp(`enum\\s+${name}\\b`).test(f.text));
    const fmt = def ? adFormat(def.text) ?? "rewarded" : null;
    for (const c of cases) {
      addAd(r, { key: screenKey(c), format: fmt, where: def ? `${def.rel}:${lineAt(def.text, def.text.search(new RegExp(`enum\\s+${name}\\b`)))}` : null });
      for (const f of files) for (const m of f.text.matchAll(new RegExp(`placement\\s*:\\s*\\.${c}\\b|${name}\\.${c}\\b`, "g"))) addAd(r, { key: screenKey(c), call: `${f.rel}:${lineAt(f.text, m.index)}` });
    }
  }
  // Currencies: stored Int properties named like a currency, in save/progress/wallet types.
  for (const f of files) {
    if (TEST_PATH.test(f.rel)) continue;
    for (const m of f.text.matchAll(/\b(?:var|let)\s+(\w+)\s*(?::\s*Int\b[^=\n]*)?=?\s*([0-9]+)?/g)) {
      const n = m[1].toLowerCase();
      if (CURRENCY_WORDS.has(n) && (m[2] !== undefined || /:\s*Int/.test(m[0]))) addCurrency(r, n, `${f.rel}:${lineAt(f.text, m.index)}`, "stored count named like a currency");
    }
  }
}

// ---- Kotlin / Java (Android) ------------------------------------------------------------

function scanKotlin(r, files) {
  const funs = []; // composable funs with ranges
  for (const f of files) {
    if (f.ext !== ".kt" && f.ext !== ".java") continue;
    for (const m of f.text.matchAll(/@Composable[\s\S]{0,120}?\bfun\s+(\w+)\s*\(/g)) {
      const brace = f.text.indexOf("{", m.index + m[0].length);
      funs.push({ name: m[1], file: f, start: m.index, end: brace > 0 ? matchBracket(f.text, brace) : m.index, line: lineAt(f.text, m.index) });
    }
  }
  const funAt = (f, idx) => funs.filter((x) => x.file === f && x.start < idx && idx < x.end).sort((a, b) => b.start - a.start)[0];
  const routeOf = new Map(); // fun name -> route key
  const routeBlocks = []; // {file, start, end, key}: navigate() inside composable("x") { ... } comes from x
  for (const f of files) {
    const text = f.text;
    // AndroidManifest activities.
    if (f.name === "AndroidManifest.xml") {
      for (const m of text.matchAll(/<activity\b[^>]*android:name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/activity>)/g)) {
        const name = m[1].split(".").pop();
        const k = screenKey(name);
        addScreen(r, { key: k, name, kind: "screen", where: `${f.rel}:${lineAt(text, m.index)}`, sure: true, why: "activity in AndroidManifest" });
        if (/android\.intent\.category\.LAUNCHER/.test(m[3] ?? "")) addEdge(r, { from: "launch", to: k, kind: "root", trigger: "app start", where: `${f.rel}:${lineAt(text, m.index)}` });
      }
      continue;
    }
    if (f.ext !== ".kt" && f.ext !== ".java") continue;
    // NavHost routes: composable("shop") { ShopScreen(...) }
    for (const m of text.matchAll(/\bcomposable\s*(?:<(\w+)>)?\s*\(\s*(?:route\s*=\s*)?(?:"([^"]+)"|(\w+(?:\.\w+)*))?[^)]*\)\s*\{/g)) {
      const route = (m[2] ?? m[1] ?? m[3] ?? "").split("/")[0].split("?")[0].split(".").pop();
      if (!route) continue;
      const k = screenKey(route);
      const open = m.index + m[0].length - 1;
      const close = matchBracket(text, open);
      const body = text.slice(open, close);
      routeBlocks.push({ file: f, start: open, end: close, key: k });
      const fn = body.match(/\b([A-Z]\w+)\s*\(/)?.[1];
      if (fn) routeOf.set(fn, k);
      addScreen(r, { key: k, name: fn ?? route, kind: "screen", where: `${f.rel}:${lineAt(text, m.index)}`, sure: true, why: "NavHost route" });
    }
    for (const m of text.matchAll(/\bstartDestination\s*=\s*"([^"]+)"/g)) addEdge(r, { from: "launch", to: screenKey(m[1].split("/")[0]), kind: "root", trigger: "NavHost start", where: `${f.rel}:${lineAt(text, m.index)}` });
  }
  for (const f of files) {
    if (f.ext !== ".kt" && f.ext !== ".java") continue;
    const text = f.text;
    const fromKey = (idx) => {
      const block = routeBlocks.filter((b) => b.file === f && b.start < idx && idx < b.end).sort((a, b) => b.start - a.start)[0];
      if (block) return block.key;
      const fn = funAt(f, idx);
      return fn ? routeOf.get(fn.name) ?? screenKey(fn.name) : screenKey(basename(f.rel, f.ext));
    };
    for (const m of text.matchAll(/\.navigate\s*\(\s*"([^"/?]+)/g)) addEdge(r, { from: fromKey(m.index), to: screenKey(m[1]), kind: "push", trigger: `navigate("${m[1]}")`, where: `${f.rel}:${lineAt(text, m.index)}` });
    for (const m of text.matchAll(/Intent\s*\(\s*[\w@.]+\s*,\s*(\w+)::class\.java\s*\)|Intent\s*\(\s*\w+\s*,\s*(\w+)\.class\s*\)/g)) {
      const to = m[1] ?? m[2];
      addEdge(r, { from: screenKey(basename(f.rel, f.ext)), to: screenKey(to), kind: "push", trigger: "startActivity", where: `${f.rel}:${lineAt(text, m.index)}` });
    }
    for (const m of text.matchAll(/\bif\s*\(([^)]{1,80})\)\s*\{\s*(AlertDialog|Dialog|ModalBottomSheet|BottomSheetDialog|[A-Z]\w*(?:Dialog|Sheet|Popup))\s*\(/g)) {
      const from = fromKey(m.index);
      const k = `${from}_${screenKey(m[2] === "AlertDialog" || m[2] === "Dialog" || m[2] === "ModalBottomSheet" ? m[1].replace(/^show/i, "") : m[2])}`;
      addScreen(r, { key: k, name: m[2], kind: "modal", where: `${f.rel}:${lineAt(text, m.index)}`, sure: true, why: `${m[2]} shown when ${m[1].trim()}` });
      addEdge(r, { from, to: k, kind: "sheet", trigger: m[1].trim(), where: `${f.rel}:${lineAt(text, m.index)}` });
    }
    // Play Billing product ids.
    for (const m of text.matchAll(/setProductId\s*\(\s*"([^"]+)"\s*\)(?:[\s\S]{0,120}?ProductType\.(INAPP|SUBS))?/g))
      addProduct(r, { id: m[1], type: m[2] === "SUBS" ? "subscription" : m[2] === "INAPP" ? "in_app" : null, where: `${f.rel}:${lineAt(text, m.index)}`, sure: true });
    for (const m of text.matchAll(/\b(?:val|var)\s+(\w+)\s*(?::\s*Int\b)?\s*(?:by\s+\w+\s*[({]\s*)?(?:mutable\w*StateOf\s*\()?\s*([0-9]+)/g)) {
      const n = m[1].toLowerCase();
      if (CURRENCY_WORDS.has(n)) addCurrency(r, n, `${f.rel}:${lineAt(text, m.index)}`, "stored count named like a currency");
    }
  }
  const routed = new Set(routeOf.keys());
  for (const fn of funs) {
    if (routed.has(fn.name) || !/(Screen|Dialog|Sheet|Popup)$/.test(fn.name)) continue;
    if (r.screens.some((s) => s.key === screenKey(fn.name))) continue;
    r.unsure.push({ where: `${fn.file.rel}:${fn.line}`, name: fn.name, reason: "a composable named like a screen, but no route or dialog opens it" });
  }
}

// ---- Godot 4 ----------------------------------------------------------------------------

const GODOT_POPUP = /^(Popup|PopupPanel|PopupMenu|Window|AcceptDialog|ConfirmationDialog|FileDialog)$/;

function scanGodot(r, files) {
  const proj = files.find((f) => f.name === "project.godot");
  const main = proj?.text.match(/run\/main_scene\s*=\s*"res:\/\/([^"]+)"/)?.[1];
  const scriptScenes = new Map(); // script rel path -> [scene keys]
  const sceneKey = (rel) => screenKey(basename(rel, ".tscn"));
  for (const f of files.filter((f) => f.ext === ".tscn")) {
    if (TEST_PATH.test(f.rel)) continue;
    const k = sceneKey(f.rel);
    const root = f.text.match(/\[node name="([^"]+)" type="(\w+)"/);
    const kind = root && /^(Control|CanvasLayer|Panel|MarginContainer|VBoxContainer|CenterContainer)$/.test(root[2]) ? "screen" : root && /^Node(2D|3D)?$/.test(root[2]) ? "scene" : "screen";
    addScreen(r, { key: k, name: basename(f.rel), kind, where: f.rel, sure: true, why: "Godot scene" });
    for (const m of f.text.matchAll(/\[ext_resource[^\]]*type="Script"[^\]]*path="res:\/\/([^"]+)"/g)) scriptScenes.set(m[1], [...(scriptScenes.get(m[1]) ?? []), k]);
    for (const m of f.text.matchAll(/\[node name="([^"]+)" type="(\w+)" parent="([^"]*)"[^\]]*\]([\s\S]*?)(?=\n\[|$)/g)) {
      const [, name, type, , props] = m;
      const popup = GODOT_POPUP.test(type);
      const hidden = /\bvisible\s*=\s*false/.test(props) && /(Panel|Popup|Screen|Menu|Dialog|Shop|Store|Offer|Reward|Settings|Pause|Result|Win|Lose|GameOver)$/i.test(name);
      if (!popup && !hidden) continue;
      const pk = `${k}_${screenKey(name)}`;
      addScreen(r, { key: pk, name, kind: "modal", where: `${f.rel}:${lineAt(f.text, m.index)}`, sure: popup, why: popup ? `${type} node` : "hidden panel node" });
      addEdge(r, { from: k, to: pk, kind: "sheet", trigger: null, where: `${f.rel}:${lineAt(f.text, m.index)}` });
    }
  }
  if (main) addEdge(r, { from: "launch", to: sceneKey(main), kind: "root", trigger: "main scene", where: "project.godot" });
  for (const f of files.filter((f) => f.ext === ".gd")) {
    if (TEST_PATH.test(f.rel)) continue;
    const owners = scriptScenes.get(f.rel) ?? [screenKey(basename(f.rel, ".gd"))];
    const text = f.text;
    for (const m of text.matchAll(/change_scene_to_(?:file|packed)\s*\(\s*(?:preload|load)?\s*\(?\s*"res:\/\/([^"]+\.tscn)"/g))
      for (const o of owners) addEdge(r, { from: o, to: sceneKey(m[1]), kind: "scene", trigger: "change_scene", where: `${f.rel}:${lineAt(text, m.index)}` });
    for (const m of text.matchAll(/(?:preload|load)\s*\(\s*"res:\/\/([^"]+\.tscn)"\s*\)(?:\.instantiate\(\))?/g)) {
      const after = text.slice(m.index, m.index + 200);
      if (!/instantiate|add_child/.test(after)) continue;
      for (const o of owners) addEdge(r, { from: o, to: sceneKey(m[1]), kind: "overlay", trigger: "instantiate", where: `${f.rel}:${lineAt(text, m.index)}` });
    }
    for (const m of text.matchAll(/\$(?:"([^"]+)"|([\w/]+))\.(popup(?:_centered\w*)?|show)\s*\(/g)) {
      const node = (m[1] ?? m[2]).split("/").pop();
      for (const o of owners) {
        const pk = `${o}_${screenKey(node)}`;
        const e = r.edges.find((x) => x.from === o && x.to === pk);
        if (e) e.trigger = `$${node}.${m[3]}()`;
      }
    }
    for (const m of text.matchAll(/\bvar\s+(\w+)\s*(?::\s*int)?\s*:?=\s*([0-9]+)/g)) {
      const n = m[1].toLowerCase();
      if (CURRENCY_WORDS.has(n)) addCurrency(r, n, `${f.rel}:${lineAt(text, m.index)}`, "stored count named like a currency");
    }
  }
}

// ---- Unity --------------------------------------------------------------------------------

const UNITY_PANEL = /(Panel|Popup|Screen|Window|Dialog|Menu|Shop|Store|Offer|Result|Settings|Pause|Reward|Win|Lose|GameOver|Hud|HUD)$/;

function scanUnity(r, files, all) {
  const build = files.find((f) => /ProjectSettings\/EditorBuildSettings\.asset$/.test(f.rel));
  const inBuild = build ? [...build.text.matchAll(/enabled:\s*1\s*\n\s*path:\s*(\S+\.unity)/g)].map((m) => m[1]) : [];
  const sceneKey = (p) => screenKey(basename(p, ".unity"));
  const scenes = all.filter((f) => f.ext === ".unity" && f.rel.startsWith("Assets/") && !TEST_PATH.test(f.rel));
  for (const s of scenes) addScreen(r, { key: sceneKey(s.rel), name: basename(s.rel), kind: "scene", where: s.rel, sure: !build || inBuild.includes(s.rel), why: inBuild.includes(s.rel) ? "scene in Build Settings" : "scene file" });
  if (inBuild[0]) addEdge(r, { from: "launch", to: sceneKey(inBuild[0]), kind: "root", trigger: "first scene in Build Settings", where: build.rel });
  // Which scene uses which script: a script's .meta guid appears in the scene file.
  const guidOf = new Map();
  for (const f of files.filter((f) => f.rel.endsWith(".cs.meta"))) {
    const g = f.text.match(/guid:\s*([0-9a-f]{32})/)?.[1];
    if (g) guidOf.set(f.rel.replace(/\.meta$/, ""), g);
  }
  const sceneText = new Map();
  for (const s of scenes) sceneText.set(s.rel, read(s) ?? "");
  const ownersOf = (rel) => {
    const g = guidOf.get(rel);
    const hit = g ? scenes.filter((s) => sceneText.get(s.rel).includes(g)).map((s) => sceneKey(s.rel)) : [];
    return hit.length ? hit : [screenKey(basename(rel, ".cs"))];
  };
  for (const p of all.filter((f) => f.ext === ".prefab" && f.rel.startsWith("Assets/") && UNITY_PANEL.test(basename(f.rel, ".prefab"))))
    addScreen(r, { key: screenKey(basename(p.rel, ".prefab")), name: basename(p.rel), kind: "modal", where: p.rel, sure: false, why: "prefab named like a panel" });
  for (const f of files.filter((f) => f.ext === ".cs")) {
    if (TEST_PATH.test(f.rel)) continue;
    const text = f.text;
    const owners = ownersOf(f.rel);
    for (const m of text.matchAll(/SceneManager\.LoadScene(?:Async)?\s*\(\s*(?:"([^"]+)"|(\w+))/g)) {
      const to = m[1] ? screenKey(m[1]) : null;
      if (!to) {
        r.unsure.push({ where: `${f.rel}:${lineAt(text, m.index)}`, name: m[2], reason: "LoadScene with a variable or index; read it to see which scene" });
        continue;
      }
      for (const o of owners) addEdge(r, { from: o, to, kind: "scene", trigger: `LoadScene("${m[1]}")`, where: `${f.rel}:${lineAt(text, m.index)}` });
    }
    for (const m of text.matchAll(/\b(\w+)\.SetActive\s*\(\s*true\s*\)/g)) {
      const field = m[1];
      if (!UNITY_PANEL.test(field) && !UNITY_PANEL.test(field[0].toUpperCase() + field.slice(1))) continue;
      const k = screenKey(field);
      addScreen(r, { key: k, name: field, kind: "modal", where: `${f.rel}:${lineAt(text, m.index)}`, sure: false, why: "panel switched on with SetActive" });
      for (const o of owners) addEdge(r, { from: o, to: k, kind: "sheet", trigger: `${field}.SetActive(true)`, where: `${f.rel}:${lineAt(text, m.index)}` });
    }
    for (const m of text.matchAll(/AddProduct\s*\(\s*"([^"]+)"\s*,\s*ProductType\.(\w+)/g))
      addProduct(r, { id: m[1], type: { Consumable: "consumable", NonConsumable: "non_consumable", Subscription: "subscription" }[m[2]] ?? null, where: `${f.rel}:${lineAt(text, m.index)}`, sure: true });
    for (const m of text.matchAll(/\b(?:public|private|protected|internal)?\s*(?:static\s+)?int\s+(\w+)\s*(?:=\s*[0-9]+)?\s*;/g)) {
      const n = m[1].toLowerCase().replace(/^_/, "");
      if (CURRENCY_WORDS.has(n)) addCurrency(r, n, `${f.rel}:${lineAt(text, m.index)}`, "stored count named like a currency");
    }
  }
  const catalog = files.find((f) => /IAPProductCatalog\.json$/.test(f.rel));
  if (catalog) {
    try {
      const j = JSON.parse(catalog.text);
      for (const p of j.products ?? []) if (p.id) addProduct(r, { id: p.id, type: [ "consumable", "non_consumable", "subscription" ][p.type] ?? null, price: p.googlePrice?.value ? String(p.googlePrice.value) : null, grants: p.defaultDescription?.Title ?? null, where: catalog.rel, sure: true });
    } catch {}
  }
}

// ---- checklist and inventory -------------------------------------------------------------------

const CAPTURE_KINDS = new Set(["screen", "sheet", "modal", "scene", "overlay", "alert"]);

export function checklist(r) {
  const out = [];
  for (const s of r.screens) {
    if (!CAPTURE_KINDS.has(s.kind)) continue;
    const ins = r.edges.filter((e) => e.to === s.key);
    if (s.kind === "scene" && ins.length && ins.every((e) => e.kind === "embed")) continue; // drawn behind other screens
    const cat = guessCategory(s.key) ?? (r.currencies.some((c) => s.key === c.key || s.key.startsWith(`${c.key}_`)) ? "shop" : null);
    const how = r.edges.find((e) => e.to === s.key);
    const base = { key: s.key, category: cat, open: `screen=${s.key}`, needs: how?.trigger ?? null, from: how?.from ?? null, sure: s.sure && Boolean(cat) };
    if (s.tabs) {
      for (const t of s.tabs) for (const v of t.values) out.push({ ...base, key: `${s.key}_${screenKey(v)}`, open: `screen=${s.key},${t.state}=${v}` });
    } else out.push(base);
  }
  // Each level of the main level list, opened in play (PR 1b): `screen=<play screen>,stage=<id>`.
  const lv = r.levels?.[0];
  if (lv) {
    const play = out.find((c) => c.category === "gameplay")?.key ?? "play";
    for (const it of lv.items)
      out.push({ key: `${lv.param}_${it.key}`, category: "gameplay", open: `screen=${play},${lv.param}=${it.id}`, needs: `${lv.param}=${it.id} in the capture list`, from: null, sure: true, level: it.key });
  }
  return out;
}

/** The main level list for the inventory and the run: count, order, names and the unlock rule. */
export function levelsOf(r) {
  const lv = r.levels?.[0];
  if (!lv) return null;
  return { type: lv.type, where: lv.where, count: lv.count, param: lv.param, unlock_rule: lv.unlock_rule, items: lv.items.map((i) => ({ key: i.key, name: i.name, id: i.id, ...(i.unlock ? { unlock: i.unlock } : {}) })) };
}

/** The draft inventory.json `map start --inventory` accepts (names and file locations only). */
export function toInventory(r) {
  const cl = checklist(r);
  return {
    screens: r.screens
      .filter((s) => CAPTURE_KINDS.has(s.kind) && !(s.kind === "scene" && r.edges.some((e) => e.to === s.key) && r.edges.filter((e) => e.to === s.key).every((e) => e.kind === "embed")))
      .map((s) => ({ key: s.name, where: s.where, screen_keys: cl.filter((c) => c.key === s.key || c.key.startsWith(`${s.key}_`) && s.tabs).map((c) => c.key) })),
    products: r.products.map((p) => ({ id: p.id, type: p.type ?? "unknown", ...(p.price ? { price: p.price } : {}), ...(p.grants ? { grants: p.grants } : {}) })),
    ads: r.ads.map((a) => ({ key: a.key, format: a.format ?? "unknown", where: a.where ?? a.calls[0] ?? "" })),
    currencies: r.currencies.map((c) => ({ key: c.key, kind: "unknown" })),
    events: [],
    review_prompts: r.review_prompts,
    ...(levelsOf(r) ? { levels: levelsOf(r) } : {}),
  };
}

// ---- entry ----------------------------------------------------------------------------------

export function scanRepo(src, o = {}) {
  if (!src || !existsSync(src) || !statSync(src).isDirectory()) throw new Error(`--src must be the game's repo folder (not found: ${src})`);
  const all = walk(src);
  const engine = o.engine && o.engine !== "auto" ? o.engine : detectEngine(all);
  const r = newResult(src, engine);
  const wantExt = { swift: [".swift", ".storekit", ".json"], kotlin: [".kt", ".java", ".xml", ".json"], godot: [".gd", ".tscn", ".godot"], unity: [".cs", ".asset", ".json"] }[engine] ?? [...READ_EXT];
  const files = [];
  for (const f of all) {
    if (!wantExt.includes(f.ext) && !(engine === "unity" && f.rel.endsWith(".cs.meta"))) continue;
    if (f.ext === ".json" && !/(IAPProductCatalog|\.storekit)/.test(f.name)) continue;
    if (f.ext === ".xml" && f.name !== "AndroidManifest.xml") continue;
    if (f.ext === ".asset" && !/EditorBuildSettings\.asset$/.test(f.rel)) continue;
    const raw = read(f);
    if (raw == null) continue;
    const code = [".swift", ".kt", ".java", ".cs"].includes(f.ext);
    f.text = code ? stripComments(raw) : f.ext === ".gd" ? stripComments(raw, true) : raw;
    files.push(f);
  }
  r.files_read = files.length;
  if (engine === "swift") scanSwift(r, files);
  else if (engine === "kotlin") scanKotlin(r, files);
  else if (engine === "godot") scanGodot(r, files);
  else if (engine === "unity") scanUnity(r, files, all);
  else r.unsure.push({ where: ".", name: null, reason: "engine not recognised; pass --engine swift|kotlin|godot|unity, or write inventory.json by hand (SKILL.md step 2)" });
  const lang = { swift: "swift", kotlin: "kotlin", unity: "cs", godot: "gd" }[engine];
  for (const f of files) if ([".swift", ".kt", ".java", ".cs", ".gd"].includes(f.ext)) commonScan(r, f, f.text, lang);
  r.levels = findLevels(files.filter((f) => !TEST_PATH.test(f.rel)), all);
  for (const l of r.levels.slice(1)) r.unsure.push({ where: l.where, name: l.type, reason: `another list of ${l.count} that may be levels; the scan used ${r.levels[0].type} (${r.levels[0].count})` });
  if (r.levels[0] && !r.levels[0].unlock_rule) r.unsure.push({ where: r.levels[0].where, name: r.levels[0].type, reason: "how each level unlocks was not found in the list; add unlock to inventory.json levels if there is a rule" });
  // Products seen only as loose strings stay unsure unless a store file or billing call confirmed one.
  for (const p of r.products) if (!p.sure) r.unsure.push({ where: p.where, name: p.id, reason: "looks like a store product id; confirm type and price" });
  // Edges that point at a screen the scan never listed (another module, or a name it could not resolve).
  const keys = new Set(r.screens.map((s) => s.key));
  for (const e of r.edges) if (e.to !== "launch" && !keys.has(e.to)) r.unsure.push({ where: e.where, name: e.to, reason: `opened from ${e.from} but its screen was not found` });
  r.checklist = checklist(r);
  for (const c of r.checklist) if (!c.category) r.unsure.push({ where: r.screens.find((s) => c.key.startsWith(s.key))?.where ?? null, name: c.key, reason: "no Gamedexy category guessed from the name; pick one from run-rules.json" });
  return r;
}

export function defaultOut(src) {
  return join(homedir(), ".gamedexy", "scans", screenKey(basename(src)) || "game");
}

export function scan(o) {
  const r = scanRepo(o.src, { engine: o.engine });
  const out = o.out ?? defaultOut(o.src);
  mkdirSync(out, { recursive: true });
  const scanFile = join(out, "scan.json");
  const invFile = join(out, "inventory.json");
  writeFileSync(scanFile, JSON.stringify(r, null, 1));
  writeFileSync(invFile, JSON.stringify(toInventory(r), null, 1));
  const byKind = {};
  for (const s of r.screens) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  return {
    ok: true,
    engine: r.engine,
    files_read: r.files_read,
    screens: byKind,
    to_capture: r.checklist.length,
    edges: r.edges.length,
    products: r.products.length,
    ads: r.ads.length,
    notifications: r.notifications.length,
    review_prompts: r.review_prompts.length,
    date_reads: r.date_reads.reduce((n, d) => n + d.lines.length, 0),
    currencies: r.currencies.map((c) => c.key),
    levels: r.levels[0] ? { type: r.levels[0].type, count: r.levels[0].count, unlock_rule: r.levels[0].unlock_rule, where: r.levels[0].where } : null,
    unsure: r.unsure.length,
    scan: scanFile,
    inventory: invFile,
    next: r.unsure.length
      ? `Read only the files under "unsure" in ${scanFile}, fix inventory.json, then pass it to map start --inventory.`
      : `Check inventory.json, then pass it to map start --inventory.`,
  };
}
