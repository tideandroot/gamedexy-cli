#!/usr/bin/env node
// gamedexy: command-line companion to the Gamedexy MCP. Works from any coding
// agent that can run shell commands (Claude Code, Codex, Cursor, Antigravity,
// VS Code). Every command prints one JSON object.
import { readFileSync } from "node:fs";
import { login, logout, whoami } from "../src/auth.mjs";
import { captureInit } from "../src/capture.mjs";
import { codexDiff, codexRender, codexScan, codexSend } from "../src/codex.mjs";
import { doctor } from "../src/doctor.mjs";
import { createDevice, deleteDevice } from "../src/fresh.mjs";
import { checkExport } from "../src/export-check.mjs";
import { initHints } from "../src/hints.mjs";
import { init } from "../src/init.mjs";
import * as map from "../src/map.mjs";
import { replay, saveRoute } from "../src/replay.mjs";
import { defaultRunDir } from "../src/rundir.mjs";
import { scan } from "../src/scan.mjs";

const HELP = `gamedexy: map your own game with your AI coding agent (Gamedexy Game Map)

Start by reading the code (plain code, no AI, nothing uploaded):

  gamedexy scan --src REPO [--out DIR] [--engine auto|swift|kotlin|godot|unity] [--include-dead]
                (screens, which screen opens which, products, ads, notifications -> scan.json,
                 and a draft inventory.json for map start)

Capture every screen without playing (debug builds only, on its own branch, with the developer's yes):

  gamedexy capture init --src REPO [--scan scan.json] [--seed N] [--include-dead] [--dry-run]
                        (writes the debug-only capture list; Godot: everything goes in a gamedexy/ folder that never
                         ships (gamedexy/capture.gd + a tiny stub autoload gamedexy_stub.gd), adds gamedexy/* to every export
                         preset's exclude filter plus a "<name> (Gamedexy capture)" copy of each iOS/Android preset to export capture builds from
                         (re-running refreshes the copy and keeps your gamedexy/capture.gd; --force rewrites it),
                         and a .gdignore in screenshot folders; --dry-run shows every diff. --seed N seeds the global RNG,
                         --include-dead lists classes nothing creates; see ENGINES.md)
  gamedexy check-export BUILD   (BUILD = .pck, .apk, .ipa, .zip or an exported folder: exit 1 if any gamedexy/ path or capture
                         script is inside, or the build cannot be read; paths only, not script contents; for a ship script. Also: doctor --export BUILD)
  gamedexy map capture  --dir DIR --scan scan.json --all | --only shop,pause [--with "motes=2000"] [--include-guessed]
                        (opens each screen with -gdxState screen=KEY, screenshots it, writes labels.json;
                         keys opened with guessed arguments are skipped unless --include-guessed, and a key that
                         comes up as the start screen is reported as not reached)

A quick run uses these commands:

  gamedexy login                                    (once: sign in to Gamedexy in your browser)
  gamedexy doctor --platform ios|android [--device ID] [--app-id BUNDLE] [--app PATH]
                  [--src REPO] [--engine-dir DIR]   (Godot: checks a debug engine is installed; --engine-dir = your custom engine builds)
  gamedexy map start [--out DIR] --platform ios|android --device ID --app-id BUNDLE [--app PATH]
                     --game "My Game" [--engine Godot] [--genre Puzzle] [--depth quick|deep]
                     [--inventory inventory.json] [--src REPO] [--fresh] [--create-new]
                     (the run folder defaults to ~/.gamedexy/runs/<game>/<time>, never a temp dir; the path is printed as
                      run_dir and again by map capture, send and finish. --game reuses a game you already have, matched by
                      slug, id or name, and stops with the candidates when several fit; --create-new makes a new one)
  gamedexy map shot  --dir DIR --action "tap Play"   (screenshot, text, guard checks)
  gamedexy map find  --dir DIR --text Play           (where on-screen text is)
  gamedexy map tap   --dir DIR --x X --y Y [--label Play]   (prices, buy words, ads, sign-in refused)
  gamedexy map back  --dir DIR                       (Android back key; iOS has none)
  gamedexy map send  --dir DIR --labels labels.json [--skip KEY,STEP]  (screens and images to Gamedexy;
                     --skip or "exclude": [...] in labels.json drops steps that are not screens, no label needed)
  gamedexy map finish --dir DIR [--issues issues.json] [--compare "Royal Match,Block Blast"]

After a new build, replay the last run with no AI cost:
  gamedexy map route  --dir OLD_DIR                  (save the path the agent took)
  gamedexy map replay --dir NEW_DIR --route OLD_DIR/route.json [--from OLD_DIR --labels OLD_DIR/labels.json]

Game Codex: every dice, enemy, boss, upgrade, perk and item, read from the code (plain code, no AI):
  gamedexy codex scan   --src REPO [--out DIR] [--game "My Game"]   (-> codex.json; the last one kept as codex.prev.json)
  gamedexy codex render --src REPO --codex codex.json [--godot BIN]  (runs the game's debug render hook for pictures;
                        opens a small window for a few seconds; --no-run only attaches images already rendered)
  gamedexy codex diff   --old codex.prev.json --new codex.json        (what was added, removed or changed)
  gamedexy codex send   --codex codex.json --game "My Game" [--platform ios] [--create-new]
                        (signed in: a new Codex version on the map. Looks your games up first and reuses one matched by
                         slug, id or name; with several possible matches it stops and lists them. A picture that fails to
                         upload does not stop the rest: they are listed at the end and the exit code is 1)

Deep runs (days, notifications, variants, debug states, store page, critique): gamedexy help deep
Also: gamedexy init [--agent all|claude|codex|antigravity|cursor] [--dry-run] [--transport stdio|url]
      (installs the skill and connects the Gamedexy MCP in Claude Code, Codex and Antigravity/Gemini when they are
       installed: Antigravity gets an entry in ~/.gemini/config/mcp_config.json, other servers kept, never a token;
       --dry-run shows the diff), whoami, logout, version.

Coordinates are in points on iOS and pixels on Android. Simulators and emulators only.`;

