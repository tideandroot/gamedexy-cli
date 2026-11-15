// Replay on every build: route from a run, button re-finding, and stopping where the game changed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { aimFor, buildRoute, carryLabels, replay, sameScreen } from "../src/replay.mjs";

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const HOME = { phash: "ffff0000ffff0000", text: "Home Coins: 150 Play Shop Settings" };
const SHOP = { phash: "0000ffff0000ffff", text: "Shop Starter Pack $0.99 Back" };

function oldRun() {
  const dir = mkdtempSync(join(tmpdir(), "gdx-route-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ app_id: "com.x.game", platform: "android", build: { version: "0.1" }, launches: [{ after_step: 0, utc: "2026-11-10T00:00:00Z", state: null }] }));
  writeFileSync(join(dir, "steps.jsonl"), jsonl([{ step: 1, ...HOME, new: true }, { step: 2, ...SHOP, new: true }]));
  writeFileSync(join(dir, "taps.jsonl"), jsonl([
    { utc: "2026-11-10T00:00:05Z", after_step: 1, x: 500, y: 900, label: "Shop", allowed: true, sent: true },
    { utc: "2026-11-10T00:00:06Z", after_step: 2, x: 540, y: 1200, label: "$0.99", allowed: false, sent: false },
    { utc: "2026-11-10T00:00:07Z", after_step: 2, x: 540, y: 2000, label: "Back", allowed: true, sent: true },
  ]));
  return dir;
}

test("a route keeps only sent inputs, in order, each with the screen it was sent on", () => {
  const r = buildRoute(oldRun());
  assert.deepEqual(r.actions.map((a) => a.kind + (a.label ? `:${a.label}` : "")), ["launch", "tap:Shop", "tap:Back"]);
  assert.equal(r.actions[1].expect.text, HOME.text);
  assert.ok(!r.actions.some((a) => a.label === "$0.99"), "refused taps are never replayed");
});

test("same screen across builds: same picture, or the same words with small changes", () => {
  assert.ok(sameScreen(HOME, HOME));
  assert.ok(sameScreen(HOME, { phash: "0f0f0f0f0f0f0f0f", text: "Home Coins: 175 Play Shop Settings" }));
  assert.ok(!sameScreen(HOME, SHOP));
});

test("a moved button is found again by its text; without text the old point is used", () => {
  const boxes = [{ text: "Shop", x0: 100, y0: 300, x1: 200, y1: 340 }];
  assert.deepEqual(aimFor({ x: 500, y: 900, label: "Shop" }, boxes, 1), { x: 150, y: 320, moved: true });
  assert.deepEqual(aimFor({ x: 500, y: 900, label: "plain stone" }, boxes, 1), { x: 500, y: 900, moved: false });
});

function fakeIo(dir, screens) {
  let i = 0;
  const steps = [];
  const io = {
    calls: [],
    launch: async () => io.calls.push("launch"),
    shot: async () => {
      const s = { step: steps.length + 1, ...screens[Math.min(i, screens.length - 1)], boxes: [{ text: "Back", x0: 500, y0: 1980, x1: 580, y1: 2020 }] };
      steps.push(s);
      writeFileSync(join(dir, "steps.jsonl"), jsonl(steps));
      return { step: s.step };
    },
    tap: async (o) => { io.calls.push(`tap:${o.label}`); i++; return { sent: true }; },
    swipe: async () => ({ sent: true }),
    key: () => ({ sent: true }),
  };
  return io;
}

test("replay runs the route through the guarded commands and finishes when nothing changed", async () => {
  const old = oldRun();
  const route = join(old, "route.json");
  writeFileSync(route, JSON.stringify(buildRoute(old)));
  const dir = mkdtempSync(join(tmpdir(), "gdx-new-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ app_id: "com.x.game", platform: "android" }));
  const io = fakeIo(dir, [HOME, SHOP, HOME]);
  const out = await replay({ dir, route }, io);
  assert.equal(out.finished, true);
  assert.deepEqual(io.calls, ["launch", "tap:Shop", "tap:Back"]);
});

test("replay stops where the new build differs and cannot get back", async () => {
  const old = oldRun();
  const route = join(old, "route.json");
  writeFileSync(route, JSON.stringify(buildRoute(old)));
  const dir = mkdtempSync(join(tmpdir(), "gdx-new-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ app_id: "com.x.game", platform: "android" }));
  const io = fakeIo(dir, [{ phash: "1234123412341234", text: "Welcome back! New season starts" }]);
  const out = await replay({ dir, route, noRecover: true }, io);
  assert.equal(out.finished, false);
  assert.equal(out.stopped.reason, "screen changed");
  assert.match(readFileSync(join(dir, "replay.json"), "utf8"), /New season/);
});

test("labels carry over to matching screens; only new screens are left to label", () => {
  const old = oldRun();
  writeFileSync(join(old, "labels.json"), JSON.stringify({ screens: { home: { title: "Home" }, shop: { title: "Shop" } }, steps: { 1: ["home", null], 2: ["shop", null] } }));
  const dir = mkdtempSync(join(tmpdir(), "gdx-new-"));
  writeFileSync(join(dir, "steps.jsonl"), jsonl([{ step: 1, ...HOME }, { step: 2, phash: "9999999999999999", text: "Leaderboard 1. You 175" }, { step: 3, ...SHOP }]));
  const r = carryLabels(old, join(old, "labels.json"), dir);
  assert.equal(r.carried, 2);
  assert.deepEqual(r.todo, [2]);
  assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")).steps["3"], ["shop", "replayed"]);
});
