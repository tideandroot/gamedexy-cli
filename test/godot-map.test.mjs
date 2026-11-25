// Fixes 3, 4, 5 (Rattlepop run), map side: guessed openers are not real captures, an animated start screen is
// still "the start screen", and map send can drop steps that are not screens.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { captureAll, looksSame, payload, send } from "../src/map.mjs";

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const hex = (n) => BigInt.asUintN(64, n).toString(16).padStart(16, "0");
const entry = (key, extra = {}) => ({ key, category: "shop", open: `screen=${key}`, needs: null, from: null, sure: true, ...extra });

/** captureAll against a fake device. `show(state, n)` returns {phash, text} for what the game shows. */
async function runCapture(checklist, show, opts = {}) {
  const dir = tmp("gdx-fake-");
  writeFileSync(join(dir, "run.json"), JSON.stringify({ platform: "ios", launches: [] }));
  const scanFile = join(dir, "scan.json");
  writeFileSync(scanFile, JSON.stringify({ checklist, edges: [], screens: [] }));
  const steps = [];
  let state = "";
  const io = {
    launch: async (o) => {
      state = o.state ?? "";
    },
    settle: async () => {},
    shot: async (o) => {
      const n = steps.length + 1;
      steps.push({ step: n, ...show(state, n), action: o.action });
      writeFileSync(join(dir, "steps.jsonl"), steps.map((x) => JSON.stringify(x)).join("\n") + "\n");
      return { step: n, app_running: true, text: "" };
    },
  };
  const r = await captureAll({ dir, scan: scanFile, all: true, io, ...opts });
  return { r, dir, steps };
}

// ---- 3. guessed placeholder openers ---------------------------------------------------------

