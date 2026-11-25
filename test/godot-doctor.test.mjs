// Fix 1 (Rattlepop run): doctor says when a Godot project has only a release engine, where
// OS.is_debug_build() is false and the capture hooks silently do nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { doctor, godotDebugEngine } from "../src/doctor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, "fixtures", "scan", name);
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function touch(dir, ...names) {
  for (const n of names) {
    mkdirSync(dirname(join(dir, n)), { recursive: true });
    writeFileSync(join(dir, n), "x");
  }
}

test("doctor (Godot): a release-only engine fails with how to get a debug one", () => {
  const eng = tmp("gdx-eng-");
  touch(eng, "lib/libgodot.ios.template_release.arm64.simulator.a");
  const c = godotDebugEngine({ platform: "ios" }, { dirs: [eng], version: "4.7.2.stable" });
  assert.equal(c.ok, false);
  assert.match(c.detail, /only a release engine/);
  assert.match(c.detail, /OS\.is_debug_build\(\) is false/);
  assert.match(c.fix, /template_debug/);
  assert.match(c.fix, /--export-debug/);
});

test("doctor (Godot): a debug engine, the official templates, or nothing at all", () => {
  const dbg = tmp("gdx-eng-");
  touch(dbg, "lib/libgodot.ios.template_release.arm64.simulator.a", "lib/libgodot.ios.template_debug.arm64.simulator.a");
  assert.equal(godotDebugEngine({ platform: "ios" }, { dirs: [dbg] }).ok, true);

  const official = tmp("gdx-eng-");
  touch(official, "ios.zip", "android_debug.apk", "android_release.apk");
  assert.equal(godotDebugEngine({ platform: "ios" }, { dirs: [official] }).ok, true);
  assert.equal(godotDebugEngine({ platform: "android" }, { dirs: [official] }).ok, true);

  // Android files do not vouch for iOS, and a release-only Android apk is caught.
  const androidOnly = tmp("gdx-eng-");
  touch(androidOnly, "android_release.apk");
  assert.equal(godotDebugEngine({ platform: "android" }, { dirs: [androidOnly] }).ok, false);
  assert.equal(godotDebugEngine({ platform: "ios" }, { dirs: [androidOnly] }).ok, null, "no iOS engine found: unknown, not a pass");

  const none = godotDebugEngine({ platform: "ios" }, { dirs: [tmp("gdx-eng-")], version: "4.7.2.stable" });
  assert.equal(none.ok, null);
  assert.match(none.fix, /Manage Export Templates/);
});

test("doctor runs the Godot engine check for a Godot repo or --engine-dir, not for other engines", () => {
  const eng = tmp("gdx-eng-");
  touch(eng, "libgodot.android.template_release.a");
  const names = (o) => doctor({ platform: "android", ...o }).checks.map((c) => c.check);
  const label = "Godot debug engine (OS.is_debug_build() true)";
  // --engine-dir is checked alone: official templates installed on this machine do not rescue a release-only custom engine.
  const withDir = doctor({ platform: "android", engineDir: eng }).checks.find((c) => c.check === label);
  assert.equal(withDir?.ok, false);
  assert.ok(names({ src: fx("godot") }).includes(label));
  assert.ok(!names({ src: fx("swift") }).includes(label));
  assert.ok(!names({}).includes(label));
});
