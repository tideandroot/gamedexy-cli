// Launch gate 2026-11 (docs/ops/GAME_MAP_LAUNCH_GATE_2026-11.md): regressions for the CLI side.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { GUARD_VERSION } from "../src/guard.mjs";
import { finish, lookFor, startSignedIn, statsReport, validateInventory } from "../src/map.mjs";
import { carryIssues, carryLabels } from "../src/replay.mjs";

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const MENU = { phash: "ffff0000ffff0000", text: "Gloamwick Play Shop Best Nights Settings" };
// The reward popup over the same menu: a look-alike of the menu.
const REWARD = { phash: "ffff0000ffff0001", text: "Gloamwick Play Shop Best Nights Settings Daily reward Claim" };
const BEST = { phash: "00ff00ff00ff00ff", text: "Best Nights Game Center is stubbed in this build Back" };

test("bug 3: replay carries each step's own label, not the first look-alike's", () => {
  const from = tmp("gdx-from-");
  writeFileSync(join(from, "steps.jsonl"), jsonl([{ step: 1, ...REWARD }, { step: 2, ...MENU }, { step: 3, ...BEST }, { step: 4, ...MENU }]));
  const labels = join(from, "labels.json");
  writeFileSync(labels, JSON.stringify({ screens: {}, steps: { 1: ["login-reward", null], 2: ["home", null], 3: ["best-nights", null], 4: ["home", null] } }));
  const dir = tmp("gdx-new-");
  writeFileSync(join(dir, "steps.jsonl"), jsonl([{ step: 1, ...REWARD }, { step: 2, ...MENU }, { step: 3, ...BEST }, { step: 4, ...MENU }, { step: 5, ...MENU }]));
  // Step 5 is the end-of-route shot: no route step, so the closest look-alike (the plain menu) wins.
  const out = carryLabels(from, labels, dir, { 1: 1, 2: 2, 3: 3, 4: 4 });
  const got = JSON.parse(readFileSync(out.file, "utf8")).steps;
  assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v[0]])), { 1: "login-reward", 2: "home", 3: "best-nights", 4: "home", 5: "home" });
});

function runDir(steps, labels) {
  const dir = tmp("gdx-run-");
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "run-B", app_id: "x", platform: "ios", started_utc: "2026-11-12T00:00:00Z", launches: [] }));
  writeFileSync(join(dir, "steps.jsonl"), jsonl(steps));
  writeFileSync(join(dir, "labels.json"), JSON.stringify({ screens: {}, steps: labels }));
  writeFileSync(join(dir, "replay.json"), "{}");
  return dir;
}

test("bug 1: a replay re-checks the agent's issues by text on the same screen key, never Fixed by default", async () => {
  const from = tmp("gdx-from-");
  writeFileSync(join(from, "labels.json"), JSON.stringify({ steps: { 3: ["best-nights", null], 7: ["gloam-pass", null], 9: ["settings", null], 11: ["results", null] } }));
  writeFileSync(join(from, "issues.sent.json"), JSON.stringify([
    { step: 3, kind: "error_text", detail: 'Developer note "Game Center is stubbed" on Best Nights' },
    { step: 7, kind: "error_text", detail: 'Price shows "-- gems" instead of a price' },
    { step: 9, kind: "other", detail: 'Settings has a "Debug overlay" switch' },
    { step: 11, kind: "dead_tap", detail: "Share does nothing" },
  ]));
  const carried = carryIssues(from, join(from, "labels.json"));
  assert.equal(carried.length, 4);
  assert.equal(carried[0].screen_key, "best-nights");
  assert.equal(carried[0].look_for, "Game Center is stubbed");
  // The new build: Best Nights still shows the note, Gloam Pass now has a price, Settings not reached.
  const dir = runDir(
    [{ step: 1, ...BEST }, { step: 2, phash: "1", text: "Gloam Pass $4.99 Back" }],
    { 1: ["best-nights", "replayed"], 2: ["gloam-pass", "replayed"] },
  );
  writeFileSync(join(dir, "carried-issues.json"), JSON.stringify(carried));
  let sent;
  const out = await finish({ dir, callTool: async (_n, args) => ((sent = args), { map_url: "https://gdx.test/m" }) });
  assert.deepEqual(sent.issues.map((i) => [i.step, i.screen_key, i.kind]), [[1, "best-nights", "error_text"]]);
  const by = Object.fromEntries(sent.rechecked.map((r) => [r.screen_key, r.result]));
  assert.deepEqual(by, { "gloam-pass": "fixed", settings: "not_checked", results: "not_checked" });
  assert.deepEqual(out.rechecked_from_last_build, { still_there: 1, gone: 1, not_checked: 2 });
  assert.equal(sent.stats.replay, true);
});

