// gamedexy check-export: fails when an exported build holds the gamedexy/ dev folder or a capture script.
// Fixtures: two real packs made by Godot 4.7.2 (format 4) and small archives built here (pack format 1, zip, apk-like).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { doctor } from "../src/doctor.mjs";
import { checkExport, isDevPath } from "../src/export-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => join(here, "fixtures", "export", n);
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const BIN = join(here, "..", "bin", "gamedexy.mjs");

/** A pack with the header layout of `version`: format 1 (Godot 3) has an 84-byte header and no per-file flags; format 2 (Godot 4.0+) 96 bytes. */
function pck(paths, version = 2) {
  const headLen = version === 1 ? 84 : 96;
  const head = Buffer.alloc(headLen);
  head.writeUInt32LE(0x43504447, 0);
  head.writeUInt32LE(version, 4);
  head.writeUInt32LE(version === 1 ? 3 : 4, 8);
  const parts = [head];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(paths.length);
  parts.push(count);
  for (const p of paths) {
    const name = Buffer.from(p);
    const padded = Buffer.alloc(Math.ceil(name.length / 4) * 4);
    name.copy(padded);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(padded.length);
    parts.push(len, padded, Buffer.alloc(8 + 8 + 16 + (version === 1 ? 0 : 4)));
  }
  return Buffer.concat(parts);
}
const pckV1 = (paths) => pck(paths, 2); // the existing tests use the Godot 4.0 layout

