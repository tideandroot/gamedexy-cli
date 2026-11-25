import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseUiDump } from "../src/devices.mjs";
import { blockedText, checkTap, foregroundAlarm, screenAlarm } from "../src/guard.mjs";
import { hamming, matchScreen, phash, sameText } from "../src/phash.mjs";
import { decodePng, encodePng, resize } from "../src/png.mjs";
import { payload, reviewPrompts, stats } from "../src/map.mjs";

function img(w, h, f) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

test("PNG encode and decode round-trip, and resize keeps the aspect ratio", () => {
  const a = img(40, 80, (x, y) => [x * 6, y * 3, 100]);
  const back = decodePng(encodePng(a));
  assert.equal(back.width, 40);
  assert.equal(back.height, 80);
  assert.deepEqual([...back.data.subarray(0, 8)], [...a.data.subarray(0, 8)]);
  const small = resize(a, 20);
  assert.equal(small.height, 40);
});

test("pHash: same picture same hash, different picture far away", () => {
  const a = img(120, 240, (x, y) => (x < 60 ? [250, 250, 250] : [10, 10, 10]));
  const b = img(120, 240, (x, y) => (y < 120 ? [250, 250, 250] : [10, 10, 10]));
  assert.match(phash(a), /^[0-9a-f]{16}$/);
  assert.equal(phash(a), phash(decodePng(encodePng(a))));
  assert.ok(hamming(phash(a), phash(b)) > 12);
});

test("dedupe tolerates OCR noise but keeps different screens apart", () => {
  assert.ok(sameText("HOLD TO GO Hold = gravity on", "HOlD TO GO Hold = gravity on"));
  assert.ok(!sameText("SHOP Skins Trails", "ACHIEVEMENTS 0 of 22 done"));
  const h = "0123456789abcdef";
  const steps = [{ new: true, phash: h, text: "HOME", screen: "s01" }];
  assert.equal(matchScreen(h, "x", steps), "s01");
  assert.equal(matchScreen("fedcba9876543210", "SHOP", steps), null);
});

test("guard refuses prices, buy words, ads and sign-in, and allows ordinary buttons", () => {
  for (const [t, r] of [["$4.99", "price"], ["4,99 €", "price"], ["BUY", "purchase-word"], ["Subscribe", "purchase-word"], ["CONTINUE • WATCH AD", "rewarded-ad"], ["Sign in with Apple", "sign-in"]]) {
    assert.equal(blockedText(t), r, t);
  }
  assert.equal(blockedText("PLAY"), null);
  for (const t of ["LOADING...", "Loading", "UNAVAILABLE", "GET"]) assert.equal(blockedText(t), "price-placeholder", t);
  assert.equal(blockedText("Loading level 3"), null);
  const boxes = [{ text: "$0.99", x0: 100, y0: 1300, x1: 400, y1: 1360 }, { text: "PLAY", x0: 300, y0: 900, x1: 900, y1: 1000 }];
  assert.match(checkTap(boxes, 250, 1330, 1206), /price/);
  assert.equal(checkTap(boxes, 600, 950, 1206), null);
});

test("purchase sheets stop the run, on both stores", () => {
  assert.equal(screenAlarm("Confirm your In-App Purchase [Environment: Sandbox]"), "purchase-sheet");
  assert.equal(screenAlarm("Google Play 1-tap buy"), "purchase-sheet");
  assert.equal(screenAlarm("PLAY LEVELS SHOP"), null);
  assert.equal(foregroundAlarm("com.android.vending", "BillingActivity", "com.x"), "billing");
  assert.equal(foregroundAlarm("com.x", "MainActivity", "com.x"), null);
});

test("Android UI dump gives text with pixel bounds", () => {
  const xml = '<node text="Shop" bounds="[10,20][110,80]"/><node text="" content-desc="Buy &amp; save" bounds="[0,0][5,5]"/>';
  assert.deepEqual(parseUiDump(xml), [
    { text: "Shop", x0: 10, y0: 20, x1: 110, y1: 80 },
    { text: "Buy & save", x0: 0, y0: 0, x1: 5, y1: 5 },
  ]);
});

