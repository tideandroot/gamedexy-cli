// `gamedexy map ...`: the capture side of Game Map. The agent decides where to
// go; this tool does the parts that must be exact: screenshots, text reading,
// the no-purchase guard inside every tap, dedupe, provenance, issue hints and
// uploads to the short-lived links Gamedexy hands out.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { accessToken, callTool } from "./auth.mjs";
import { bridge, has, isMac } from "./devices.mjs";
import { lookupGame, resolveGame } from "./games.mjs";
import { freshAndroid, freshIos, parseState, restoreData as restore, stateArgs } from "./fresh.mjs";
import { GUARD_VERSION, blockedText, checkTap, foregroundAlarm, screenAlarm } from "./guard.mjs";
import { appSizeMb, coldStart, layoutOf } from "./measure.mjs";
import { cleanCritique, cleanNotification, clockState, earnRow, fastlaneListing, overlap, parseDays, readDump } from "./extras.mjs";
import { feedbackRow, findHints, parseHints, scrub } from "./hints.mjs";
import { readText, readerName } from "./ocr.mjs";
import { hamming, matchScreen, normText, phash, sameText } from "./phash.mjs";
import { decodePng, encodePng, resize } from "./png.mjs";
import { systemPrompt } from "./prompts.mjs";
import { temporaryWarning } from "./rundir.mjs";
import { LANGS, getTextSize, isDefaultSize, langArgs, langOf, prepareIosDevice, setAndroidAppLang, setTextSize, textSizeOf } from "./variant.mjs";

const THUMB_W = 402;
const utc = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const appendJsonl = (p, row) => appendFileSync(p, JSON.stringify(row) + "\n");

function loadRun(dir) {
  const p = join(dir, "run.json");
  if (!existsSync(p)) throw new Error(`No run in ${dir}. Start one with: gamedexy map start --dir ${dir} ...`);
  return JSON.parse(readFileSync(p, "utf8"));
}
const saveRun = (dir, run) => writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 2));