/** A zip with stored or deflated entries. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const raw = Buffer.from(data ?? "");
    const body = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const put = (name, data) => {
  const f = join(tmp("gdx-exp-"), name);
  writeFileSync(f, data);
  return f;
};

test("what counts as a dev file", () => {
  for (const p of ["res://gamedexy/capture.gd", "gamedexy/capture.gdc", "assets/gamedexy/x.png", "Payload/Game.app/gamedexy/a", "res://gamedexy_capture.gd", "res://gamedexy_codex.gdc", "GamedexyCapture.swift", "src/GamedexyCapture.kt"]) assert.equal(isDevPath(p), true, p);
  // The stub ships on purpose; look-alikes are not flagged.
  for (const p of ["res://gamedexy_stub.gd", "res://src/main.gd", "res://gamedexyx/a.gd", "res://my_gamedexy.gd", "assets/gamedexy.png"]) assert.equal(isDevPath(p), false, p);
});

test("real Godot 4.7.2 packs: a clean one passes, one with gamedexy/ fails and names the files", () => {
  const ok = checkExport(fx("godot-4.7.2-clean.pck"));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.found, []);
  assert.ok(ok.checked.entries >= 3);
  const bad = checkExport(fx("godot-4.7.2-dirty.pck"));
  assert.equal(bad.ok, false);
  assert.ok(bad.found.some((f) => f.path.startsWith("gamedexy/capture.gd")), JSON.stringify(bad.found));
  assert.match(bad.verdict, /Do not ship/);
});

test("pack format 1 (Godot 3): the file table starts at byte 84, not 96", () => {
  const ok = checkExport(put("v1.pck", pck(["res://project.binary", "res://main.gdc"], 1)));
  assert.equal(ok.ok, true);
  assert.equal(ok.checked.entries, 2);
  const bad = checkExport(put("v1b.pck", pck(["res://project.binary", "res://gamedexy/capture.gd"], 1)));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.found.map((f) => f.path), ["res://gamedexy/capture.gd"]);
});

test("pack format 2 (Godot 4.0 to 4.3): the file table starts at byte 96", () => {
  assert.equal(checkExport(put("a.pck", pckV1(["res://project.binary", "res://src/main.gdc", "res://gamedexy_stub.gdc"]))).ok, true);
  const bad = checkExport(put("b.pck", pckV1(["res://project.binary", "res://gamedexy/capture.gdc", "res://gamedexy_capture.gd.remap"])));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.found.map((f) => f.path).sort(), ["res://gamedexy/capture.gdc", "res://gamedexy_capture.gd.remap"].sort());
});

test("an encrypted or unknown pack cannot be checked, which is a failure, not a pass", () => {
  const enc = pckV1(["res://a.gdc"]);
  enc.writeUInt32LE(1, 20); // encrypted directory flag
  const r = checkExport(put("e.pck", enc));
  assert.equal(r.ok, false);
  assert.match(r.unreadable[0].why, /encrypted/);
  const junk = checkExport(put("j.pck", Buffer.from("not a pack at all")));
  assert.equal(junk.ok, false);
  assert.equal(junk.found.length, 0);
  assert.match(junk.verdict, /could not be checked/);
});

test("a zip: loose gamedexy/ paths and capture scripts are found, a clean one passes", () => {
  assert.equal(checkExport(put("ok.zip", zip([{ name: "game.x86_64", data: "x" }, { name: "game.pck", data: pckV1(["res://a.gdc"]) }]))).ok, true);
  const bad = checkExport(put("bad.zip", zip([{ name: "assets/gamedexy/capture.gd", data: "x" }, { name: "assets/GamedexyCapture.swift", data: "y" }])));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.found.map((f) => f.path), ["assets/gamedexy/capture.gd", "assets/GamedexyCapture.swift"]);
});

test("an apk or ipa: the .pck inside is read, stored or deflated", () => {
  const clean = pckV1(["res://project.binary", "res://gamedexy_stub.gdc"]);
  const dirty = pckV1(["res://project.binary", "res://gamedexy/capture.gdc"]);
  for (const deflate of [false, true]) {
    const apk = checkExport(put("g.apk", zip([{ name: "AndroidManifest.xml", data: "m" }, { name: "assets/game.pck", data: clean, deflate }])));
    assert.equal(apk.ok, true, `apk deflate=${deflate}`);
    assert.equal(apk.checked.packs, 1);
    const ipa = checkExport(put("g.ipa", zip([{ name: "Payload/Game.app/Info.plist", data: "p" }, { name: "Payload/Game.app/game.pck", data: dirty, deflate }])));
    assert.equal(ipa.ok, false, `ipa deflate=${deflate}`);
    assert.deepEqual(ipa.found.map((f) => f.path), ["Payload/Game.app/game.pck: res://gamedexy/capture.gdc"]);
  }
});

test("a pack appended to an executable (embed pck) is found by its footer", () => {
  const pck = pckV1(["res://gamedexy/capture.gdc"]);
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(pck.length));
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(0x43504447);
  const exe = Buffer.concat([Buffer.alloc(300, 7), pck, size, magic]);
  const r = checkExport(put("game.exe", exe));
  assert.equal(r.ok, false);
  assert.equal(r.found[0].path, "res://gamedexy/capture.gdc");
});

test("an exported folder is walked: files, nested archives and packs", () => {
  const dir = tmp("gdx-expdir-");
  mkdirSync(join(dir, "Game.app", "Contents"), { recursive: true });
  writeFileSync(join(dir, "Game.app", "Contents", "Info.plist"), "p");
  writeFileSync(join(dir, "Game.app", "Contents", "game.pck"), pckV1(["res://a.gdc"]));
  assert.equal(checkExport(dir).ok, true);
  mkdirSync(join(dir, "Game.app", "Contents", "gamedexy"));
  writeFileSync(join(dir, "Game.app", "Contents", "gamedexy", "x.gd"), "x");
  const r = checkExport(dir);
  assert.equal(r.ok, false);
  assert.ok(r.found.some((f) => f.path.includes("gamedexy/x.gd")));
  // A folder with nothing to read cannot vouch for anything.
  const empty = tmp("gdx-expempty-");
  writeFileSync(join(empty, "notes.txt"), "x");
  assert.equal(checkExport(empty).ok, false);
});

test("the CLI: exit 0 for a clean build, 1 for a dirty one, and doctor --export says the same", () => {
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  const clean = run("check-export", fx("godot-4.7.2-clean.pck"));
  assert.equal(clean.status, 0);
  assert.equal(JSON.parse(clean.stdout).ok, true);
  const dirty = run("check-export", fx("godot-4.7.2-dirty.pck"));
  assert.equal(dirty.status, 1);
  assert.equal(JSON.parse(dirty.stdout).ok, false);
  const missing = run("check-export", join(tmp("gdx-none-"), "nope.pck"));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /does not exist/);
  const d = doctor({ export: fx("godot-4.7.2-dirty.pck") });
  assert.equal(d.ready, false);
  assert.equal(doctor({ export: fx("godot-4.7.2-clean.pck") }).ready, true);
});