test("payload merges steps with the agent's labels in batches of 25, and stats count looks", () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r1", started_utc: new Date().toISOString(), platform: "ios" }));
  const lines = [];
  for (let i = 1; i <= 30; i++) {
    lines.push(JSON.stringify({ step: i, utc: "2026-11-08T00:00:00Z", action: "tap", screen: "s01", new: i === 1, seeded: i > 20, phash: "0123456789abcdef", width: 1206, height: 2622, text: "HOME", image_type: "image/jpeg", thumb: join(dir, "none.jpg") }));
  }
  writeFileSync(join(dir, "steps.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "taps.jsonl"), JSON.stringify({ x: 1, y: 2, allowed: false }) + "\n");
  const labels = { screens: { home: { title: "Home", category: "home", tags: [], confidence: 0.9 } }, steps: Object.fromEntries(lines.map((_, i) => [String(i + 1), ["home", null]])) };
  writeFileSync(join(dir, "labels.json"), JSON.stringify(labels));
  const out = payload({ dir, labels: join(dir, "labels.json") });
  assert.equal(out.batches.length, 2);
  const first = JSON.parse(readFileSync(out.batches[0], "utf8"));
  assert.equal(first.run_id, "r1");
  assert.equal(first.screens.length, 25);
  assert.equal(first.screens[0].category, "home");
  assert.equal(JSON.parse(readFileSync(out.batches[1], "utf8")).screens[4].seeded, true);
  const s = stats({ dir });
  assert.equal(s.stats.screenshots_taken, 30);
  assert.equal(s.stats.agent_looks, 1);
  assert.equal(s.stats.taps_refused, 1);
});

test("payload refuses unlabeled steps", () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r1", started_utc: new Date().toISOString() }));
  writeFileSync(join(dir, "steps.jsonl"), JSON.stringify({ step: 1, text: "" }) + "\n");
  writeFileSync(join(dir, "labels.json"), JSON.stringify({ screens: {}, steps: {} }));
  assert.throws(() => payload({ dir, labels: join(dir, "labels.json") }), /Missing: 1/);
});

// ---- fresh installs and debug states -------------------------------------------

import { DEDICATED_PREFIX, isDedicated, parseState, releaseHasHook, stateArgs } from "../src/fresh.mjs";
import { mkdirSync } from "node:fs";

test("debug states: plain pairs only, passed the way each platform reads them", () => {
  assert.equal(parseState(" level=26, gems=100 ,screen=pause"), "level=26,gems=100,screen=pause");
  assert.deepEqual(stateArgs("ios", "level=26"), ["-gdxState", "level=26"]);
  assert.deepEqual(stateArgs("android", "level=26"), ["--es", "gdxState", "level=26"]);
  assert.deepEqual(stateArgs("ios", undefined), []);
  for (const bad of ["", "level", "level=26;rm -rf /", "a=b c", "x=$(id)", "=5", "k=" + "9".repeat(65)]) assert.throws(() => parseState(bad), /state/i);
});

test("a full wipe is only ever offered for simulators this tool created", () => {
  assert.equal(isDedicated(`${DEDICATED_PREFIX} - iPhone 17 Pro`), true);
  for (const name of ["iPhone 17 Pro", "My Gamedexy Map", "", undefined]) assert.equal(isDedicated(name), false);
});

test("doctor's release check finds the hook in an app's executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-rel-"));
  const app = join(dir, "Game.app");
  mkdirSync(app);
  writeFileSync(join(app, "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Game</string></dict></plist>');
  const macho = (s) => Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(80), Buffer.from(s)]);
  writeFileSync(join(app, "Game"), macho("release build"));
  writeFileSync(join(app, "notes.txt"), "mentions gdxState in a text file, which does not count".padEnd(100));
  assert.equal(releaseHasHook(app), false);
  // Xcode debug builds keep the code in a side dylib, not the main executable.
  writeFileSync(join(app, "Game.debug.dylib"), macho("-gdxState"));
  assert.equal(releaseHasHook(app), true);
});