const HELP_DEEP = `gamedexy: deep-run commands (read DEEP.md next to the skill first)

  gamedexy device create --platform ios --like ID | --type "iPhone SE (3rd generation)"
  gamedexy device delete --device ID                (only simulators this tool created)
  gamedexy map restore-data --dir DIR              (put back the data --fresh backed up)
  gamedexy map swipe   --dir DIR --x1 --y1 --x2 --y2 [--seconds S]
  gamedexy map play    --dir DIR --seconds 20 [--pattern circle|taps|hold] [--cx X --cy Y --r R]
  gamedexy map home    --dir DIR
  gamedexy map launch  --dir DIR [--state "level=26,gems=100"]   (debug builds read gdxState)
  gamedexy map seed    --dir DIR --key KEY --value-file FILE [--clear-webkit]
  gamedexy map mark-seeded --dir DIR
  gamedexy map variant --dir DIR [--text-size largest|big|default] [--lang de|ja|fr|es|pt|it|ko|zh|default]
                       [--offline on|off] [--device ID [--app PATH]] [--reset] [--no-launch]
  gamedexy map hints   --dir DIR [--src REPO]        (the developer's gamedexy.map.md)
  gamedexy hints init  --src REPO                    (write a gamedexy.map.md template; ask first)
  gamedexy map goal    --dir DIR --key win|lose|reward|... [--step N]
  gamedexy map day     --dir DIR --day N [--state ...]
  gamedexy map days    --dir DIR --days 1-7 [--collect "Claim|Collect"]
  gamedexy map notifications --dir DIR [--code notifications.json]
  gamedexy map earn    --dir DIR --currency coins --amount 40 [--per run|level|day|ad]
  gamedexy map store   --dir DIR --src REPO | --app-store-id ID [--country us]
  gamedexy map critique --dir DIR --file critique.json
  gamedexy map feedback --dir DIR --kind stuck|unreachable|missing-tool|tool-bug|confusing|slow|idea|praise --text "..."
  gamedexy map stats   --dir DIR

Without gamedexy login (MCP-only agents): map set-run --run-id ID, map payload --labels FILE,
map upload --reply FILE.`;

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[k] = true;
    else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

const seedArg = (v) => {
  if (v === true || v === "") throw new Error("--seed needs a whole number, for example --seed 7");
  const n = num(v, "seed");
  if (!Number.isInteger(n) || n < 0) throw new Error("--seed must be a whole number, 0 or more");
  return n;
};