test("bug 1: an issue with no quoted text cannot be re-checked by text, so it is Not checked even on its screen", async () => {
  const dir = runDir([{ step: 1, phash: "1", text: "Results Share" }], { 1: ["results", null] });
  writeFileSync(join(dir, "carried-issues.json"), JSON.stringify([{ kind: "dead_tap", detail: "Share does nothing", screen_key: "results", look_for: lookFor("Share does nothing") }]));
  let sent;
  await finish({ dir, callTool: async (_n, args) => ((sent = args), {}) });
  assert.equal(sent.rechecked[0].result, "not_checked");
  assert.equal(sent.issues, undefined);
});

test("map finish keeps the confirmed issues with the run, for the next replay", async () => {
  const dir = runDir([{ step: 1, ...BEST }], { 1: ["best-nights", null] });
  writeFileSync(join(dir, "issues.json"), JSON.stringify([{ step: 1, kind: "error_text", detail: 'Shows "Game Center is stubbed"' }]));
  await finish({ dir, issues: join(dir, "issues.json"), callTool: async () => ({}) });
  assert.ok(existsSync(join(dir, "issues.sent.json")));
});

test("bug 4: a rejected inventory stops map start before any run is opened, so the folder can be reused", async () => {
  const dir = tmp("gdx-start-");
  const inv = join(dir, "..", `inv-${process.pid}.json`);
  writeFileSync(inv, JSON.stringify({ screens: [{ name: "Home", file: "Home.swift" }] }));
  const calls = [];
  await assert.rejects(
    startSignedIn({ dir, platform: "ios", device: "x", appId: "a", game: "G", inventory: inv, callTool: async (n) => (calls.push(n), {}) }),
    /nothing was started.*screens\[0\]\.key: required/,
  );
  assert.deepEqual(calls, []);
  assert.ok(!existsSync(join(dir, "run.json")));
});

test("bug 5: the inventory shape SKILL.md describes is the one the check accepts", () => {
  const skill = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  const sample = JSON.parse(skill.match(/```json\r?\n([\s\S]*?)\r?\n\s*```/)[1]);
  assert.deepEqual(validateInventory(sample), []);
  assert.ok(sample.screens.every((s) => s.key && s.where && Array.isArray(s.screen_keys)));
  assert.match(skill, /screen_keys/);
  assert.match(skill, /map launch/);
  assert.deepEqual(validateInventory({ ads: [{ name: "x" }], currencies: [{}], events: "no" }), ["ads[0].key: required (a string)", "currencies[0].key: required (a string)", "events must be a list"]);
});

test("map stats prints the issue hints first and the measurements once, as counts", () => {
  const dir = runDir([{ step: 1, ...BEST, layout: { w: 1, h: 1 } }], {});
  writeFileSync(join(dir, "issues.jsonl"), jsonl([{ step: 1, kind: "error_text", detail: "x", source: "cli" }]));
  const out = statsReport({ dir });
  assert.equal(Object.keys(out)[0], "issue_hints");
  assert.equal(out.measure.steps_measured, 1);
  assert.ok(!JSON.stringify(out).includes('"for_map_finish_run"'));
});

test("gamedexy --version prints the version", () => {
  const out = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../bin/gamedexy.mjs", import.meta.url)), "--version"], { encoding: "utf8" }));
  assert.equal(out.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

// Only in the main repository: the public mirror (gamedexy-cli) has no server code to compare with.
const SERVER = new URL("../../apps/web/src/lib/mcp-gamemap.ts", import.meta.url);
test("the guard version agrees with the server's", { skip: !existsSync(SERVER) && "server code not here (public mirror)" }, () => {
  const server = readFileSync(SERVER, "utf8").match(/GUARD_VERSION = "([^"]+)"/)?.[1];
  if (server) assert.equal(server, GUARD_VERSION);
});