test("the guard refuses rewarded-ad wording found on Gloamwick", () => {
  for (const s of ["Watch for double XP +5", "Watch to get a free chest", "WATCH FOR 2X COINS", "D Watch an ad for 5 starlight"]) assert.equal(blockedText(s), "rewarded-ad", s);
  for (const s of ["Double XP  +5", "Watch the intro", "PLAY"]) assert.equal(blockedText(s), null, s);
});

// ---- variants, permission prompts, hints, goals, agent feedback (D-090 to D-092) ----------

import { feedbackRow, parseHints, scrub, HINTS_TEMPLATE } from "../src/hints.mjs";
import { systemPrompt } from "../src/prompts.mjs";
import { langArgs, textSizeOf } from "../src/variant.mjs";
import { goal } from "../src/map.mjs";

test("the guard refuses buy, ad and sign-in words and local prices in other languages", () => {
  for (const [t, r] of [["Jetzt kaufen", "purchase-word"], ["購入する", "purchase-word"], ["Abonnieren", "purchase-word"], ["Acheter", "purchase-word"], ["120円", "price"], ["￥120", "price"], ["¥1,200", "price"], ["Werbung ansehen", "rewarded-ad"], ["広告を見る", "rewarded-ad"], ["Anmelden", "sign-in"], ["ログイン", "sign-in"]]) {
    assert.equal(blockedText(t), r, t);
  }
  for (const t of ["SPIELEN", "はじめる", "Einstellungen", "Paysage", "Nicht erlauben"]) assert.equal(blockedText(t), null, t);
  assert.equal(screenAlarm("App内課金 を確認 [Environment: Sandbox]"), "purchase-sheet");
});

test("system permission prompts are recognised in English, German and Japanese", () => {
  assert.equal(systemPrompt("“Gloamwick” Would Like to Send You Notifications Don’t Allow Allow"), "notifications");
  assert.equal(systemPrompt("„Gloamwick“ möchte dir Mitteilungen senden"), "notifications");
  assert.equal(systemPrompt("“Gloamwick”は通知を送信します。よろしいですか?"), "notifications");
  assert.equal(systemPrompt("Allow “Gloamwick” to track your activity across other companies' apps and websites? Ask App Not to Track"), "tracking");
  assert.equal(systemPrompt("Allow “Gloamwick” to use your location? Allow While Using the App"), "location");
  assert.equal(systemPrompt("NIGHT 1 Keep the flame alive"), null);
});