async function main() {
  const a = parse(process.argv.slice(2));
  const [cmd, sub] = a._;
  if (cmd === "version" || a.version === true) return { version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version };
  if (cmd === "help" && sub === "deep") return HELP_DEEP;
  if (!cmd || cmd === "help" || a.help) return HELP;
  if (cmd === "login") return await login({ endpoint: a.endpoint, noOpen: Boolean(a.noOpen) });
  if (cmd === "logout") return logout();
  if (cmd === "whoami") return whoami();
  if (cmd === "init") return init({ agent: typeof a.agent === "string" ? a.agent : undefined, dryRun: Boolean(a.dryRun), transport: typeof a.transport === "string" ? a.transport : undefined });
  if (cmd === "doctor") return doctor({ platform: a.platform, device: a.device, appId: a.appId, app: a.app, releaseApp: a.releaseApp, export: typeof a.export === "string" ? a.export : undefined, src: typeof a.src === "string" ? a.src : undefined, engine: a.engine, engineDir: typeof a.engineDir === "string" ? a.engineDir : undefined });
  if (cmd === "device") {
    if (a._[1] === "create") {
      if (a.platform !== "ios") throw new Error("device create is for the iOS Simulator. On Android, create an emulator in Android Studio.");
      if (!a.like && !a.type) throw new Error('--like <simulator id> or --type "iPhone SE (3rd generation)" is required');
      return createDevice({ like: a.like, type: a.type });
    }
    if (a._[1] === "delete") return deleteDevice({ device: a.device });
    throw new Error("Use: gamedexy device create|delete");
  }
  if (cmd === "scan") {
    if (!a.src || a.src === true) throw new Error("Use: gamedexy scan --src <the game's repo folder> [--out DIR]");
    return scan({ src: a.src, out: typeof a.out === "string" ? a.out : undefined, engine: a.engine, includeDead: Boolean(a.includeDead) });
  }
  if (cmd === "check-export") return checkExport(a._[1] ?? a.path);
  if (cmd === "capture") {
    if (a._[1] !== "init" || !a.src || a.src === true) throw new Error("Use: gamedexy capture init --src <repo> [--scan scan.json] [--seed N] [--dry-run]");
    return captureInit({ src: a.src, scan: typeof a.scan === "string" ? a.scan : undefined, engine: a.engine, dryRun: Boolean(a.dryRun), force: Boolean(a.force), includeDead: Boolean(a.includeDead), seed: a.seed === undefined ? undefined : seedArg(a.seed) });
  }
  if (cmd === "codex") {
    if (sub === "scan") {
      if (!a.src || a.src === true) throw new Error("Use: gamedexy codex scan --src <the game's repo folder> [--out DIR]");
      return codexScan({ src: a.src, out: typeof a.out === "string" ? a.out : undefined, game: typeof a.game === "string" ? a.game : undefined });
    }
    if (sub === "render") return codexRender({ src: typeof a.src === "string" ? a.src : undefined, codex: a.codex, godot: typeof a.godot === "string" ? a.godot : undefined, images: typeof a.images === "string" ? a.images : undefined, noRun: Boolean(a.noRun), timeout: a.timeout });
    if (sub === "diff") return codexDiff({ old: a.old, new: a.new });
    if (sub === "send") return await codexSend({ codex: a.codex, game: typeof a.game === "string" ? a.game : undefined, platform: typeof a.platform === "string" ? a.platform : undefined, createNew: Boolean(a.createNew) });
    throw new Error("Use: gamedexy codex scan|render|diff|send. Run: gamedexy help");
  }
  if (cmd === "hints") {
    if (a._[1] !== "init" || !a.src) throw new Error("Use: gamedexy hints init --src <repo>");
    return initHints(a.src);
  }
  if (cmd !== "map") throw new Error(`Unknown command "${cmd}". Run: gamedexy help`);
  // A new run needs no folder: it goes to ~/.gamedexy/runs/<game>/<time>, never a temp dir (--out picks another).
  if (sub === "start" && !a.dir) a.dir = typeof a.out === "string" ? a.out : defaultRunDir(typeof a.game === "string" ? a.game : a.appId);
  if (!a.dir || a.dir === true) throw new Error("--dir is required (the run's folder: the one map start printed)");
  switch (sub) {
    case "start":
      return await map.startSignedIn({ createNew: Boolean(a.createNew), dir: a.dir, platform: a.platform, device: a.device, appId: a.appId, app: a.app, src: a.src, version: a.version, build: a.build, fresh: Boolean(a.fresh), noBackup: Boolean(a.noBackup), game: a.game, engine: a.engine, genre: a.genre, depth: a.depth, inventory: a.inventory, agent: a.agent });
    case "send":
      return await map.send({ dir: a.dir, labels: a.labels, skip: typeof a.skip === "string" ? a.skip : undefined });
    case "finish":
      return await map.finish({ dir: a.dir, issues: a.issues, unreached: a.unreached, compare: a.compare, failed: a.failed });
    case "restore-data":
      return map.restoreData({ dir: a.dir });
    case "set-run":
      return map.setRun({ dir: a.dir, runId: a.runId });
    case "shot":
      return map.shot({ dir: a.dir, action: String(a.action ?? "screenshot"), note: a.note });
    case "find":
      return map.find({ dir: a.dir, text: String(a.text ?? "") });
    case "tap":
      return map.tap({ dir: a.dir, x: num(a.x, "x"), y: num(a.y, "y"), hold: a.hold ? num(a.hold, "hold") : 0, label: a.label });
    case "swipe":
      return map.swipe({ dir: a.dir, x1: num(a.x1, "x1"), y1: num(a.y1, "y1"), x2: num(a.x2, "x2"), y2: num(a.y2, "y2"), seconds: a.seconds ? num(a.seconds, "seconds") : 0.4 });
    case "play":
      return await map.play({ dir: a.dir, seconds: a.seconds ? num(a.seconds, "seconds") : 20, pattern: a.pattern, cx: a.cx ? num(a.cx, "cx") : undefined, cy: a.cy ? num(a.cy, "cy") : undefined, r: a.r ? num(a.r, "r") : undefined, action: a.action });
    case "back":
    case "home":
      return map.key({ dir: a.dir }, sub);
    case "launch":
      return await map.launch({ dir: a.dir, state: a.state });
    case "seed":
      return map.seed({ dir: a.dir, key: a.key, valueFile: a.valueFile, clearWebkit: Boolean(a.clearWebkit) });
    case "mark-seeded":
      return map.markSeeded({ dir: a.dir });
    case "variant":
      return await map.variant({ dir: a.dir, textSize: a.textSize, lang: a.lang, offline: a.offline, device: a.device, app: a.app, reset: Boolean(a.reset), noLaunch: Boolean(a.noLaunch) });
    case "day":
      return await map.day({ dir: a.dir, day: a.day, state: a.state });
    case "days":
      return await map.days({ dir: a.dir, days: a.days, collect: a.collect, state: a.state });
    case "notifications":
      return map.notifications({ dir: a.dir, code: a.code });
    case "earn":
      return map.earn({ dir: a.dir, currency: a.currency, amount: a.amount, per: a.per, note: a.note });
    case "store":
      return await map.store({ dir: a.dir, src: a.src, appStoreId: a.appStoreId, country: a.country, locale: a.locale });
    case "critique":
      return map.critique({ dir: a.dir, file: a.file });
    case "hints":
      return map.hints({ dir: a.dir, src: a.src });
    case "goal":
      return map.goal({ dir: a.dir, key: a.key, step: a.step ? num(a.step, "step") : undefined, label: a.label });
    case "feedback":
      return map.feedback({ dir: a.dir, kind: a.kind, text: a.text, step: a.step ? num(a.step, "step") : undefined });
    case "payload":
      return map.payload({ dir: a.dir, labels: a.labels, skip: typeof a.skip === "string" ? a.skip : undefined });
    case "upload":
      return map.upload({ dir: a.dir, reply: a.reply });
    case "stats":
      return map.statsReport({ dir: a.dir });
    case "route":
      return saveRoute({ dir: a.dir, out: a.out });
    case "capture":
      return await map.captureAll({ dir: a.dir, scan: a.scan, all: Boolean(a.all), only: typeof a.only === "string" ? a.only : undefined, with: typeof a.with === "string" ? a.with : undefined, includeGuessed: Boolean(a.includeGuessed), settleMs: a.settleMs === undefined ? undefined : num(a.settleMs, "settle-ms") });
    case "replay":
      if (!a.route) throw new Error("--route is required (made by gamedexy map route on an earlier run)");
      return await replay({ dir: a.dir, route: a.route, from: a.from, labels: a.labels });
    default:
      throw new Error(`Unknown map command "${sub}". Run: gamedexy help`);
  }
}

main().then(
  (out) => {
    process.stdout.write((typeof out === "string" ? out : JSON.stringify(out, null, 1)) + "\n");
    if (out && typeof out === "object" && "refused" in out) process.exitCode = 3;
    else if (out && typeof out === "object" && out.ok === false) process.exitCode = 1; // e.g. codex send with failed pictures, check-export
  },
  (err) => {
    // A failure inside a run folder is also a note for Gamedexy (scrubbed, shown to the developer).
    const a = parse(process.argv.slice(2));
    if (a._[0] === "map" && typeof a.dir === "string" && a._[1] !== "feedback") map.recordCliError(a.dir, a._[1], err.message);
    process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
    process.exitCode = 1;
  },
);
