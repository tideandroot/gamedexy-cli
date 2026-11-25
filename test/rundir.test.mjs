// Capture runs go to a durable folder by default, are never silently left in a temp dir, and map capture makes shots/.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { captureAll } from "../src/map.mjs";
import { defaultRunDir, runsRoot, temporaryWarning } from "../src/rundir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test("the default run folder is under ~/.gamedexy/runs/<game>/<timestamp>, never a temp dir", () => {
  const d = defaultRunDir("Rattle Pop!", new Date("2026-11-24T22:44:05.123Z"));
  assert.equal(d, join(homedir(), ".gamedexy", "runs", "rattle-pop", "20261124-224405"));
  assert.ok(d.startsWith(runsRoot()));
  assert.equal(temporaryWarning(d), null);
  assert.match(defaultRunDir(undefined), /runs[\\/]game[\\/]\d{8}-\d{6}$/);
  assert.match(defaultRunDir("com.example.app"), /runs[\\/]comexampleapp[\\/]/);
});

test("a temp or scratchpad folder is warned about; a home folder is not", () => {
  assert.match(temporaryWarning(join(tmpdir(), "run1")), /temporary location/);
  assert.match(temporaryWarning("/private/tmp/claude-501/x/scratchpad/run"), /temporary location/);
  assert.match(temporaryWarning("/tmp/x"), /temporary location/);
  assert.equal(temporaryWarning(join(homedir(), "Documents", "run")), null);
});

test("map start with no --dir or --out picks the durable default and prints where (checked up to the device step)", () => {
  // No simulator here, so start stops at the device check; the folder it chose is in the error path only if it got that far.
  // What can be proven without a device: the CLI accepts a missing --dir for `map start` (other map commands still demand it).
  const bin = join(here, "..", "bin", "gamedexy.mjs");
  const start = spawnSync(process.execPath, [bin, "map", "start", "--platform", "ios", "--app-id", "com.example.g", "--device", "nope"], { encoding: "utf8", env: { ...process.env, HOME: tmp("gdx-home-"), USERPROFILE: tmp("gdx-home-") } });
  assert.doesNotMatch(start.stdout, /--dir is required/);
  const shot = spawnSync(process.execPath, [bin, "map", "shot"], { encoding: "utf8" });
  assert.match(shot.stdout, /--dir is required/);
});

test("map capture makes the run's shots/ folder when it is missing and reports run_dir", async () => {
  const dir = tmp("gdx-shots-");
  writeFileSync(join(dir, "run.json"), JSON.stringify({ platform: "ios", launches: [] }));
  const scanFile = join(dir, "scan.json");
  writeFileSync(scanFile, JSON.stringify({ checklist: [{ key: "home", category: "home", open: "screen=home" }], edges: [], screens: [] }));
  assert.ok(!existsSync(join(dir, "shots")));
  const steps = [];
  const io = {
    launch: async () => {},
    settle: async () => {},
    shot: async (o) => {
      // The real shot() writes into shots/: it must exist by now.
      assert.ok(existsSync(join(dir, "shots")), "shots/ exists before the first screenshot");
      const n = steps.length + 1;
      steps.push(n);
      writeFileSync(join(dir, "steps.jsonl"), steps.map((s) => JSON.stringify({ step: s, phash: String(s).repeat(16).slice(0, 16), text: `t${s}`, action: o.action })).join("\n") + "\n");
      return { step: n, app_running: true };
    },
  };
  const r = await captureAll({ dir, scan: scanFile, all: true, io });
  assert.equal(r.run_dir, dir);
  assert.ok(existsSync(join(dir, "shots")));
  rmSync(dir, { recursive: true, force: true });
});