test("variant options: text sizes and launch arguments for a language", () => {
  assert.equal(textSizeOf("ios", "largest"), "accessibility-extra-extra-extra-large");
  assert.equal(textSizeOf("ios", "default"), "large");
  assert.equal(textSizeOf("android", "largest"), "2.0");
  assert.throws(() => textSizeOf("ios", "huge"), /text-size/);
  assert.deepEqual(langArgs("ios", "de"), ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE"]);
  assert.deepEqual(langArgs("ios", "ja"), ["-AppleLanguages", "(ja)", "-AppleLocale", "ja_JP"]);
  assert.deepEqual(langArgs("android", "de"), []);
});

test("hints file: goals, debug states, tips and off-limits are read; the template parses", () => {
  const h = parseHints(`# hints\n## Goals\n- win: Survive until dawn on night 1\n- \`lose\`: let the flame go out\n- Not a goal line\n## Debug states\n- outcome=win — win screen\n- night=3,outcome=lose\n## Tips\nHold to fly.\n## Off limits\n- Never open the dev menu\n`);
  assert.deepEqual(h.goals, [{ key: "win", text: "Survive until dawn on night 1" }, { key: "lose", text: "let the flame go out" }]);
  assert.deepEqual(h.states, ["outcome=win", "night=3,outcome=lose"]);
  assert.equal(h.tips, "Hold to fly.");
  assert.deepEqual(h.off_limits, ["Never open the dev menu"]);
  assert.deepEqual(parseHints(HINTS_TEMPLATE).goals.map((g) => g.key), ["win", "lose", "reward"]);
});

test("agent feedback is scrubbed of paths, emails, secrets and URL queries", () => {
  const t = scrub("Stuck at /Users/jt/Desktop/Game/x.swift, mail jt@example.com, key sk_live_abcdefghijklmnop1234 see https://x.dev/a?token=1");
  assert.ok(!t.includes("jt@example.com") && !t.includes("/Users/jt") && !t.includes("sk_live") && !t.includes("token=1"), t);
  assert.match(t, /~\/Desktop\/Game\/x\.swift/);
  assert.equal(scrub("axe tap --udid 8D3A3F05-06FF-4E51-8D84-29D49191ACC4 timed out"), "axe tap --udid [device] timed out");
  assert.throws(() => feedbackRow({ kind: "rant", text: "x" }), /kind/);
  assert.equal(feedbackRow({ kind: "stuck", text: "Could not get past night 1", step: 4 }).step, 4);
});

test("goals record how they were reached: play, debug state or prepared save; stats carry them and the feedback", () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-goal-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r1", started_utc: new Date().toISOString(), platform: "ios", hints: { file: "gamedexy.map.md", goals: [{ key: "win", text: "Survive until dawn" }, { key: "lose", text: "Let it go out" }, { key: "reward", text: "After a win" }], states: [], off_limits: [] }, launches: [{ ms: 900, state: null, after_step: 0 }, { ms: 900, state: "outcome=win", after_step: 2 }] }));
  const rows = [1, 2, 3].map((i) => JSON.stringify({ step: i, screen: `s0${i}`, new: true, seeded: i === 3, text: "", thumb: join(dir, "x.jpg"), variant: i === 2 ? { lang: "de" } : null, layout: { w: 402, h: 874, text: [] } }));
  writeFileSync(join(dir, "steps.jsonl"), rows.join("\n") + "\n");
  assert.equal(goal({ dir, key: "lose", step: 1 }).via, "play");
  assert.equal(goal({ dir, key: "win" }).via, "debug state");
  writeFileSync(join(dir, "feedback.jsonl"), JSON.stringify(feedbackRow({ kind: "missing-tool", text: "No way to hold two fingers" })) + "\n");
  const s = stats({ dir });
  assert.deepEqual(s.goals.map((g) => [g.key, g.step, g.via]), [["win", 3, "debug state"], ["lose", 1, "play"], ["reward", null, null]]);
  assert.equal(s.agent_feedback[0].kind, "missing-tool");
  assert.deepEqual(s.measure.steps["2"].variant, { lang: "de" });
  process.env.GAMEDEXY_NO_FEEDBACK = "1";
  assert.equal(stats({ dir }).agent_feedback, undefined);
  delete process.env.GAMEDEXY_NO_FEEDBACK;
});

import { steady } from "../src/measure.mjs";
test("cold start counts a screen as steady when its words repeat, even with animation noise", () => {
  const a = new Set("flicker 25 gloamwick turn to face the dark dusk meadow moths and gentle play daily season shop trophies scores".split(" "));
  const b = new Set([...a, "q"]);
  assert.equal(steady(a, b), true);
  assert.equal(steady(new Set(["loading"]), new Set(["loading"])), false);
  assert.equal(steady(a, new Set(["settings", "sound", "master", "music"])), false);
});

// ---- days, notifications, economy, store, critique (D-093) -----------------------------------

import { cleanCritique, cleanNotification, clockState, earnRow, fastlaneListing, overlap, parseDays } from "../src/extras.mjs";

test("days: ranges and lists, and the clock state each day launches with", () => {
  assert.deepEqual(parseDays("1-3,7"), [1, 2, 3, 7]);
  assert.deepEqual(parseDays("7,1"), [1, 7]);
  for (const bad of ["0", "3-1", "31", "x", ""]) assert.throws(() => parseDays(bad), /days/);
  assert.equal(clockState(1), "clock=0d");
  assert.equal(clockState(7, "screen=daily"), "clock=6d,screen=daily");
});