test("map capture skips guessed openers unless --include-guessed, and then never counts them as captured", async () => {
  const list = [
    entry("shop", { code: { path: "res://shop.gd", call: "open", args: ['"gems"'] } }),
    entry("celebration", { sure: false, code: { path: "res://c.gd", call: "show_celebration", args: ['""', '""'], guessed_args: true } }),
  ];
  const show = (state, n) => (/screen=(shop|celebration)/.test(state) ? { phash: hex(BigInt(n) * 0x9e3779b97f4a7c15n), text: state } : { phash: hex(0n), text: "home" });
  const a = await runCapture(list, show);
  assert.equal(a.r.captured, 1);
  assert.equal(a.r.of, 1, "the skipped key was never launched");
  assert.deepEqual(a.r.skipped_guessed.map((s) => s.key), ["celebration"]);
  assert.match(a.r.skipped_guessed[0].call, /show_celebration\(/);
  assert.ok(!JSON.parse(readFileSync(a.r.labels, "utf8")).screens.celebration);

  const b = await runCapture(list, show, { includeGuessed: true });
  assert.equal(b.r.captured, 1, "a guessed capture is not a real capture");
  assert.deepEqual(b.r.unsure_guessed_args, ["celebration"]);
  const labels = JSON.parse(readFileSync(b.r.labels, "utf8"));
  assert.equal(labels.screens.celebration.confidence, 0.3);
  assert.equal(Object.keys(labels.steps).length, b.steps.length, "every step is still labelled");
  assert.match(Object.values(labels.steps).find((v) => v[0] === "celebration")[1], /guessed arguments \(unsure\)/);
});

// ---- 4. animated start screen ---------------------------------------------------------------

test("looksSame tolerates animation (a few hash bits and OCR noise) but not a different screen", () => {
  const a = { phash: hex(0xf0f0f0f0f0f0f0f0n), text: "Safe Camp Hold to roll Dice Forge" };
  assert.ok(looksSame(a, { phash: hex(0xf0f0f0f0f0f0f0f0n ^ 0xffn), text: "Safe Camp Hold to roll Dice Forgc" }), "8 bits + OCR typo");
  assert.ok(looksSame(a, { phash: hex(0xf0f0f0f0f0f0f0f0n ^ 0xfn), text: "Safe Camp Hold to roll Dlce Forge" }), "4 bits + OCR typo");
  assert.ok(!looksSame(a, { phash: hex(0xf0f0f0f0f0f0f0f0n ^ 0xfn), text: "something else" }), "4 bits but other text is another screen");
  assert.ok(!looksSame(a, { phash: hex(0xf0f0f0f0f0f0f0f0n ^ 0xffn), text: "Workshop Upgrades" }), "8 bits but other text");
  assert.ok(!looksSame(a, { phash: hex(0x0f0f0f0f0f0f0f0fn), text: a.text }), "different picture");
});

test("looksSame keeps real Gloamwick screens apart: same layout 4 bits away, different text", () => {
  // capture-gloamwick-2026-11-15: result vs result_snuffed, hash distance 4.
  const result = { phash: hex(0xaaaaaaaaaaaaaaaan), text: "DAWN 3,120 NEW BEST! Play again" };
  const snuffed = { phash: hex(0xaaaaaaaaaaaaaaaan ^ 0xfn), text: "SNUFFED 1,460 Best 2,100 Play again" };
  assert.ok(!looksSame(result, snuffed));
  assert.ok(!looksSame(snuffed, result));
});

test("looksSame: empty OCR text falls back to the strict hash rule", () => {
  const h = 0xf0f0f0f0f0f0f0f0n;
  assert.ok(looksSame({ phash: hex(h), text: "" }, { phash: hex(h ^ 0x3n), text: "" }), "2 bits, no text");
  assert.ok(!looksSame({ phash: hex(h), text: "" }, { phash: hex(h ^ 0xfn), text: "" }), "4 bits, no text is not enough");
  assert.ok(!looksSame({ phash: hex(h), text: "Shop" }, { phash: hex(h ^ 0xfn), text: undefined }), "one side without text");
  assert.ok(!looksSame({ phash: hex(h), text: "" }, { phash: hex(h ^ 0xffn), text: "" }), "8 bits, no text");
});

test("looksSame: text that differs only in numbers is a different state (Gloamwick login_reward_card)", () => {
  const h = 0x1234567890abcdefn;
  const day1 = { phash: hex(h), text: "Gloamwick Day 1 of keeping the flame +25 motes PLAY Daily Shop" };
  const day3 = { phash: hex(h ^ 0x3ffn), text: "Gloamwick Day 3 of keeping the flame +40 motes PLAY Daily Shop" };
  assert.ok(!looksSame(day1, day3), "10 bits, Day 1 +25 vs Day 3 +40");
  assert.ok(looksSame(day1, { phash: hex(h ^ 0x3ffn), text: "Gloamwick Day 1 of keeping the flarne +25 motes PLAY Daily Shop" }), "10 bits, only a letter typo");
  assert.ok(looksSame(day1, { phash: hex(h ^ 0x1n), text: "Gloamwick Day 3 of keeping the flame +40 motes PLAY Daily Shop" }), "1 bit: the picture is the same, a digit is OCR noise");
});

test("map capture reports keys that came up as the (animated) start screen as not reached", async () => {
  // The start screen has dice that move: every frame differs a little. 'title' and 'arena' have no opener
  // in the game, so the launch returns the start screen again; 'shop' really opens.
  const list = [entry("shop"), entry("title", { category: "menu" }), entry("arena", { category: "gameplay" })];
  let frame = 0;
  const show = (state) => {
    if (/screen=shop/.test(state)) return { phash: hex(0x1234567890abcdefn), text: "Shop Gems Coins" };
    frame++;
    return { phash: hex(0xf0f0f0f0f0f0f0f0n ^ (frame % 2 ? 0x3cn : 0x30cn)), text: `Safe Camp Hold to roll ${["Dice", "Dlce", "Dice"][frame % 3]} Forge` };
  };
  const { r } = await runCapture(list, show);
  assert.deepEqual(r.not_reached.sort(), ["arena", "title"], JSON.stringify(r));
  assert.equal(r.captured, 1, "only the shop is a real capture");
  const arena = r.failed.find((f) => f.key === "arena");
  assert.match(arena.reason, /not reached/);
  const labels = JSON.parse(readFileSync(r.labels, "utf8"));
  assert.ok(!labels.screens.arena && !labels.screens.title, "a key that was not reached is not labelled as that screen");
});

// ---- 5. map send --skip ---------------------------------------------------------------------

function sendRun() {
  const dir = tmp("gdx-send-");
  writeFileSync(join(dir, "run.json"), JSON.stringify({ platform: "ios", launches: [], run_id: "r1" }));
  const steps = [1, 2, 3].map((n) => ({ step: n, utc: "2026-01-01T00:00:00Z", action: `shot ${n}`, phash: hex(BigInt(n)), text: `t${n}`, width: 10, height: 10, image_type: "png", full: join(dir, `${n}.png`), thumb: join(dir, `${n}t.png`) }));
  writeFileSync(join(dir, "steps.jsonl"), steps.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const labels = { screens: { main: { title: "Main", category: "home", tags: [], proposed_tags: [], confidence: 0.9 }, junk: { title: "Junk", category: "home", tags: [], proposed_tags: [], confidence: 0.1 } }, steps: { 1: ["main", "a"], 2: ["junk", "b"] } };
  const lf = join(dir, "labels.json");
  writeFileSync(lf, JSON.stringify(labels));
  return { dir, lf, labels };
}

test("map send --skip drops steps that are not screens, by key or step number, with no label needed", async () => {
  const { dir, lf } = sendRun();
  // Step 3 has no label: without --skip the send is refused.
  assert.throws(() => payload({ dir, labels: lf }), /Missing: 3/);
  const p = payload({ dir, labels: lf, skip: "junk,3" });
  assert.equal(p.screens, 1);
  assert.deepEqual(p.skipped_steps.sort(), [2, 3]);
  const sent = JSON.parse(readFileSync(p.batches[0], "utf8")).screens;
  assert.deepEqual(sent.map((x) => x.screen_key), ["main"]);

  const calls = [];
  const r = await send({ dir, labels: lf, skip: "2,3", callTool: async (name, args) => (calls.push(args), { screens: args.screens.map((x) => ({ step: x.step, accepted: false, errors: ["test"] })) }), fetch: async () => ({ ok: true }) });
  assert.equal(r.screens, 1);
  assert.deepEqual(r.skipped_steps.sort(), [2, 3]);
  assert.deepEqual(calls[0].screens.map((x) => x.step), [1]);
  // A typo is an error, not a silent no-op.
  assert.throws(() => payload({ dir, labels: lf, skip: "nope,3" }), /names no step or screen key in this run: nope/);
});

test("map send reads an exclude list from labels.json", () => {
  const { dir, lf, labels } = sendRun();
  writeFileSync(lf, JSON.stringify({ ...labels, exclude: ["junk", 3, "stale_key_from_a_retake"] }));
  const p = payload({ dir, labels: lf });
  assert.equal(p.screens, 1);
  assert.deepEqual(p.skipped_steps.sort(), [2, 3]);
});
