// Phase A of Slice 16: the first Android run (Pebble Path, a Godot game) and Windows support.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseUiDump } from "../src/devices.mjs";
import { checkTap } from "../src/guard.mjs";
import { guardBlind, osLabel } from "../src/map.mjs";
import { parseTesseractTsv, parseWindowsOcr, readText, readerName, windowsOcrAvailable } from "../src/ocr.mjs";
import { decodePng } from "../src/png.mjs";

const SHOP = fileURLToPath(new URL("./fixtures/pebble-shop.png", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/gamedexy.mjs", import.meta.url));

test("a canvas game's UI dump is empty, so on a machine with no text reader the guard is blind and refuses", () => {
  // Godot draws its own buttons: uiautomator sees one GodotView with no text.
  const dump = '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]"><node class="android.view.SurfaceView" text="" content-desc="" bounds="[0,0][1080,2400]"/></node></hierarchy>';
  assert.deepEqual(parseUiDump(dump), []);
  assert.equal(guardBlind({ text_source: "none", reader: null }), true);
  // A reader that ran and found no text is not blind: nothing on that screen can be a price.
  assert.equal(guardBlind({ text_source: "none", reader: "vision" }), false);
  // Steps recorded before readers were tracked keep working.
  assert.equal(guardBlind({ text_source: "none" }), false);
  assert.equal(guardBlind({ text_source: "ui-dump", reader: null }), false);
});

test("Android and iOS runtimes read as plain OS names", () => {
  assert.equal(osLabel("Android-15"), "Android 15");
  assert.equal(osLabel("com.apple.CoreSimulator.SimRuntime.iOS-18-2"), "iOS 18.2");
});

test("Windows OCR output becomes line boxes, scaled back up after a downscale", () => {
  const raw = JSON.stringify([
    ["$0.99", [100, 200, 160, 230]],
    ["Coin Bag", [50, 300, 110, 330, 120, 300, 200, 332]],
  ]);
  const boxes = parseWindowsOcr(raw, 2);
  assert.deepEqual(boxes[0], { text: "$0.99", x0: 200, y0: 400, x1: 320, y1: 460 });
  assert.deepEqual(boxes[1], { text: "Coin Bag", x0: 100, y0: 600, x1: 400, y1: 664 });
  // PowerShell unwraps an array of one line.
  assert.equal(parseWindowsOcr(JSON.stringify(["Play", [1, 2, 3, 4]]))[0].text, "Play");
  assert.deepEqual(parseWindowsOcr(""), []);
});

test("Tesseract TSV words join into lines and low-confidence noise is dropped", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t10\t20\t30\t10\t96\tCoin",
    "5\t1\t1\t1\t1\t2\t45\t21\t30\t10\t95\tBag",
    "5\t1\t1\t1\t2\t1\t10\t50\t40\t12\t91\t$2.99",
    "5\t1\t1\t1\t3\t1\t10\t80\t40\t12\t12\t~~",
  ].join("\n");
  const lines = parseTesseractTsv(tsv);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { text: "Coin Bag", x0: 10, y0: 20, x1: 75, y1: 31 });
  assert.equal(lines[1].text, "$2.99");
});

test("on a machine with a text reader, Pebble Path's TEST shop prices are refused", { skip: readerName() === null && "no text reader on this machine" }, () => {
  const img = decodePng(readFileSync(SHOP));
  const boxes = readText(SHOP);
  const price = boxes.find((b) => /0\.99/.test(b.text));
  assert.ok(price, `no price read; got ${JSON.stringify(boxes.map((b) => b.text))}`);
  const x = (price.x0 + price.x1) / 2;
  const y = (price.y0 + price.y1) / 2;
  assert.match(checkTap(boxes, x, y, img.width), /^price/);
  const back = boxes.find((b) => b.text === "Back");
  if (back) assert.equal(checkTap(boxes, (back.x0 + back.x1) / 2, (back.y0 + back.y1) / 2, img.width), null);
});

test("Windows: the built-in text reader is found (CI runs this on windows-latest)", { skip: process.platform !== "win32" && "not Windows" }, () => {
  assert.equal(windowsOcrAvailable(), true, "Windows.Media.Ocr has no recognizer language on this machine");
  assert.equal(readerName(), "windows");
});

test("the CLI starts on every OS: help, version, and doctor fail cleanly without crashing", () => {
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  assert.match(run("help").stdout, /gamedexy map start/);
  assert.match(run("version").stdout, /"version"/);
  const ios = JSON.parse(run("doctor", "--platform", "ios").stdout);
  if (process.platform !== "darwin") {
    assert.equal(ios.ready, false);
    assert.ok(ios.checks.some((c) => c.check === "macOS" && c.ok === false));
  }
  const android = JSON.parse(run("doctor", "--platform", "android").stdout);
  assert.ok(android.checks.some((c) => c.check === "Text reader for the purchase guard"));
  assert.ok(android.checks.some((c) => c.check === "Free disk space"));
});

test("AGENTS.md carries the same instructions as SKILL.md, and the reference files ship", () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(`../skill/${f}`, import.meta.url)), "utf8");
  const body = (t) => t.slice(t.indexOf("# Gamedexy Game Map"));
  assert.equal(body(read("AGENTS.md")), body(read("SKILL.md")));
  for (const f of ["DEEP.md", "ENGINES.md"]) assert.ok(read(f).length > 500, f);
  assert.ok(read("SKILL.md").split("\n").length < 140, "the quick-run skill stays short (the inventory shape example needs a few lines)");
  assert.match(read("SKILL.md"), /Quick run \(suggested\)/);
});

test("store check reads fastlane's Google Play layout too", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fastlaneListing } = await import("../src/extras.mjs");
  const repo = mkdtempSync(join(tmpdir(), "gdx-fl-"));
  const base = join(repo, "fastlane", "metadata", "android", "en-US");
  mkdirSync(join(base, "images", "phoneScreenshots"), { recursive: true });
  writeFileSync(join(base, "title.txt"), "Pebble Path");
  writeFileSync(join(base, "full_description.txt"), "Light the stones. No ads.");
  writeFileSync(join(base, "images", "phoneScreenshots", "1.png"), "x");
  const l = fastlaneListing(repo);
  assert.equal(l.source, "fastlane");
  assert.equal(l.name, "Pebble Path");
  assert.match(l.description, /No ads/);
  assert.equal(l.shots.length, 1);
});