test("notifications from the device dump and from code are cleaned to one shape", () => {
  const d = cleanNotification({ identifier: "streak", title: "Your flame is fading", body: "Come back", trigger: { type: "calendar", hour: 19, minute: 0, repeats: true, next: "2026-11-10T00:00:00Z", junk: 1 } }, "device");
  assert.deepEqual(d, { id: "streak", title: "Your flame is fading", body: "Come back", source: "device", trigger: { type: "calendar", hour: 19, minute: 0, repeats: true, next: "2026-11-10T00:00:00Z" } });
  const c = cleanNotification({ id: "lapsed", title: "We miss you", trigger: { type: "interval", seconds: 259200 }, when: "scheduled at /Users/jt/x on app close", condition: "cancelled when the player opens the game" }, "code");
  assert.equal(c.when, "scheduled at ~/x on app close");
  assert.equal(cleanNotification({}, "code"), null);
});

test("economy rows, store text overlap and the design review are validated", () => {
  assert.deepEqual(earnRow({ currency: "Motes", amount: "25", per: "run", step: 7 }), { currency: "motes", amount: 25, per: "run", step: 7 });
  assert.throws(() => earnRow({ currency: "motes", amount: "lots" }), /amount/);
  assert.ok(overlap("Gloamwick Turn to face the dark PLAY Shop", "FLICKER 25 Gloamwick Turn to face the dark. PLAY Daily Shop") > 0.8);
  assert.equal(overlap("Collect rare moths", "Settings Sound Music"), 0);
  const cr = cleanCritique([{ area: "hierarchy", severity: "high", finding: "PLAY competes with the daily card", suggestion: "Make the card smaller", step: 1, library: ["Candy Crush Saga home"] }, { area: "weird", finding: "Labels are grey", suggestion: "Darken them" }]);
  assert.equal(cr[1].area, "other");
  assert.throws(() => cleanCritique([{ finding: "x", suggestion: "y" }]), /needs a finding/);
  assert.equal(fastlaneListing(tmpdir()), null);
});

test("map stats puts days, notifications, earnings, store, review and play time into map_finish_run's stats", () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-x-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r", started_utc: new Date().toISOString(), platform: "ios", day_log: [{ day: 2, after_step: 1 }], notification_snapshots: [{ after_step: 1, day: 2, at: "2026-11-09T22:00:00Z", pending: [{ id: "streak", title: "t", body: "", source: "device", trigger: { type: "calendar", hour: 19 } }] }], notifications_code: [], store: { source: "fastlane", name: "G", subtitle: "", description: "No ads", shots: [] }, critique: [{ area: "other", severity: "low", finding: "abcde", suggestion: "fghij" }] }));
  writeFileSync(join(dir, "steps.jsonl"), JSON.stringify({ step: 1, screen: "s01", new: true, text: "", thumb: join(dir, "x"), day: 2 }) + "\n");
  writeFileSync(join(dir, "taps.jsonl"), JSON.stringify({ play: { seconds: 40 }, allowed: true, sent: true }) + "\n");
  writeFileSync(join(dir, "economy.jsonl"), JSON.stringify({ currency: "motes", amount: 30, per: "run" }) + "\n");
  const s = stats({ dir }).for_map_finish_run.stats;
  assert.deepEqual(Object.keys(s).filter((k) => ["days", "notifications", "economy", "store_listing", "critique", "play_seconds", "measure", "goals"].includes(k)).sort(), ["critique", "days", "economy", "goals", "measure", "notifications", "play_seconds", "store_listing"]);
  assert.equal(s.measure.steps["1"].day, 2);
  assert.equal(s.issues, undefined);
});

test("review prompts from inventory.json and a replayed route go with map finish (0.3.0)", () => {
  assert.deepEqual(reviewPrompts({ review_prompts: [{ file: "UI/ResultView.swift", trigger: "after the first dawn" }, { nope: 1 }, "x"] }), [{ file: "UI/ResultView.swift", trigger: "after the first dawn" }]);
  assert.deepEqual(reviewPrompts({}), []);
  const dir = mkdtempSync(join(tmpdir(), "gdx-rp-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r", started_utc: new Date().toISOString(), platform: "ios", review_prompts: [{ file: "a.swift", trigger: "after a win" }] }));
  writeFileSync(join(dir, "steps.jsonl"), JSON.stringify({ step: 1, screen: "s01", new: true, text: "", thumb: join(dir, "x") }) + "\n");
  let s = stats({ dir }).for_map_finish_run.stats;
  assert.deepEqual(s.review_prompts, [{ file: "a.swift", trigger: "after a win" }]);
  assert.equal(s.replay, undefined);
  writeFileSync(join(dir, "replay.json"), "{}");
  s = stats({ dir }).for_map_finish_run.stats;
  assert.equal(s.replay, true);
});

