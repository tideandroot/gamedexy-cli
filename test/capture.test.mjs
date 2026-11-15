import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { captureInit } from "../src/capture.mjs";
import { captureAll, levelSummary, levelsReached, navFrom, stepsToSend } from "../src/map.mjs";
import { scan } from "../src/scan.mjs";

const fx = (name) => join(dirname(fileURLToPath(import.meta.url)), "fixtures", "scan", name);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

test("capture init writes the debug-only list only off the main branch, and every template reads gdxState", () => {
  for (const e of ["swift", "kotlin", "godot", "unity"]) {
    const d = captureInit({ src: fx(e), dryRun: true });
    assert.ok(d.content.includes("gdxState"), `${e}: the release check looks for gdxState`);
    assert.ok(d.screens.length > 0, e);
    assert.ok(/#if DEBUG|BuildConfig\.DEBUG|is_debug_build|DEVELOPMENT_BUILD/.test(d.content), `${e}: debug builds only`);
  }
  const repo = mkdtempSync(join(tmpdir(), "gdx-cap-"));
  cpSync(fx("swift"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  assert.throws(() => captureInit({ src: repo }), /own branch/);
  git(repo, "switch", "-qc", "gamedexy/capture");
  const w = captureInit({ src: repo });
  assert.equal(w.written, "App/GamedexyCapture.swift");
  assert.ok(readFileSync(join(repo, w.written), "utf8").includes('"shop_gems"'));
  assert.equal(w.levels.count, 3);
  assert.throws(() => captureInit({ src: repo }), /already exists/);
});

test("map capture opens each key, labels what opened and reports what did not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-capall-"));
  const out = mkdtempSync(join(tmpdir(), "gdx-capscan-"));
  const s = scan({ src: fx("swift"), out });
  const run = { platform: "ios", launches: [], levels: levelSummary(JSON.parse(readFileSync(s.inventory, "utf8")).levels) };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  // A fake game: the capture list opens shop tabs and worlds, but not level_map (it stays on home).
  let state = "";
  const steps = [];
  const io = {
    launch: async (o) => {
      state = o.state ?? "";
      const r = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
      r.launches.push({ state: o.state ?? null, ...(o.capture ? { capture: true } : {}) });
      writeFileSync(join(dir, "run.json"), JSON.stringify(r));
    },
    settle: async () => {},
    shot: async (o) => {
      const screen = /screen=(shop|win|home)/.test(state) || /world=/.test(state) ? state : "";
      const n = steps.length + 1;
      const phash = screen ? (BigInt(n) * 0x9e3779b97f4a7c15n).toString(16).padStart(16, "0").slice(-16) : "0000000000000000";
      steps.push({ step: n, phash, text: screen || "home tap to play", action: o.action });
      writeFileSync(join(dir, "steps.jsonl"), steps.map((x) => JSON.stringify(x)).join("\n") + "\n");
      return { step: n, app_running: true, text: "" };
    },
  };
  const r = await captureAll({ dir, scan: s.scan, all: true, io });
  assert.equal(r.levels.count, 3);
  assert.equal(r.levels.reached, 3);
  assert.ok(r.failed.some((f) => f.key === "level_map" && /start screen/.test(f.reason)), JSON.stringify(r.failed));
  const labels = JSON.parse(readFileSync(r.labels, "utf8"));
  assert.equal(labels.screens.world_moss_cave.title, "World: Moss Cave");
  assert.equal(labels.screens.shop_gems.category, "shop");
  assert.ok(!labels.screens.level_map, "a key that did not open is not labelled as that screen");
  assert.equal(Object.keys(labels.steps).length, steps.length, "every step is labelled, so map send works");
  assert.equal(levelsReached(dir, JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).reached_count, 3);
  await assert.rejects(() => captureAll({ dir, scan: s.scan, io }), /--all/);

  // A second pass for one key: the start screen keeps its name, and only the newest shot of each screen is sent.
  const again = await captureAll({ dir, scan: s.scan, only: "shop_gems", io });
  assert.equal(again.captured, 1);
  const l2 = JSON.parse(readFileSync(r.labels, "utf8"));
  assert.ok(!Object.keys(l2.screens).some((k) => k.endsWith("_start") && k !== Object.values(l2.steps)[0][0]), "no second start-screen key");
  const all = readFileSync(join(dir, "steps.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
  const sent = stepsToSend(dir, all);
  const shopSteps = sent.filter((x) => l2.steps[String(x.step)][0] === "shop_gems");
  assert.equal(shopSteps.length, 1, "one shot of shop_gems is sent");
  assert.equal(shopSteps[0].step, Math.max(...all.filter((x) => l2.steps[String(x.step)][0] === "shop_gems").map((x) => x.step)), "the newest one");
  assert.equal(sent.filter((x) => l2.steps[String(x.step)][1] === "plain launch").length, 1, "one start screen");
  assert.ok(!sent.some((x) => /did not open/.test(l2.steps[String(x.step)][1] ?? "")), "shots that did not open are not sent");
});

test("flows from code: the scan's navigation in capture keys, with tabs and levels linked", () => {
  const out = mkdtempSync(join(tmpdir(), "gdx-nav-"));
  const s = scan({ src: fx("swift"), out });
  const nav = navFrom(JSON.parse(readFileSync(s.scan, "utf8")));
  const has = (from, to, kind) => nav.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
  assert.ok(has("home", "shop_gems", "sheet"), JSON.stringify(nav));
  assert.ok(has("home", "level_map", "push"));
  assert.ok(has("shop_gems", "shop_coins", "tab"));
  assert.ok(has("home", "world_moss_cave", "level"));
  assert.ok(!nav.some((e) => e.from === e.to));
});