function git(src, args) {
  try {
    return execFileSync("git", ["-C", src, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function appInfo(appPath) {
  // iOS .app bundle: read the Info.plist with plutil (macOS), falling back to nothing.
  if (!appPath || !existsSync(join(appPath, "Info.plist")) || !has("plutil")) return {};
  try {
    const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(appPath, "Info.plist")], { encoding: "utf8" }));
    return { version: json.CFBundleShortVersionString ?? null, number: json.CFBundleVersion ?? null, id: json.CFBundleIdentifier ?? null, name: json.CFBundleDisplayName ?? json.CFBundleName ?? null };
  } catch {
    return {};
  }
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-18-2" -> "iOS 18.2"; "Android-15" -> "Android 15". */
export function osLabel(runtime) {
  const r = String(runtime ?? "");
  if (r.startsWith("Android-")) return `Android ${r.slice(8)}`;
  return r.split(".").pop().replace(/^iOS-/, "iOS ").replace(/-/g, ".");
}

// ---- start -------------------------------------------------------------------

/**
 * Signed in (gamedexy login) with --game: the CLI also creates or finds the game, opens the
 * Gamedexy run and sends the inventory, so the agent makes no MCP calls to begin.
 */
export async function startSignedIn(o) {
  // Check the sign-in first, so a refusal leaves no half-started run folder behind.
  if (o.game && !o.callTool) await accessToken();
  // A rejected inventory must not leave an opened run behind (launch gate 2026-11, bug 4).
  const inv = o.inventory ? readInventory(o.inventory) : null;
  const call = o.callTool ?? callTool;
  // Several games could be meant: stop before anything is made, locally or on the server.
  const found = o.game ? await lookupGame(call, { ...o, game: String(o.game) }) : null;
  const local = (o.startFn ?? start)(o); // startFn: a test seam (start() needs a real simulator or emulator)
  if (local.refused || !o.game) return local;
  // Look the account's games up first (slug, then name): reuse a match, list the candidates when several fit.
  const g = await resolveGame(call, { game: String(o.game), platform: o.platform, createNew: o.createNew, ...(o.engine ? { engine: String(o.engine) } : {}), ...(o.genre ? { genre: String(o.genre) } : {}) }, found);
  const r = await call("map_start_run", {
    game: g.game_id,
    ...local.for_map_start_run,
    // Only a name we know: the map leaves "mapped by" out rather than say "unknown agent".
    ...(agentName(o) ? { agent: agentName(o) } : {}),
    ...(o.depth ? { depth: o.depth === "deep" ? "deep" : "quick" } : {}),
  });
  setRun({ dir: o.dir, runId: r.run_id });
  // The rules for this run (taxonomy, limits) go in a file: the agent reads it once when labelling.
  writeFileSync(join(o.dir, "run-rules.json"), JSON.stringify(r, null, 1));
  let inventory = null;
  if (inv) {
    // review_prompts stay in run.json and go with map finish (the store review prompt check).
    const { review_prompts: _prompts, ...rest } = inv;
    inventory = await call("map_set_inventory", { run_id: r.run_id, ...rest });
  }
  const { for_map_start_run: _sent, next: _next, ...rest } = local;
  return {
    ...rest,
    game: { id: g.game_id, slug: g.slug, created: g.created, ...(g.reused ? { reused: true } : {}), map_url: g.map_url },
    ...(g.created === true ? { note: `No game named "${o.game}" existed, so this created a new Game Map game. If it should go to an existing game, start again with --game <slug|id>.` } : {}),
    run_id: r.run_id,
    rules: join(o.dir, "run-rules.json"),
    ...(inventory ? { inventory: "sent" } : { inventory: "not sent: pass --inventory inventory.json (screens, products, ads, currencies, events from the code)" }),
    next: "Launch first: gamedexy map launch --dir <run_dir above> (map start does not open the game). Then play: gamedexy map shot / find / tap. Label with the categories and tags in the rules file. Then gamedexy map send and gamedexy map finish.",
  };
}

/**
 * The inventory as map_set_inventory accepts it, checked before anything starts, so a mistake costs
 * no run and the folder can be used again.
 */
export function validateInventory(inv) {
  const errors = [];
  if (!inv || typeof inv !== "object" || Array.isArray(inv)) return ["The inventory must be one JSON object: {\"screens\": [...], \"products\": [...], \"ads\": [...], \"currencies\": [...], \"events\": [...]}"];
  const need = { screens: "key", products: "id", ads: "key", currencies: "key", events: "key" };
  for (const [list, field] of Object.entries(need)) {
    if (inv[list] === undefined) continue;
    if (!Array.isArray(inv[list])) {
      errors.push(`${list} must be a list`);
      continue;
    }
    inv[list].forEach((it, i) => {
      if (!it || typeof it !== "object" || typeof it[field] !== "string" || !it[field].trim()) errors.push(`${list}[${i}].${field}: required (a string)`);
    });
  }
  (Array.isArray(inv.screens) ? inv.screens : []).forEach((it, i) => {
    if (it && it.screen_keys !== undefined && !(Array.isArray(it.screen_keys) && it.screen_keys.every((k) => typeof k === "string"))) errors.push(`screens[${i}].screen_keys: a list of map screen keys`);
  });
  if (inv.levels !== undefined) {
    const l = inv.levels;
    if (!l || typeof l !== "object" || !Array.isArray(l.items)) errors.push('levels must be {"type", "count", "items": [{"key", "name"}]}');
    else l.items.forEach((it, i) => {
      if (!it || typeof it.key !== "string" || !it.key.trim()) errors.push(`levels.items[${i}].key: required (a string)`);
    });
  }
  return errors;
}

export function readInventory(file) {
  let inv;
  try {
    inv = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it, then run map start again (nothing was started).`);
  }
  const errors = validateInventory(inv);
  if (errors.length) throw new Error(`${file} is not an inventory Gamedexy accepts (nothing was started): ${errors.slice(0, 8).join("; ")}`);
  return inv;
}

export function start(o) {
  const dir = o.dir;
  if (existsSync(join(dir, "run.json"))) throw new Error(`${dir} already has a run. Use a new folder for a new run.`);
  if (o.inventory) readInventory(o.inventory);
  const b = bridge(o.platform);
  // The bundle id comes from the build when there is one: a wrong --app-id only fails later, at launch.
  const fromApp = o.app ? appInfo(o.app).id : null;
  if (fromApp && o.appId && fromApp !== o.appId) throw new Error(`--app-id ${o.appId} does not match the build at --app (${fromApp}). Use --app-id ${fromApp}.`);
  o = { ...o, appId: o.appId ?? fromApp };
  if (!o.appId) throw new Error("--app-id is required (or pass --app with the built .app)");
  const dev = b.device(o.device);
  // A fresh install happens before anything is recorded, so a refusal leaves no run behind.
  let fresh = null;
  if (o.fresh) {
    fresh = o.platform === "ios" ? freshIos({ device: dev.udid, appId: o.appId, app: o.app, dir }) : freshAndroid({ device: dev.udid, appId: o.appId, dir, noBackup: o.noBackup });
    if (fresh.refused) return fresh;
  }
  mkdirSync(join(dir, "shots"), { recursive: true });
  const info = o.platform === "android" ? b.versionOf(dev.udid, o.appId) : appInfo(o.app);
  const commit = o.src ? git(o.src, ["rev-parse", "--short", "HEAD"]) : null;
  const dirty = o.src ? Boolean(git(o.src, ["status", "--porcelain", "--untracked-files=no"])) : null;
  const run = {
    schema: "gamedexy.map.run/1",
    guard: GUARD_VERSION,
    platform: o.platform,
    device: dev.udid,
    device_name: String(dev.name ?? "").replace(/^Gamedexy Map - /, ""),
    os: osLabel(dev.runtime),
    app_id: o.appId,
    started_utc: utc(),
    build: { version: o.version ?? info.version ?? null, number: o.build ?? info.number ?? null, commit, dirty },
    image_format: isMac && has("sips") ? "jpeg" : "png",
    seeded_from_step: null,
    run_id: null,
    fresh,
    states: [],
    launches: [],
    app_size_mb: appSizeMb(o.app),
    app_name: info.name ?? null,
    variant: {},
    hints: null,
    depth: o.depth === "deep" ? "deep" : o.depth === "quick" ? "quick" : null,
    // Local only (run.json never leaves the machine): lets `map store` find fastlane files.
    src: o.src ?? null,
  };
  const h = o.src ? findHints(o.src) : null;
  if (h) run.hints = { file: h.file, ...parseHints(h.text) };
  if (o.inventory) {
    const inv = readInventory(o.inventory);
    run.review_prompts = reviewPrompts(inv);
    if (inv.levels) run.levels = levelSummary(inv.levels);
  }
  saveRun(dir, run);
  // Shaped for the map_start_run tool.
  const tmpWarn = temporaryWarning(dir);
  return {
    folder: dir,
    run_dir: resolve(dir),
    ...(tmpWarn ? { warning: tmpWarn } : {}),
    ...(fresh ? { fresh } : {}),
    for_map_start_run: { rights_basis: "own_build", build: run.build, device: { name: run.device_name, os: run.os } },
    ...(run.hints ? { hints: { file: run.hints.file, goals: run.hints.goals.map((g) => g.key), next: "Read the full hints with: gamedexy map hints --dir <folder>" } } : o.src ? { hints: null, tip: "No gamedexy.map.md in the repo. Draft one from the code with: gamedexy hints init --src <repo> (ask the developer first)" } : {}),
    next: "Call map_start_run with these values, then: gamedexy map set-run --dir <folder> --run-id <run_id>",
  };
}

/** The level list from inventory.json (names, order and unlock values only), capped for the stats. */
export function levelSummary(l) {
  const items = (l.items ?? []).slice(0, 200).map((it, i) => ({
    key: String(it.key).slice(0, 60),
    ...(it.name ? { name: String(it.name).slice(0, 60) } : {}),
    id: Number.isFinite(Number(it.id)) ? Number(it.id) : i,
    ...(it.unlock && Number.isFinite(Number(it.unlock.value)) ? { unlock: { field: String(it.unlock.field ?? "").slice(0, 40), value: Number(it.unlock.value) } } : {}),
  }));
  return { type: String(l.type ?? "level").slice(0, 40), count: Number(l.count) || items.length, param: String(l.param ?? "level").slice(0, 20), unlock_rule: l.unlock_rule ? String(l.unlock_rule).slice(0, 80) : null, items };
}

/** Which levels this run showed: captured (map capture) or opened with a `<param>=<id>` launch state. */
export function levelsReached(dir, run) {
  if (!run.levels) return null;
  const caps = readJsonl(join(dir, "captures.jsonl")).filter((c) => c.ok);
  const states = (run.launches ?? []).map((l) => l.state ?? "");
  const p = run.levels.param;
  const reached = run.levels.items.filter((it) => caps.some((c) => c.level === it.key) || states.some((s) => new RegExp(`(^|,)${p}=${it.id}(,|$)`).test(s))).map((it) => it.key);
  return { ...run.levels, reached, reached_count: reached.length };
}

const AGENT_UNKNOWN = /^(unknown|unknown agent|none|agent)$/i;
function agentName(o) {
  const a = String(o.agent ?? process.env.GAMEDEXY_AGENT ?? (process.env.CLAUDECODE ? "Claude Code" : "")).trim();
  return a && !AGENT_UNKNOWN.test(a) ? a.slice(0, 80) : null;
}

/** Where the code asks for an App Store or Google Play review (inventory.json review_prompts): file and trigger only. */
export function reviewPrompts(inv) {
  const list = Array.isArray(inv?.review_prompts) ? inv.review_prompts : [];
  return list
    .filter((x) => x && typeof x === "object")
    .map((x) => ({ file: String(x.file ?? "").slice(0, 200), trigger: String(x.trigger ?? "").slice(0, 300) }))
    .filter((x) => x.file || x.trigger)
    .slice(0, 20);
}

export function setRun(o) {
  const run = loadRun(o.dir);
  run.run_id = o.runId;
  saveRun(o.dir, run);
  return { ok: true, run_id: o.runId };
}

// ---- images ------------------------------------------------------------------

function writeImages(run, pngPath, base) {
  if (run.image_format === "jpeg") {
    const full = `${base}_f.jpg`;
    const thumb = `${base}_t.jpg`;
    spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", pngPath, "--out", full], { stdio: "ignore" });
    spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "--resampleWidth", String(THUMB_W), pngPath, "--out", thumb], { stdio: "ignore" });
    if (existsSync(full) && existsSync(thumb)) return { full, thumb, type: "image/jpeg" };
  }
  const img = decodePng(readFileSync(pngPath));
  const full = `${base}_f.png`;
  const thumb = `${base}_t.png`;
  writeFileSync(full, encodePng(resize(img, 600)));
  writeFileSync(thumb, encodePng(resize(img, THUMB_W)));
  return { full, thumb, type: "image/png" };
}

function capture(run, path) {
  const b = bridge(run.platform);
  if (run.platform === "android") b.screenshot(run.device, path, writeFileSync);
  else b.screenshot(run.device, path);
  return decodePng(readFileSync(path));
}

function textBoxes(run, pngPath) {
  const reader = readerName();
  const boxes = readText(pngPath);
  if (boxes.length || run.platform !== "android") return { boxes, source: boxes.length ? reader : "none", reader };
  const ui = bridge("android").uiText(run.device);
  return { boxes: ui, source: ui.length ? "ui-dump" : "none", reader };
}

/**
 * The guard cannot judge a screen it cannot read. With no text reader on this machine and no
 * text in the Android UI dump (every canvas game: Godot, Unity, Cocos), a tap could land on a
 * price, so it is refused. A reader that ran and found no text is different: that screen has
 * nothing to refuse. Found on the first Android run, 2026-11-10.
 */
export function guardBlind(step) {
  return step.text_source === "none" && step.reader === null;
}

// ---- shot ----------------------------------------------------------------------

export async function shot(o) {
  const run = loadRun(o.dir);
  const b = bridge(run.platform);
  const stepsPath = join(o.dir, "steps.jsonl");
  const steps = readJsonl(stepsPath);
  const n = steps.length + 1;
  mkdirSync(join(o.dir, "shots"), { recursive: true }); // a run folder made by hand, or cleaned, still works
  const base = join(o.dir, "shots", String(n).padStart(4, "0"));
  const png = `${base}.png`;
  const img = capture(run, png);
  const { boxes, source, reader } = textBoxes(run, png);
  const text = boxes.map((x) => x.text).join(" ");
  const hash = phash(img);
  const repeat = matchScreen(hash, text, steps);
  const screen = repeat ?? `s${String(steps.filter((s) => s.new).length + 1).padStart(2, "0")}`;
  let alarm = screenAlarm(text);
  if (!alarm && run.platform === "android") {
    const fg = b.foreground(run.device);
    const f = foregroundAlarm(fg.pkg, fg.activity, run.app_id);
    if (f === "billing") alarm = "purchase-sheet";
  }
  const running = b.running(run.device, run.app_id);
  // Before the first map launch the game is simply not open yet: not a crash (launch gate 2026-11).
  const notLaunched = !running && !(run.launches ?? []).length;
  if (!running && !notLaunched) {
    // The Android back key closing the game is a design issue, not a crash.
    const lastInput = readJsonl(join(o.dir, "taps.jsonl")).at(-1);
    const byBack = lastInput?.key === "back" && lastInput.after_step === steps.at(-1)?.step;
    appendJsonl(
      join(o.dir, "issues.jsonl"),
      byBack
        ? { step: n, kind: "back_exits", detail: "The Android back key closed the game without asking", source: "cli", candidate: true }
        : { step: n, kind: "crash", detail: `App not running after "${o.action}"`, source: "cli" },
    );
  }
  const files = writeImages(run, png, base);
  const seeded = run.seeded_from_step !== null && n >= run.seeded_from_step;
  let layout = null;
  try {
    layout = layoutOf(img, boxes, run.platform === "ios" ? b.scale(img.width) : 1);
  } catch {
    layout = null; // measurements are extra; never fail a screenshot over them
  }
  const prompt = systemPrompt(text);
  const variant = Object.keys(run.variant ?? {}).length ? { ...run.variant } : null;
  appendJsonl(stepsPath, {
    step: n, utc: utc(), action: o.action, note: o.note ?? null, screen, new: repeat === null, seeded,
    phash: hash, width: img.width, height: img.height, text, text_source: source, reader, boxes, alarm, running,
    full: files.full, thumb: files.thumb, image_type: files.type, layout, prompt, variant, day: run.current_day ?? null,
  });
  return {
    step: n,
    screen,
    new: repeat === null,
    ...(repeat ? { same_as: repeat } : { look_at: files.thumb }),
    alarm: alarm ?? undefined,
    ...(prompt ? { system_prompt: prompt, tip: "A system permission prompt. Prefer the privacy answer (Don't Allow / Ask App Not to Track) unless the run needs it." } : {}),
    ...(variant ? { variant } : {}),
    app_running: running,
    ...(notLaunched ? { tip: "The game is not open yet. Run gamedexy map launch --dir <folder>, then take a shot." } : {}),
    text: text.slice(0, 400),
    ...(alarm === "purchase-sheet" ? { stop: "A purchase sheet is open. Do not tap it. Run `gamedexy map back` or relaunch, and never confirm." } : {}),
  };
}

// ---- find ----------------------------------------------------------------------

export function find(o) {
  const run = loadRun(o.dir);
  const last = readJsonl(join(o.dir, "steps.jsonl")).at(-1);
  if (!last) throw new Error("Take a screenshot first: gamedexy map shot");
  const scale = run.platform === "ios" ? bridge("ios").scale(last.width) : 1;
  const want = o.text.toLowerCase();
  return last.boxes
    .filter((x) => x.text.toLowerCase().includes(want))
    .map((x) => ({ text: x.text, x: Math.round((x.x0 + x.x1) / 2 / scale), y: Math.round((x.y0 + x.y1) / 2 / scale) }));
}

// ---- input (guard inside) ----------------------------------------------------

/** iOS: refuse input when another app (Settings, the home screen) is in front of the game. */
function leftGame(run) {
  if (run.platform !== "ios" || !run.app_name) return null;
  const front = bridge("ios").frontApp(run.device);
  return front && front !== run.app_name ? `left-game: ${front} is in front, not ${run.app_name}` : null;
}

async function freshStep(o, run) {
  const steps = readJsonl(join(o.dir, "steps.jsonl"));
  const taps = readJsonl(join(o.dir, "taps.jsonl"));
  const last = steps.at(-1);
  // The guard must judge the screen as it is now: re-shoot if anything was sent since the last screenshot.
  if (!last || taps.some((t) => t.after_step === last.step && t.sent)) {
    await shot({ dir: o.dir, action: "auto: screenshot before input" });
    return readJsonl(join(o.dir, "steps.jsonl")).at(-1);
  }
  return last;
}

export async function tap(o) {
  const run = loadRun(o.dir);
  const b = bridge(run.platform);
  if (!b.driver()) throw new Error("No input tool found. Run `gamedexy doctor`.");
  const last = await freshStep(o, run);
  const scale = run.platform === "ios" ? b.scale(last.width) : 1;
  // A system permission prompt sits over the game and belongs to the run; answering it is allowed.
  let reason = last.alarm === "purchase-sheet" ? "purchase sheet on screen" : (last.prompt ? null : leftGame(run)) ?? checkTap(last.boxes, o.x * scale, o.y * scale, last.width);
  if (!reason && last.text_source === "none" && run.platform === "android") {
    const fg = b.foreground(run.device);
    if (foregroundAlarm(fg.pkg, fg.activity, run.app_id) === "billing") reason = "billing screen in front";
  }
  if (!reason && guardBlind(last)) reason = "guard-blind: no text reader on this machine, so prices cannot be checked";
  const row = { utc: utc(), after_step: last.step, x: o.x, y: o.y, hold: o.hold ?? 0, label: o.label ?? "", allowed: !reason, reason, sent: false, checked_with: last.text_source };
  if (reason) {
    appendJsonl(join(o.dir, "taps.jsonl"), row);
    return { refused: reason, hint: reason.startsWith("left-game") ? "Another app is in front. Relaunch the game (gamedexy map launch) and take a shot before tapping again." : reason.startsWith("guard-blind") ? "Run `gamedexy doctor`: on Windows 10 or 11 the built-in reader needs an OCR language (Settings > Time & language > Language); on Linux install tesseract." : "Prices, buy words, ads and sign-in are never tapped. Pick another route." };
  }
  const before = last.phash;
  b.tap(run.device, o.x, o.y, o.hold ?? 0);
  row.sent = true;
  // Dead-tap hint: nothing visibly changed after a button tap.
  await new Promise((r) => setTimeout(r, o.settleMs ?? 900));
  const tmp = join(tmpdir(), `gdx_after_${process.pid}.png`);
  let changed = null;
  try {
    changed = hamming(before, phash(capture(run, tmp))) > 2;
    rmSync(tmp, { force: true });
  } catch {
    changed = null;
  }
  row.changed = changed;
  appendJsonl(join(o.dir, "taps.jsonl"), row);
  if (changed === false && !(o.hold > 0) && o.label) {
    appendJsonl(join(o.dir, "issues.jsonl"), { step: last.step, kind: "dead_tap", detail: `Tapping "${o.label}" changed nothing on screen`, source: "cli", candidate: true });
  }
  return { sent: true, screen_changed: changed, next: "gamedexy map shot --action \"...\"" };
}

export async function swipe(o) {
  const run = loadRun(o.dir);
  const b = bridge(run.platform);
  const last = await freshStep(o, run);
  if (last.alarm === "purchase-sheet") return { refused: "purchase sheet on screen" };
  // A swipe that starts on a button can press it: the start point gets the same check as a tap.
  const scale = run.platform === "ios" ? b.scale(last.width) : 1;
  const reason = leftGame(run) ?? checkTap(last.boxes, o.x1 * scale, o.y1 * scale, last.width) ?? (guardBlind(last) ? "guard-blind: no text reader on this machine" : null);
  if (reason) {
    appendJsonl(join(o.dir, "taps.jsonl"), { utc: utc(), after_step: last.step, swipe: [o.x1, o.y1, o.x2, o.y2], allowed: false, reason, sent: false });
    return { refused: reason, hint: "The swipe would start on a price, buy word, ad or sign-in. Start it somewhere else." };
  }
  b.swipe(run.device, o.x1, o.y1, o.x2, o.y2, o.seconds ?? 0.4);
  appendJsonl(join(o.dir, "taps.jsonl"), { utc: utc(), after_step: last.step, swipe: [o.x1, o.y1, o.x2, o.y2], allowed: true, sent: true });
  return { sent: true };
}

export function key(o, which) {
  const run = loadRun(o.dir);
  const b = bridge(run.platform);
  if (which === "back") {
    if (!b.back) return { refused: "iOS has no back key. Tap the game's own back button." };
    b.back(run.device);
  } else b.home(run.device);
  appendJsonl(join(o.dir, "taps.jsonl"), { utc: utc(), after_step: readJsonl(join(o.dir, "steps.jsonl")).at(-1)?.step ?? 0, key: which, allowed: true, sent: true });
  return { sent: true };
}

/** Launch the game, optionally in a Gamedexy debug state (`--state level=26,gems=100`). Everything after a state counts as prepared. */
export async function launch(o) {
  const run = loadRun(o.dir);
  const state = o.state ? parseState(o.state) : null;
  const b = bridge(run.platform);
  // Leaving the simulated days: any launch without a clock state is back on the real date.
  if (!(state ?? "").includes("clock=") && run.current_day) {
    run.current_day = null;
    saveRun(o.dir, run);
  }
  // Cold start time: from the launch command to the first steady, non-blank frame.
  const tmp = join(tmpdir(), `gdx_launch_${process.pid}.png`);
  // iOS offline variant: the simulator shares the Mac's network, so the game is told by debug state.
  const st = run.platform === "ios" && run.variant?.offline ? [state, "offline=1"].filter(Boolean).join(",") : state;
  const args = [...stateArgs(run.platform, st), ...langArgs(run.platform, run.variant?.lang)];
  const ms = await coldStart(() => (capture(run, tmp), textBoxes(run, tmp).boxes), () => b.launch(run.device, run.app_id, args));
  rmSync(tmp, { force: true });
  const variant = Object.keys(run.variant ?? {}).length ? { ...run.variant } : undefined;
  const firstInstall = Boolean(run.fresh) && !(run.launches ?? []).length;
  run.launches = [...(run.launches ?? []), { utc: utc(), ms, state, ...(o.capture ? { capture: true } : {}), ...(firstInstall ? { first_install: true } : {}), ...(variant ? { variant } : {}), after_step: readJsonl(join(o.dir, "steps.jsonl")).at(-1)?.step ?? 0 }];
  saveRun(o.dir, run);
  if (state) {
    if (run.seeded_from_step === null) run.seeded_from_step = readJsonl(join(o.dir, "steps.jsonl")).length + 1;
    run.states = [...(run.states ?? []), { state, after_step: readJsonl(join(o.dir, "steps.jsonl")).at(-1)?.step ?? 0, utc: utc() }];
    saveRun(o.dir, run);
  }
  return { launched: run.app_id, start_ms: ms, ...(state ? { state, seeded_from_step: run.seeded_from_step, note: "Debug states only work if the game reads -gdxState in debug builds. Take a shot to check it took effect." } : {}) };
}

/** Put back the game data that `start --fresh` backed up. */
export function restoreData(o) {
  return restore({ run: loadRun(o.dir), dir: o.dir });
}

// ---- seeding (jump ahead without touching the game's code) -----------------

export function seed(o) {
  const run = loadRun(o.dir);
  if (run.platform !== "ios") throw new Error("Seeding is built for the iOS Simulator so far. On Android, use the game's debug build with `adb shell run-as`.");
  const ios = bridge("ios");
  const value = readFileSync(o.valueFile, "utf8");
  ios.terminate(run.device, run.app_id);
  ios.writeDefault(run.device, run.app_id, o.key, value);
  let cleared = 0;
  if (o.clearWebkit) {
    // WebKit games keep their own copy in local storage, which wins over the native save.
    const root = join(ios.dataContainer(run.device, run.app_id), "Library", "WebKit");
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (!statSync(p).isDirectory()) continue;
        if (name === "LocalStorage") {
          rmSync(p, { recursive: true, force: true });
          cleared++;
        } else walk(p);
      }
    };
    walk(root);
  }
  const steps = readJsonl(join(o.dir, "steps.jsonl"));
  if (run.seeded_from_step === null) run.seeded_from_step = steps.length + 1;
  saveRun(o.dir, run);
  const back = ios.readDefault(run.device, run.app_id, o.key);
  return { written: back !== null && back.length > 0, webkit_storage_cleared: cleared, seeded_from_step: run.seeded_from_step, next: "gamedexy map launch, then shot" };
}

export function markSeeded(o) {
  const run = loadRun(o.dir);
  if (run.seeded_from_step === null) run.seeded_from_step = readJsonl(join(o.dir, "steps.jsonl")).length + 1;
  saveRun(o.dir, run);
  return { seeded_from_step: run.seeded_from_step };
}

// ---- payload, upload, stats ----------------------------------------------------

/** Build map_add_screens batches from the steps and the agent's labels file. */
/**
 * A capture-first run sends one shot per screen: the latest capture that opened, plus the first
 * plain-launch start screen. Retakes, keys that did not open and repeated start screens stay on
 * the developer's machine, so Gamedexy stores only the images the map shows.
 */
export function stepsToSend(dir, steps) {
  const caps = readJsonl(join(dir, "captures.jsonl"));
  if (!caps.length) return steps;
  const latest = new Map();
  for (const c of caps) if (c.ok && (!latest.has(c.key) || c.step > latest.get(c.key))) latest.set(c.key, c.step);
  const keep = new Set(latest.values());
  const capSteps = new Set(caps.map((c) => c.step));
  const firstStart = steps.find((s) => /^capture: start screen/.test(s.action ?? ""))?.step;
  return steps.filter((s) => (capSteps.has(s.step) ? keep.has(s.step) : /^capture: start screen/.test(s.action ?? "") ? s.step === firstStart : true));
}

/**
 * Steps to leave out of a send: `--skip a,b` plus the labels file's `exclude` list. Each entry is a
 * screen key (every step labelled with it) or a step number. A skipped step needs no label.
 */
export function skipSet(o, labels) {
  const raw = [...(Array.isArray(labels?.exclude) ? labels.exclude : []), ...(typeof o.skip === "string" ? o.skip.split(",") : Array.isArray(o.skip) ? o.skip : [])];
  return new Set(raw.map((x) => String(x).trim()).filter(Boolean));
}

function screensFor(o) {
  const labels = JSON.parse(readFileSync(o.labels, "utf8"));
  const skip = skipSet(o, labels);
  const all = stepsToSend(o.dir, readJsonl(join(o.dir, "steps.jsonl")));
  const isSkipped = (st) => skip.has(String(st.step)) || skip.has(String(labels.steps?.[String(st.step)]?.[0] ?? "\0"));
  const steps = all.filter((st) => !isSkipped(st));
  const dropped = all.filter(isSkipped).map((st) => st.step);
  const known = new Set([...all.map((st) => String(st.step)), ...Object.values(labels.steps ?? {}).map((v) => String(v?.[0]))]);
  const asked = typeof o.skip === "string" ? o.skip.split(",").map((x) => x.trim()).filter(Boolean) : [];
  const unknown = asked.filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`--skip names no step or screen key in this run: ${unknown.join(", ")}`);
  const missing = steps.filter((s) => !labels.steps?.[String(s.step)]).map((s) => s.step);
  if (missing.length) throw new Error(`Label every step first. Missing: ${missing.join(", ")}`);
  const screens = steps.map((s) => {
    const [key, note] = labels.steps[String(s.step)];
    const l = labels.screens[key];
    if (!l) throw new Error(`labels.screens has no entry for "${key}"`);
    return {
      step: s.step, screen_key: key, title: l.title, captured_at: s.utc, action: s.action, note: note ?? null,
      seeded: s.seeded, category: l.category, tags: l.tags ?? [], proposed_tags: l.proposed_tags ?? [], confidence: l.confidence,
      phash: s.phash, ocr_text: s.text.slice(0, 800), width: s.width, height: s.height, image_type: s.image_type,
    };
  });
  // The MCP schema wants strings, never null: drop empty fields instead of sending null.
  for (const sc of screens) for (const k of Object.keys(sc)) if (sc[k] === null || sc[k] === undefined) delete sc[k];
  Object.defineProperty(screens, "dropped", { value: dropped, enumerable: false });
  return screens;
}

export function payload(o) {
  const run = loadRun(o.dir);
  const screens = screensFor(o);
  const out = [];
  for (let i = 0; i < screens.length; i += 25) {
    const file = join(o.dir, `payload-${String(out.length + 1).padStart(2, "0")}.json`);
    writeFileSync(file, JSON.stringify({ run_id: run.run_id, screens: screens.slice(i, i + 25) }));
    out.push(file);
  }
  return { batches: out, screens: screens.length, ...(screens.dropped.length ? { skipped_steps: screens.dropped } : {}), next: "Send each batch to map_add_screens; save each reply to a file and run: gamedexy map upload --dir <folder> --reply <file>" };
}

/** PUT the images to the upload links in a saved map_add_screens reply. */
export async function upload(o) {
  const reply = JSON.parse(readFileSync(o.reply, "utf8"));
  // Accept either the tool's JSON text or the whole MCP result object.
  const body = reply?.content?.[0]?.text ? JSON.parse(reply.content[0].text) : reply;
  return putImages(o.dir, Array.isArray(body?.screens) ? body.screens : [], o.fetch);
}

/** PUT each accepted screen's images to the short-lived links map_add_screens handed out. */
async function putImages(dir, items, f = fetch) {
  const steps = new Map(readJsonl(join(dir, "steps.jsonl")).map((s) => [s.step, s]));
  const results = [];
  for (const it of items) {
    if (!it.accepted) {
      results.push({ step: it.step, skipped: it.errors });
      continue;
    }
    const s = steps.get(it.step);
    if (!s) {
      results.push({ step: it.step, error: "no such step in this folder" });
      continue;
    }
    const put = async (url, file) => {
      const res = await f(url, { method: "PUT", headers: { "content-type": it.content_type }, body: readFileSync(file) });
      return res.ok;
    };
    results.push({ step: it.step, full: await put(it.full_url, s.full), thumb: await put(it.thumb_url, s.thumb) });
  }
  return { uploaded: results.filter((r) => r.full && r.thumb).length, results };
}

// ---- signed-in CLI (gamedexy login): no payload or reply files ----------------------

/** Label every step, then send: screens to map_add_screens in batches, images to their links. */
export async function send(o) {
  const run = loadRun(o.dir);
  if (!run.run_id) throw new Error("This run has no Gamedexy run id. Start it with --game (signed in), or use map set-run.");
  const screens = screensFor(o);
  // Remembered so map finish can re-check carried issues against the screen keys sent here.
  if (o.labels) saveRun(o.dir, { ...run, labels_file: resolve(o.labels) });
  const call = o.callTool ?? callTool;
  let accepted = 0;
  let uploaded = 0;
  const skipped = [];
  const personal = [];
  for (let i = 0; i < screens.length; i += 25) {
    const reply = await call("map_add_screens", { run_id: run.run_id, screens: screens.slice(i, i + 25) });
    const items = Array.isArray(reply?.screens) ? reply.screens : [];
    accepted += items.filter((x) => x.accepted).length;
    for (const x of items) if (!x.accepted) skipped.push({ step: x.step, why: x.errors });
    for (const x of items) if (x.personal_data?.length) personal.push({ step: x.step, found: x.personal_data });
    const put = await putImages(o.dir, items, o.fetch);
    uploaded += put.uploaded;
  }
  return {
    run_dir: resolve(o.dir),
    screens: screens.length, accepted, uploaded, ...(screens.dropped.length ? { skipped_steps: screens.dropped } : {}), ...(skipped.length ? { skipped } : {}),
    ...(personal.length ? { personal_data: personal, tell_the_developer: "These screens may show personal data (emails, phone numbers, card numbers). Ask the developer to check them on the map and delete any that are real." } : {}),
    next: "gamedexy map finish --dir <folder> [--issues issues.json]" };
}

/** Finish the run: stats, goals and measurements from this folder, plus the issues the agent confirmed. */
export async function finish(o) {
  const run = loadRun(o.dir);
  if (!run.run_id) throw new Error("This run has no Gamedexy run id. Start it with --game (signed in), or use map set-run.");
  const { stats: s } = stats(o).for_map_finish_run;
  const read = (f) => (f ? JSON.parse(readFileSync(f, "utf8")) : undefined);
  const issues = read(o.issues);
  const unreached = read(o.unreached);
  // Issues the agent confirmed are kept with the run, so a replay of a later build can re-check them.
  if (Array.isArray(issues)) writeFileSync(join(o.dir, "issues.sent.json"), JSON.stringify(issues, null, 1));
  const re = recheckCarried(o.dir);
  const args = {
    run_id: run.run_id,
    status: o.failed ? "failed" : "finished",
    ...(o.failed ? { failure_reason: String(o.failed) } : {}),
    ...(Array.isArray(issues) || re.open.length ? { issues: [...(Array.isArray(issues) ? issues : []), ...re.open] } : {}),
    ...(re.rechecked.length ? { rechecked: re.rechecked } : {}),
    ...(Array.isArray(unreached) ? { unreached } : {}),
    ...(o.compare ? { compare_with: String(o.compare).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 5) } : {}),
    stats: s,
  };
  const reply = await (o.callTool ?? callTool)("map_finish_run", args);
  return { ...reply, run_dir: resolve(o.dir), ...(re.summary ? { rechecked_from_last_build: re.summary } : {}), next: reply.map_url ? `Open ${reply.map_url} and walk the developer through the Overview tab.` : undefined };
}

/**
 * Re-check the issues the agent reported on the earlier build, by text on the same screen key
 * (launch gate 2026-11, bug 1). Text still on that screen: still open (sent again as an issue).
 * Screen reached and the text gone: fixed. Screen not reached, or nothing to look for: not checked.
 * Never fixed by default.
 */
export function recheckCarried(dir, labelsFile) {
  const carriedPath = join(dir, "carried-issues.json");
  const none = { open: [], rechecked: [], summary: null };
  if (!existsSync(carriedPath)) return none;
  const carried = JSON.parse(readFileSync(carriedPath, "utf8"));
  const run = loadRun(dir);
  const lf = labelsFile ?? run.labels_file ?? join(dir, "labels.json");
  const labels = existsSync(lf) ? JSON.parse(readFileSync(lf, "utf8")) : { steps: {} };
  const steps = readJsonl(join(dir, "steps.jsonl"));
  const keyOf = (n) => (labels.steps?.[String(n)] ?? [])[0] ?? null;
  const norm = (t) => String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const open = [];
  const rechecked = [];
  for (const c of carried) {
    const on = steps.filter((s) => c.screen_key && keyOf(s.step) === c.screen_key);
    const needle = norm(c.look_for);
    if (!on.length || needle.length < 4) {
      rechecked.push({ screen_key: c.screen_key ?? undefined, kind: c.kind, detail: c.detail, result: "not_checked" });
      continue;
    }
    const hit = on.find((s) => norm(s.text).includes(needle));
    if (hit) open.push({ step: hit.step, screen_key: c.screen_key, kind: c.kind, detail: c.detail });
    else rechecked.push({ screen_key: c.screen_key, kind: c.kind, detail: c.detail, result: "fixed" });
  }
  const count = (r) => rechecked.filter((x) => x.result === r).length;
  return { open, rechecked, summary: { still_there: open.length, gone: count("fixed"), not_checked: count("not_checked") } };
}

/** The text an issue is about: the quoted part of its detail, else none (then it cannot be re-checked by text). */
export function lookFor(detail) {
  const q = String(detail ?? "").match(/["“']([^"”']{4,})["”']/);
  return q ? q[1] : null;
}

/** Numbers and issue hints for map_finish_run. */
export function stats(o) {
  const out = statsParts(o);
  // Ready to pass as-is: map_finish_run's stats carries the measurements, goals and agent notes.
  const { stats: base, issues, estimated_image_tokens, ...rest } = out;
  return {
    ...out,
    for_map_finish_run: {
      // Everything except the issue hints (checked by the agent and sent as issues) goes in stats.
      stats: { ...base, ...rest },
      issues_to_check: issues.length,
      note: "Check each issue hint against its screenshot; send only real ones as issues.",
    },
    estimated_image_tokens,
  };
}

/** What `gamedexy map stats` prints: the issue hints first, then the numbers; the measurements once, as counts. */
export function statsReport(o) {
  const { issues, stats: base, measure, estimated_image_tokens, ...rest } = statsParts(o);
  return {
    issue_hints: issues,
    issues_to_check: issues.length,
    note: "Check each issue hint against its screenshot; send only real ones as issues (issues.json, then map finish).",
    stats: base,
    measure: { launches: measure.launches.length, steps_measured: Object.keys(measure.steps).length, app_size_mb: measure.app_size_mb, sent_by: "map finish sends the full measurements" },
    ...rest,
    estimated_image_tokens,
  };
}

function statsParts(o) {
  const steps = readJsonl(join(o.dir, "steps.jsonl"));
  const taps = readJsonl(join(o.dir, "taps.jsonl"));
  const issues = readJsonl(join(o.dir, "issues.jsonl"));
  const looks = steps.filter((s) => s.new);
  const bytes = looks.reduce((n, s) => n + (existsSync(s.thumb) ? statSync(s.thumb).size : 0), 0);
  const run = loadRun(o.dir);
  return {
    stats: {
      screenshots_taken: steps.length,
      agent_looks: looks.length,
      image_bytes_to_agent: bytes,
      taps_checked: taps.filter((t) => t.x !== undefined).length,
      taps_refused: taps.filter((t) => t.allowed === false).length,
      purchase_sheets: steps.filter((s) => s.alarm === "purchase-sheet").length,
      minutes: Math.round((Date.now() - Date.parse(run.started_utc)) / 6000) / 10,
      ...(run.depth ? { depth: run.depth } : {}),
    },
    // Layout, timing and size facts for the map's Checks view (numbers only, no images).
    measure: measureOf(run, stepsToSend(o.dir, steps)),
    // Goals from the developer's hints file (or marked by the agent), and how each was reached.
    goals: goalsOf(o.dir, run, steps),
    // What the agent told Gamedexy while mapping (shown to the developer on the map; D-092).
    ...(process.env.GAMEDEXY_NO_FEEDBACK === "1" ? {} : { agent_feedback: readJsonl(join(o.dir, "feedback.jsonl")).slice(-40).map((f) => ({ ...f, text: scrub(f.text) })) }),
    // Days, notifications, earnings, store listing and the agent's design review (D-093).
    ...extrasOf(o.dir, run, taps),
    // About 470 tokens per 402px thumbnail for Claude-class models; text is extra.
    estimated_image_tokens: looks.length * 470,
    // A dead-tap hint only stands if the text on screen did not change either (a label that
    // flips from "300 starlight" to "Equip" barely moves the picture).
    issues: issues
      .filter((i) => {
        if (i.kind !== "dead_tap") return true;
        const before = steps.find((s) => s.step === i.step)?.text;
        const after = steps.find((s) => s.step === i.step + 1)?.text;
        return before === undefined || after === undefined || before === after;
      })
      .map(({ step, kind, detail }) => ({ step, kind, detail })),
  };
}

function measureOf(run, steps) {
  const perStep = {};
  for (const s of steps) {
    const extra = { ...(s.variant ? { variant: s.variant } : {}), ...(s.prompt ? { prompt: s.prompt } : {}), ...(s.day ? { day: s.day } : {}) };
    if (s.layout || Object.keys(extra).length) perStep[s.step] = { ...(s.layout ?? { w: 0, h: 0 }), ...extra };
  }
  return { v: 2, app_size_mb: run.app_size_mb ?? null, launches: run.launches ?? [], steps: perStep, base_device: run.base_device ?? run.device_name ?? null };
}


/**
 * Real-time play for action games: gestures in bursts for `seconds`, with one guard check
 * between bursts instead of a screenshot per gesture. Stops at once if a price, buy word, ad,
 * sign-in or purchase sheet appears anywhere on screen, or if the app stops. Saves one step.
 * Patterns: circle (drag around a centre: aim games), taps (tap around a centre), hold (hold and
 * release: one-touch games).
 */
export async function play(o) {
  const run = loadRun(o.dir);
  const b = bridge(run.platform);
  if (!b.driver()) throw new Error("No input tool found. Run `gamedexy doctor`.");
  const tmp = join(tmpdir(), `gdx_play_${process.pid}.png`);
  const look = () => {
    const img = capture(run, tmp);
    const { boxes, source, reader } = textBoxes(run, tmp);
    return { img, boxes, text: boxes.map((x) => x.text).join(" "), text_source: source, reader };
  };
  const guardStop = (screen) => {
    if (guardBlind(screen)) return "guard-blind: no text reader on this machine";
    if (screenAlarm(screen.text) === "purchase-sheet") return "purchase sheet on screen";
    for (const box of screen.boxes) {
      const r = blockedText(box.text);
      if (r) return `${r}: "${box.text}"`;
    }
    if (!b.running(run.device, run.app_id)) return "the app stopped";
    const away = leftGame(run);
    if (away) return away;
    return null;
  };
  const cx = o.cx ?? 200;
  const cy = o.cy ?? 440;
  const r = o.r ?? 100;
  const pattern = o.pattern ?? "circle";
  const t0 = Date.now();
  let gestures = 0;
  let stopped = null;
  let i = 0;
  while (Date.now() - t0 < (o.seconds ?? 20) * 1000) {
    stopped = guardStop(look());
    if (stopped) break;
    const burstEnd = Date.now() + (o.burstMs ?? 1800);
    while (Date.now() < burstEnd) {
      const a = i * 1.1;
      if (pattern === "circle") {
        const p = (t) => [Math.round(cx + r * Math.cos(t)), Math.round(cy + r * Math.sin(t))];
        const [x1, y1] = p(a);
        const [x2, y2] = p(a + 1.1);
        b.swipe(run.device, x1, y1, x2, y2, 0.25);
      } else if (pattern === "taps") {
        b.tap(run.device, Math.round(cx + r * Math.cos(a) * ((i % 3) / 2)), Math.round(cy + r * Math.sin(a) * ((i % 3) / 2)), 0);
      } else if (pattern === "hold") {
        b.tap(run.device, cx, cy, 0.3 + (i % 4) * 0.25);
      } else throw new Error("--pattern must be circle, taps or hold");
      gestures++;
      i++;
    }
  }
  rmSync(tmp, { force: true });
  appendJsonl(join(o.dir, "taps.jsonl"), { utc: utc(), after_step: readJsonl(join(o.dir, "steps.jsonl")).at(-1)?.step ?? 0, play: { pattern, cx, cy, r, gestures, seconds: Math.round((Date.now() - t0) / 1000) }, allowed: true, sent: gestures > 0, stopped });
  const step = await shot({ dir: o.dir, action: o.action ?? `play ${o.seconds ?? 20} s (${pattern}, ${gestures} gestures)` });
  return { gestures, seconds: Math.round((Date.now() - t0) / 1000), ...(stopped ? { stopped } : {}), step };
}


// ---- variants: big text, another language, a small phone (D-090) ----------------------

/**
 * Switch what later screenshots are taken under, then relaunch. Steps after a variant are not
 * the first session, so the first-session timeline stays honest.
 */
export async function variant(o) {
  const run = loadRun(o.dir);
  const b = bridge(run.platform);
  run.variant = { ...(run.variant ?? {}) };
  const done = [];
  if (o.reset) {
    if (run.text_size_before !== undefined) setTextSize(run.platform, run.device, run.text_size_before);
    if (run.variant.lang && run.platform === "android") setAndroidAppLang(run.device, run.app_id, null);
    if (run.variant.offline && run.platform === "android") for (const svc of ["wifi", "data"]) spawnSync("adb", ["-s", run.device, "shell", "svc", svc, "enable"]);
    if (run.base_udid && run.base_udid !== run.device) {
      run.device = run.base_udid;
      run.device_name = run.base_device;
    }
    run.variant = {};
    done.push("back to the normal text size, language and device");
  }
  if (o.textSize) {
    const v = textSizeOf(run.platform, o.textSize);
    if (run.text_size_before === undefined) run.text_size_before = getTextSize(run.platform, run.device);
    setTextSize(run.platform, run.device, v);
    if (isDefaultSize(run.platform, v)) delete run.variant.text;
    else run.variant.text = v;
    done.push(`text size ${v}`);
  }
  if (o.lang) {
    if (o.lang === "default") delete run.variant.lang;
    else run.variant.lang = langOf(o.lang);
    if (run.platform === "android") setAndroidAppLang(run.device, run.app_id, run.variant.lang ?? null);
    done.push(o.lang === "default" ? "default language" : `language ${LANGS[run.variant.lang].label}`);
  }
  if (o.offline !== undefined) {
    const on = o.offline === true || o.offline === "on";
    if (run.platform === "android") {
      for (const svc of ["wifi", "data"]) spawnSync("adb", ["-s", run.device, "shell", "svc", svc, on ? "disable" : "enable"]);
    }
    if (on) run.variant.offline = true;
    else delete run.variant.offline;
    done.push(on ? (run.platform === "ios" ? "offline (iOS: the game must read offline=1, the simulator shares the Mac's network)" : "offline (wifi and data off)") : "back online");
  }
  if (o.device) {
    if (!run.base_udid) {
      run.base_udid = run.device;
      run.base_device = run.device_name;
    }
    const dev = b.device(o.device);
    if (run.platform === "ios") prepareIosDevice(dev.udid, o.app);
    run.device = dev.udid;
    run.device_name = String(dev.name ?? "").replace(/^Gamedexy Map - /, "");
    if (dev.udid === run.base_udid) delete run.variant.device;
    else run.variant.device = run.device_name;
    if (run.text_size_before !== undefined && run.variant.text) setTextSize(run.platform, run.device, run.variant.text);
    done.push(`device ${run.device_name}`);
  }
  if (!done.length) throw new Error("Pass --text-size, --lang, --offline, --device or --reset");
  const steps = readJsonl(join(o.dir, "steps.jsonl"));
  if (Object.keys(run.variant).length && run.seeded_from_step === null) run.seeded_from_step = steps.length + 1;
  run.variant_log = [...(run.variant_log ?? []), { after_step: steps.at(-1)?.step ?? 0, variant: { ...run.variant }, utc: utc() }];
  saveRun(o.dir, run);
  const launched = o.noLaunch ? null : await launch({ dir: o.dir });
  return {
    variant: run.variant,
    did: done,
    ...(launched ? { start_ms: launched.start_ms } : {}),
    next: "Visit the same screens as before and label each shot with the SAME screen key as the normal version, so Gamedexy can compare them. Finish with: gamedexy map variant --dir <folder> --reset",
  };
}

// ---- hints, goals and feedback (D-091, D-092) ---------------------------------------------

/** The developer's hints for this game, read at start from --src. The full text stays local. */
export function hints(o) {
  const run = loadRun(o.dir);
  if (o.src) {
    const h = findHints(o.src);
    run.hints = h ? { file: h.file, ...parseHints(h.text) } : null;
    saveRun(o.dir, run);
    if (h) return { file: h.file, text: h.text, goals: run.hints.goals };
  }
  if (!run.hints) return { hints: null, tip: "No hints file. Read the code for win and lose conditions, then: gamedexy hints init --src <repo> (ask the developer first)" };
  return { file: run.hints.file, goals: run.hints.goals, debug_states: run.hints.states, tips: run.hints.tips, off_limits: run.hints.off_limits };
}

/** Mark that the last screenshot (or --step) reached a goal such as win or lose. */
export function goal(o) {
  const run = loadRun(o.dir);
  const steps = readJsonl(join(o.dir, "steps.jsonl"));
  const step = o.step ?? steps.at(-1)?.step;
  if (!steps.some((s) => s.step === step)) throw new Error("Take a screenshot of the goal screen first, or pass --step N");
  const key = String(o.key ?? "").toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(key)) throw new Error("--key is a short name such as win, lose or reward");
  appendJsonl(join(o.dir, "goals.jsonl"), { key, step, utc: utc(), ...(o.label ? { label: String(o.label).slice(0, 120) } : {}) });
  const g = goalsOf(o.dir, run, steps).find((x) => x.key === key);
  return { goal: key, step, via: g?.via };
}

function viaOf(run, step) {
  const before = (run.launches ?? []).filter((l) => l.after_step < step.step).at(-1);
  if (before?.capture) return "captured";
  if (before?.state) return "debug state";
  if (step.seeded) return step.variant ? "play" : "prepared save";
  return "play";
}

function goalsOf(dir, run, steps) {
  const marks = readJsonl(join(dir, "goals.jsonl"));
  const fromHints = run.hints?.goals ?? [];
  const keys = [...new Set([...fromHints.map((g) => g.key), ...marks.map((m) => m.key)])];
  return keys.map((key) => {
    const mark = marks.find((m) => m.key === key);
    const step = mark ? steps.find((s) => s.step === mark.step) : null;
    const label = (fromHints.find((g) => g.key === key)?.text ?? mark?.label ?? "").slice(0, 120);
    return { key, ...(label ? { label } : {}), from_hints: fromHints.some((g) => g.key === key), step: step?.step ?? null, via: step ? viaOf(run, step) : null };
  });
}

/** Leave a note for Gamedexy: where the agent got stuck, what the tool was missing. */
export function feedback(o) {
  loadRun(o.dir);
  const row = feedbackRow({ kind: o.kind, text: o.text, step: o.step });
  appendJsonl(join(o.dir, "feedback.jsonl"), row);
  return { saved: row, note: "Sent with map_finish_run and shown to the developer on their map. Nothing from the code goes with it." };
}

/** Called by the CLI when a command fails inside a run folder, so tool problems reach Gamedexy too. */
export function recordCliError(dir, command, message) {
  try {
    if (!existsSync(join(dir, "run.json"))) return;
    appendJsonl(join(dir, "feedback.jsonl"), feedbackRow({ kind: "cli-error", text: message, command, auto: true }));
  } catch {
    // never let error reporting fail the command
  }
}


// ---- days, notifications, economy, store listing, design review (D-093) --------------------------

export function extrasOf(dir, run, taps) {
  const play = taps.filter((t) => t.play).reduce((n, t) => n + (t.play.seconds ?? 0), 0);
  const economy = readJsonl(join(dir, "economy.jsonl"));
  const snaps = run.notification_snapshots ?? [];
  return {
    ...(play ? { play_seconds: play } : {}),
    ...(run.day_log?.length ? { days: run.day_log } : {}),
    ...(snaps.length || run.notifications_code?.length ? { notifications: { snapshots: snaps.slice(-12), code: run.notifications_code ?? [] } } : {}),
    ...(economy.length ? { economy: economy.slice(-200) } : {}),
    ...(run.store ? { store_listing: run.store } : {}),
    ...(run.critique?.length ? { critique: run.critique } : {}),
    ...(run.review_prompts?.length ? { review_prompts: run.review_prompts } : {}),
    ...(run.levels ? { levels: levelsReached(dir, run) } : {}),
    ...(run.nav?.length ? { nav: run.nav } : {}),
    ...(readJsonl(join(dir, "captures.jsonl")).length ? { captures: readJsonl(join(dir, "captures.jsonl")).slice(-300).map(({ key, step, ok, reason, level }) => ({ key, step, ok, ...(reason ? { reason } : {}), ...(level ? { level } : {}) })) } : {}),
    // A replayed route (gamedexy map replay) rather than a fresh agent run: shown as "Replay" on the map.
    ...(existsSync(join(dir, "replay.json")) ? { replay: true } : {}),
  };
}

/** Simulated day N: relaunch with the game's clock N-1 days ahead (Gamedexy debug state clock=Nd). */
export async function day(o) {
  const run = loadRun(o.dir);
  const n = Number(o.day);
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error("--day is 1 to 30 (1 is install day)");
  run.current_day = n;
  run.day_log = [...(run.day_log ?? []), { day: n, after_step: readJsonl(join(o.dir, "steps.jsonl")).at(-1)?.step ?? 0, utc: utc() }];
  saveRun(o.dir, run);
  const out = await launch({ dir: o.dir, state: clockState(n, o.state) });
  return { day: n, ...out, note: "Days only move if the game reads clock=Nd (Gamedexy debug state) wherever it asks for today's date." };
}

/**
 * Day 1 to day N in one go: for each day, relaunch with the clock moved on, screenshot, and
 * optionally tap the first button matching --collect (through the guard). Snapshots the game's
 * scheduled notifications after each day when the game writes the Gamedexy dump.
 */
export async function days(o) {
  const list = parseDays(o.days);
  let collect = null;
  if (o.collect) {
    if (String(o.collect).length > 120) throw new Error("--collect is a short pattern such as \"Claim|Collect|Nice\"");
    collect = new RegExp(String(o.collect), "i");
  }
  const out = [];
  for (const n of list) {
    await day({ dir: o.dir, day: n, state: o.state });
    await new Promise((r) => setTimeout(r, o.settleMs ?? 1500));
    const first = await shot({ dir: o.dir, action: `day ${n}: open` });
    const row = { day: n, step: first.step, screen: first.screen, text: first.text.slice(0, 140) };
    if (collect) {
      const hit = find({ dir: o.dir, text: "" }).find((b) => collect.test(b.text));
      if (hit) {
        const t = await tap({ dir: o.dir, x: hit.x, y: hit.y, label: hit.text });
        if (t.refused) row.refused = t.refused;
        else {
          const after = await shot({ dir: o.dir, action: `day ${n}: tap ${hit.text}` });
          row.collected = hit.text;
          row.after_step = after.step;
        }
      }
    }
    try {
      const snap = notifications({ dir: o.dir, quiet: true });
      if (snap.pending !== undefined) row.notifications_pending = snap.pending;
    } catch {
      // no dump from this game: fine
    }
    out.push(row);
  }
  return { days: out, next: "Look at each day's screenshots, label them, and open anything new (offers, events, streak rewards) before the next step." };
}

/** Snapshot the game's scheduled notifications (debug dump), and/or store the list read from code. */
export function notifications(o) {
  const run = loadRun(o.dir);
  const res = {};
  if (o.code) {
    const list = JSON.parse(readFileSync(o.code, "utf8"));
    run.notifications_code = (Array.isArray(list) ? list : []).slice(0, 60).map((n) => cleanNotification(n, "code")).filter(Boolean);
    res.from_code = run.notifications_code.length;
  }
  if (run.platform === "ios") {
    let dump = null;
    try {
      dump = readDump(join(bridge("ios").dataContainer(run.device, run.app_id), "Library", "Caches", "gamedexy-notifications.json"));
    } catch {
      dump = null;
    }
    if (dump) {
      const snap = { after_step: readJsonl(join(o.dir, "steps.jsonl")).at(-1)?.step ?? 0, day: run.current_day ?? 1, at: dump.at, pending: dump.pending };
      run.notification_snapshots = [...(run.notification_snapshots ?? []), snap];
      res.pending = dump.pending.length;
      // Seen 2026-11-09: iOS 27 simulators drop every local request ("local client does not exist").
      if (!dump.pending.length && /iOS 27/.test(run.os ?? "")) res.tip = "iOS 27 simulators currently drop local notification requests. If the game scheduled some, map this on an iOS 26 simulator.";
    } else if (!o.quiet && !o.code) res.tip = "No dump found. Add the Gamedexy notification dump to the debug build (see the skill), or pass --code with the list you read from the code.";
  }
  saveRun(o.dir, run);
  return res;
}

export function earn(o) {
  loadRun(o.dir);
  const step = readJsonl(join(o.dir, "steps.jsonl")).at(-1)?.step;
  const row = earnRow({ currency: o.currency, amount: o.amount, per: o.per, note: o.note, step });
  appendJsonl(join(o.dir, "economy.jsonl"), row);
  return { saved: row };
}

/** The store listing: fastlane metadata in the repo, or the live App Store page by id. */
export async function store(o) {
  const run = loadRun(o.dir);
  // The developer's own fastlane files come first (the repo given now, or the one the run started
  // with); Apple's public lookup is only the fallback for a game that is already live.
  const src = o.src ?? run.src ?? null;
  let listing = src ? fastlaneListing(src, o.locale ?? "en-US") : null;
  const tmpFiles = [];
  if (!listing && o.appStoreId) {
    if (!/^\d{6,12}$/.test(String(o.appStoreId))) throw new Error("--app-store-id is the number in the App Store link (id123456789)");
    const country = /^[a-z]{2}$/i.test(String(o.country ?? "")) ? o.country : "us";
    const r = await fetch(`https://itunes.apple.com/lookup?id=${o.appStoreId}&country=${country}`);
    const j = await r.json();
    const a = j.results?.[0];
    if (!a) throw new Error("No App Store app with that id in that country");
    const shots = [];
    for (const [i, url] of (a.screenshotUrls ?? []).slice(0, 10).entries()) {
      const f = join(tmpdir(), `gdx_store_${process.pid}_${i}.jpg`);
      writeFileSync(f, Buffer.from(await (await fetch(url)).arrayBuffer()));
      tmpFiles.push(f);
      shots.push(f);
    }
    listing = { source: "app_store", name: a.trackName ?? "", subtitle: "", description: a.description ?? "", keywords: "", promo: "", shots, price: a.formattedPrice ?? null };
  }
  if (!listing) throw new Error("No listing found. Pass --src <repo> with fastlane/metadata, or --app-store-id <id> for a live game.");
  const steps = readJsonl(join(o.dir, "steps.jsonl"));
  const shots = listing.shots.map((file, i) => {
    let text = "";
    try {
      text = readText(file).map((b) => b.text).join(" ");
    } catch {
      text = "";
    }
    let best = { step: null, score: 0 };
    for (const s of steps) {
      const sc = overlap(text, s.text);
      if (sc > best.score) best = { step: s.step, score: sc };
    }
    return { n: i + 1, text: text.slice(0, 300), match_step: best.score >= 0.35 ? best.step : null, score: best.score };
  });
  for (const f of tmpFiles) rmSync(f, { force: true });
  run.store = { source: listing.source, name: listing.name.slice(0, 80), subtitle: listing.subtitle.slice(0, 80), description: listing.description.slice(0, 4000), promo: listing.promo.slice(0, 300), keywords: listing.keywords.slice(0, 120), ...(listing.price ? { price: listing.price } : {}), shots };
  saveRun(o.dir, run);
  return { source: listing.source, screenshots: shots.length, matched: shots.filter((x) => x.match_step).length, unmatched: shots.filter((x) => !x.match_step).map((x) => x.n) };
}

/** The agent's own design review, checked and kept for map_finish_run (no cost to Gamedexy). */
export function critique(o) {
  const run = loadRun(o.dir);
  run.critique = cleanCritique(JSON.parse(readFileSync(o.file, "utf8")));
  saveRun(o.dir, run);
  return { saved: run.critique.length };
}


// ---- capture mode (Slice 26 Part G, PR 2, D-102) ----------------------------------------------

const titleOf = (key) => {
  const s = String(key).replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Screen";
};

/**
 * The code's navigation in capture keys (flows from code, PR 3): which captured screen opens which,
 * and how, from scan.json. A code screen with tabs maps to its first tab; a container the checklist
 * leaves out (a root view that switches phases) maps to the start screen. Tabs of one screen link to
 * each other, and the start screen links to each level.
 */
export function navFrom(sc) {
  const cl = Array.isArray(sc.checklist) ? sc.checklist : [];
  const home = cl.find((c) => c.category === "home")?.key ?? null;
  const rep = (k) => cl.find((c) => c.key === k && !c.level)?.key ?? cl.find((c) => !c.level && c.key.startsWith(`${k}_`))?.key ?? null;
  const inList = new Set(cl.map((c) => c.key));
  const out = new Map();
  const add = (from, to, kind, trigger) => {
    if (!from || !to || from === to) return;
    const id = `${from}>${to}`;
    if (!out.has(id)) out.set(id, { from, to, kind, trigger: trigger ? String(trigger).slice(0, 120) : null });
  };
  for (const e of sc.edges ?? []) {
    if (e.kind === "embed" || e.kind === "root" || e.from === "launch") continue;
    const from = rep(e.from) ?? (!inList.has(e.from) ? home : null);
    add(from, rep(e.to), e.kind, e.trigger);
  }
  for (const s of sc.screens ?? []) {
    const tabs = cl.filter((c) => !c.level && c.key.startsWith(`${s.key}_`) && s.tabs);
    for (let i = 1; i < tabs.length; i++) add(tabs[0].key, tabs[i].key, "tab", null);
  }
  for (const c of cl.filter((x) => x.level)) add(home, c.key, "level", c.open);
  return [...out.values()].slice(0, 400);
}

/** Wait until two screenshots in a row match (animations done), up to `ms`. Returns nothing; shot() takes the real one. */
async function settle(run, ms) {
  const tmp = join(tmpdir(), `gdx_settle_${process.pid}.png`);
  const until = Date.now() + ms;
  let last = null;
  let same = 0;
  await new Promise((r) => setTimeout(r, Math.min(800, ms)));
  while (Date.now() < until) {
    let h;
    try {
      h = phash(capture(run, tmp));
    } catch {
      break;
    }
    same = last && hamming(last, h) <= 2 ? same + 1 : 0;
    if (same >= 1) break;
    last = h;
    await new Promise((r) => setTimeout(r, 350));
  }
  rmSync(tmp, { force: true });
}

/**
 * Two shots of the same screen? Animation (dice, particles, a pulsing button) moves the hash a little and
 * the OCR text a little, so: very close hashes match outright, a close hash with loosely equal text also matches.
 */
export function looksSame(a, b) {
  const d = hamming(a.phash, b.phash);
  // No text on either side (no OCR reader, or a text-free screen): nothing to compare, so only the strict hash rule.
  if (!normText(a.text) || !normText(b.text)) return d <= NEAR_SAME_STRICT;
  // Text must agree at every distance: two screens with one layout (result vs result_snuffed) sit a few bits apart.
  // Text that differs only in its digits (Day 1 +25 vs Day 3 +40) is a different state, not the same screen,
  // unless the picture is all but identical (2 bits or fewer): then a digit is OCR noise on a moving sprite.
  return d <= 12 && sameText(a.text, b.text) && (d <= NEAR_SAME_STRICT || sameNumbers(a.text, b.text));
}

const NEAR_SAME_STRICT = 2;
const digitsOf = (t) => String(t ?? "").replace(/[^0-9]/g, "");
/** Numbers must agree too: OCR typos in letters are tolerated, a changed score or day count is a different state. */
function sameNumbers(a, b) {
  return digitsOf(a) === digitsOf(b);
}

/**
 * Open every screen on the scan's checklist through the game's debug-only capture list
 * (`-gdxState screen=<key>`), wait for it to settle, screenshot it and label it from its key.
 * Never taps. A screen that comes up looking like the start screen (animation tolerated) was not reached:
 * it is reported, not labelled as that screen. A key whose opener was written with guessed arguments is
 * skipped unless `includeGuessed`, and then never counted as a real capture. Labels go to labels.json in the run folder (merged with any there).
 */
export async function captureAll(o) {
  const run = loadRun(o.dir);
  mkdirSync(join(o.dir, "shots"), { recursive: true }); // shots/ is made here when it is missing
  // Tests pass fakes for the device side; everything else is the real code.
  const io = { launch, shot, settle, ...(o.io ?? {}) };
  if (!o.scan || !existsSync(o.scan)) throw new Error("--scan is the scan.json from gamedexy scan (its checklist says what to open)");
  const sc = JSON.parse(readFileSync(o.scan, "utf8"));
  let list = Array.isArray(sc.checklist) ? sc.checklist : [];
  if (o.only) {
    const want = new Set(String(o.only).split(",").map((s) => s.trim()).filter(Boolean));
    list = list.filter((c) => want.has(c.key));
    if (!list.length) throw new Error(`None of --only ${o.only} is on the checklist in ${o.scan}`);
  } else if (!o.all) throw new Error("Pass --all (every screen on the checklist) or --only key1,key2");
  if (o.with && !/^[A-Za-z][\w-]{0,31}=[\w.:-]{1,64}(,[A-Za-z][\w-]{0,31}=[\w.:-]{1,64})*$/.test(String(o.with))) throw new Error('--with is extra debug values such as "motes=2000,runs=3"');
  const settleMs = Number(o.settleMs ?? 4000);
  const labelsPath = join(o.dir, "labels.json");
  const labels = existsSync(labelsPath) ? JSON.parse(readFileSync(labelsPath, "utf8")) : { screens: {}, steps: {} };
  labels.screens ??= {};
  labels.steps ??= {};
  const capsPath = join(o.dir, "captures.jsonl");
  // Flows from code: kept on the run (local) and sent with map finish.
  run.nav = navFrom(sc);
  saveRun(o.dir, run);
  const levelNames = Object.fromEntries((run.levels?.items ?? sc.levels?.[0]?.items ?? []).map((i) => [i.key, i.name]));

  // The start screen first, from a plain launch: what "did not open" looks like.
  await io.launch({ dir: o.dir });
  await io.settle(run, settleMs);
  const base = await io.shot({ dir: o.dir, action: "capture: start screen (plain launch)" });
  const baseStep = readJsonl(join(o.dir, "steps.jsonl")).at(-1);
  const rootKey = (sc.edges ?? []).find((e) => e.from === "launch" && e.kind === "root")?.to ?? "start";
  // The same start-screen key on every pass: the one already in labels.json, else the checklist's home screen.
  const labelledStart = Object.values(labels.steps).find((v) => v[1] === "plain launch")?.[0];
  const startKey = labelledStart ?? (sc.checklist ?? []).find((c) => c.category === "home")?.key ?? `${rootKey}_start`;
  labels.screens[startKey] ??= { title: "Start screen", category: "home", tags: [], proposed_tags: [], confidence: 0.6 };
  labels.steps[String(base.step)] = [startKey, "plain launch"];

  const results = [];
  const seenByHash = [];
  // Every frame known to be the start screen: the plain launch, then each key that came up as it. An animated
  // start screen drifts from frame to frame, so each one seen widens what counts as "the same".
  const startFrames = [{ phash: baseStep.phash, text: baseStep.text }];
  const skippedGuessed = [];
  let homeMatched = false;
  for (const c of list) {
    if (c.code?.guessed_args && !o.includeGuessed) {
      skippedGuessed.push({ key: c.key, call: `${c.code.call ?? c.code.set}(${(c.code.args ?? []).join(", ")})`, why: "the capture list opens this with guessed arguments; fix its OPENERS line, then run with --include-guessed" });
      continue;
    }
    const state = [c.open, o.with].filter(Boolean).join(",");
    await io.launch({ dir: o.dir, state, capture: true });
    await io.settle(run, settleMs);
    const s = await io.shot({ dir: o.dir, action: `capture: ${c.key}` });
    const step = readJsonl(join(o.dir, "steps.jsonl")).at(-1);
    const row = { utc: utc(), key: c.key, open: state, step: s.step, category: c.category ?? null, ...(c.level ? { level: c.level } : {}) };
    const sameAsStart = startFrames.some((f) => looksSame(f, step));
    const dup = seenByHash.find((x) => looksSame(x, step));
    if (s.alarm === "purchase-sheet") {
      Object.assign(row, { ok: false, reason: "a purchase sheet opened: never captured (rule 1); relaunched" });
      await io.launch({ dir: o.dir });
    } else if (!s.app_running) Object.assign(row, { ok: false, reason: "the game was not running after the launch (crash?)" });
    else if (sameAsStart && !(c.category === "home" && !homeMatched)) Object.assign(row, { ok: false, not_reached: true, reason: "not reached: the launch returned but the screen still looks the same as the start screen (animation ignored); the capture list does not open this key yet" });
    else if (dup && !c.level) Object.assign(row, { ok: false, not_reached: true, reason: `not reached: looks the same as ${dup.key}; check the capture list opens the right screen` });
    else row.ok = true;
    if (c.code?.guessed_args && row.ok) row.guessed = true;
    if (sameAsStart && c.category === "home") homeMatched = true;
    if (sameAsStart && !row.ok) startFrames.push({ phash: step.phash, text: step.text });
    if (row.ok) {
      seenByHash.push({ key: c.key, phash: step.phash, text: step.text });
      const name = c.level ? levelNames[c.level] : null;
      labels.screens[c.key] ??= { title: name ? `${titleOf(run.levels?.param ?? "level")}: ${name}` : titleOf(c.key), category: c.category ?? null, tags: [], proposed_tags: [], confidence: row.guessed ? 0.3 : c.sure ? 0.9 : 0.6 };
      labels.steps[String(s.step)] = [c.key, row.guessed ? `captured with guessed arguments (unsure): ${state}` : `captured: ${state}`];
    } else labels.steps[String(s.step)] = [dup && !sameAsStart ? dup.key : startKey, `capture of ${c.key} did not open it`];
    appendJsonl(capsPath, row);
    results.push(row);
  }
  writeFileSync(labelsPath, JSON.stringify(labels, null, 1));
  const ok = results.filter((r) => r.ok && !r.guessed);
  const guessed = results.filter((r) => r.ok && r.guessed).map((r) => r.key);
  const failed = results.filter((r) => !r.ok).map(({ key, reason, step }) => ({ key, step, reason }));
  const notReached = results.filter((r) => r.not_reached).map((r) => r.key);
  const noCategory = Object.entries(labels.screens).filter(([, l]) => !l.category).map(([k]) => k);
  return {
    run_dir: resolve(o.dir),
    captured: ok.length,
    of: results.length,
    failed,
    ...(notReached.length ? { not_reached: notReached } : {}),
    ...(guessed.length ? { unsure_guessed_args: guessed, unsure_why: "These opened with guessed arguments, so they are not counted as captured; check each screenshot." } : {}),
    ...(skippedGuessed.length ? { skipped_guessed: skippedGuessed } : {}),
    ...(run.levels ? { levels: (({ count, reached_count }) => ({ count, reached: reached_count }))(levelsReached(o.dir, run)) } : {}),
    labels: labelsPath,
    ...(noCategory.length ? { needs_category: noCategory, tip: "Pick a category for these from run-rules.json in labels.json before map send." } : {}),
    next: failed.length
      ? "Wire the failed keys in the game's capture list (or leave them), rebuild, and run map capture --only those keys. Then check labels.json and run map send --labels labels.json."
      : "Check labels.json (titles, categories, tags from run-rules.json), then map send --dir <folder> --labels labels.json.",
  };
}