test("init installs the skill without overwriting a file it did not write", async () => {
  const { mkdtempSync, writeFileSync: write, readFileSync: read, mkdirSync: mk } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const { init } = await import("../src/init.mjs");
  const home = mkdtempSync(j(tmpdir(), "gdx-init-"));
  const first = init({ agent: "cursor", home });
  assert.equal(first.skill[0].done, true);
  assert.ok(read(j(home, ".gamedexy", "AGENTS.md"), "utf8").includes("installed by gamedexy init"));
  assert.equal(init({ agent: "cursor", home }).skill[0].done, false);
  mk(j(home, ".claude", "skills", "gamedexy-game-map"), { recursive: true });
  write(j(home, ".claude", "skills", "gamedexy-game-map", "SKILL.md"), "mine");
  const r = init({ agent: "claude", home, dryRun: true });
  assert.equal(r.skill[0].done, false);
  assert.equal(read(j(home, ".claude", "skills", "gamedexy-game-map", "SKILL.md"), "utf8"), "mine");
});

// ---- gamedexy init: Antigravity (Gemini) ----------------------------------------------------------------

async function agyHome(config) {
  const { mkdtempSync, mkdirSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const home = mkdtempSync(j(tmpdir(), "gdx-agy-"));
  if (config !== undefined) {
    mkdirSync(j(home, ".gemini", "config"), { recursive: true });
    write(j(home, ".gemini", "config", "mcp_config.json"), config);
  }
  return { home, file: j(home, ".gemini", "config", "mcp_config.json") };
}
const MCP_ENTRY = { command: "npx", args: ["-y", "mcp-remote@0.16.7", "https://www.gamedexy.com/api/mcp"] };

test("init (Antigravity): adds the gamedexy entry, keeps every other server and key, and never writes a token", async () => {
  const { init } = await import("../src/init.mjs");
  const { readFileSync: read, existsSync: ex } = await import("node:fs");
  const existing = { mcpServers: { other: { command: "node", args: ["a.js"], env: { KEY: "secret-stays" }, disabled: false }, remote: { serverUrl: "https://x.example/mcp", headers: { Authorization: "Bearer keep-me" } } }, someSetting: { a: 1 } };
  const { home, file } = await agyHome(JSON.stringify(existing, null, 2));
  const r = init({ agent: "antigravity", home, has: () => false });
  const step = r.mcp.find((m) => m.agent === "Antigravity");
  assert.equal(step.done, true);
  const out = JSON.parse(read(file, "utf8"));
  assert.deepEqual(out.mcpServers.gamedexy, MCP_ENTRY);
  assert.deepEqual(out.mcpServers.other, existing.mcpServers.other);
  assert.deepEqual(out.mcpServers.remote, existing.mcpServers.remote);
  assert.deepEqual(out.someSetting, { a: 1 });
  assert.deepEqual(Object.keys(out.mcpServers), ["other", "remote", "gamedexy"]);
  // Nothing sensitive is written for gamedexy, and the old file is backed up once.
  assert.equal(JSON.stringify(out.mcpServers.gamedexy).match(/token|bearer|key|secret|authorization/i), null);
  assert.deepEqual(JSON.parse(read(`${file}.bak-gamedexy-init`, "utf8")), existing);
  assert.ok(step.diff.some((l) => l.startsWith("+") && l.includes('"command": "npx"')));
  assert.ok(ex(file));
});

test("init (Antigravity): idempotent, never changes an existing gamedexy entry, --dry-run shows the diff and writes nothing", async () => {
  const { init } = await import("../src/init.mjs");
  const { readFileSync: read } = await import("node:fs");
  const { home, file } = await agyHome(JSON.stringify({ mcpServers: { a: { command: "x" } } }));
  const before = read(file, "utf8");
  const dry = init({ agent: "antigravity", home, dryRun: true, has: () => false }).mcp[0];
  assert.equal(dry.done, false);
  assert.match(dry.why, /dry run/);
  assert.ok(dry.diff.some((l) => l.includes('"mcp-remote@0.16.7"')));
  assert.equal(read(file, "utf8"), before);
  assert.equal(init({ agent: "antigravity", home, has: () => false }).mcp[0].done, true);
  const after = read(file, "utf8");
  const again = init({ agent: "antigravity", home, has: () => false }).mcp[0];
  assert.equal(again.done, false);
  assert.match(again.why, /already connected/);
  assert.equal(read(file, "utf8"), after);
  // A different gamedexy entry (hand-edited) is left alone too.
  const mine = { mcpServers: { gamedexy: { command: "my-bridge" } } };
  const h2 = await agyHome(JSON.stringify(mine));
  init({ agent: "antigravity", home: h2.home, has: () => false });
  assert.deepEqual(JSON.parse(read(h2.file, "utf8")), mine);
});

test("init (Antigravity): creates the config when the folder exists but the file does not; --transport url writes the native remote entry", async () => {
  const { init } = await import("../src/init.mjs");
  const { mkdirSync: mk, readFileSync: read } = await import("node:fs");
  const { join: j } = await import("node:path");
  const { home, file } = await agyHome();
  mk(j(home, ".gemini", "config"), { recursive: true });
  assert.equal(init({ agent: "antigravity", home, has: () => false, transport: "url" }).mcp[0].done, true);
  assert.deepEqual(JSON.parse(read(file, "utf8")), { mcpServers: { gamedexy: { serverUrl: "https://www.gamedexy.com/api/mcp" } } });
});

test("init (Antigravity): only when Antigravity is installed (agy or its config folder); a file it cannot parse is left alone", async () => {
  const { init } = await import("../src/init.mjs");
  const { existsSync: ex, readFileSync: read } = await import("node:fs");
  const { join: j } = await import("node:path");
  // Not installed: nothing is created under ~/.gemini, and `all` says nothing about it.
  const none = await agyHome();
  const all = init({ agent: "all", home: none.home, has: () => false, dryRun: true });
  assert.ok(!all.mcp.some((m) => m.agent === "Antigravity"));
  const asked = init({ agent: "antigravity", home: none.home, has: () => false });
  assert.match(asked.mcp[0].why, /not found/);
  assert.ok(!ex(j(none.home, ".gemini")));
  // The agy command alone is enough (the folder is made).
  const viaAgy = await agyHome();
  assert.equal(init({ agent: "antigravity", home: viaAgy.home, has: (c) => c === "agy" }).mcp[0].done, true);
  assert.ok(ex(viaAgy.file));
  // Broken JSON is not touched.
  const bad = await agyHome("{ not json");
  const r = init({ agent: "antigravity", home: bad.home, has: () => false }).mcp[0];
  assert.equal(r.done, false);
  assert.match(r.why, /not valid JSON/);
  assert.equal(read(bad.file, "utf8"), "{ not json");
  // An unexpected shape is not touched either.
  const odd = await agyHome(JSON.stringify({ mcpServers: [] }));
  assert.match(init({ agent: "antigravity", home: odd.home, has: () => false }).mcp[0].why, /unexpected shape/);
});

test("init: an unknown --transport is an error, not a silent stdio fallback", async () => {
  const { init } = await import("../src/init.mjs");
  const { existsSync: ex } = await import("node:fs");
  const { join: j } = await import("node:path");
  const { home } = await agyHome();
  assert.throws(() => init({ agent: "antigravity", home, has: () => false, transport: "sse" }), /--transport must be stdio or url \(got "sse"\)/);
  assert.ok(!ex(j(home, ".gemini")), "nothing was written");
  assert.equal(init({ agent: "antigravity", home, has: () => true, transport: "stdio", dryRun: true }).mcp[0].agent, "Antigravity");
});
