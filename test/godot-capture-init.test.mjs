// Fixes 2, 3, 6, 7 (Rattlepop run), capture init and scan side: the autoload goes into project.godot,
// guessed openers are marked, the seed snippet compiles under --script, dead classes stay off the checklist.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { captureInit, wireGodotAutoload } from "../src/capture.mjs";
import { exportFilterState, wireExportPresets } from "../src/gamedexy-dir.mjs";
import { scan } from "../src/scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, "fixtures", "scan", name);
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
const LINE = 'GamedexyCapture="*res://gamedexy_stub.gd"';

// ---- 2. capture init adds the autoload ------------------------------------------------------

function godotRepo() {
  const repo = tmp("gdx-godot-");
  cpSync(fx("godot_code"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "gamedexy/capture");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  return repo;
}

test("capture init adds the autoload line to project.godot once, and shows the diff", () => {
  const repo = godotRepo();
  const before = readFileSync(join(repo, "project.godot"), "utf8");
  assert.ok(!before.includes("[autoload]"));
  const r = captureInit({ src: repo });
  assert.equal(r.autoload.status, "added");
  assert.ok(r.autoload.diff.some((l) => l === `+${LINE}`), JSON.stringify(r.autoload));
  const after = readFileSync(join(repo, "project.godot"), "utf8");
  assert.ok(after.startsWith(before.trimEnd()), "the old content is untouched");
  // Windows checkouts can give the fixture CRLF; the CLI keeps it, so compare with LF.
  assert.ok(after.replace(/\r\n/g, "\n").includes(`[autoload]\n\n${LINE}\n`), after);
  // Idempotent: a forced second run changes nothing in project.godot.
  const again = captureInit({ src: repo, force: true });
  assert.equal(again.autoload.status, "already_wired");
  assert.equal(readFileSync(join(repo, "project.godot"), "utf8"), after);
});

test("capture init --dry-run does not touch project.godot but says what it would add", () => {
  const repo = godotRepo();
  const before = readFileSync(join(repo, "project.godot"), "utf8");
  const d = captureInit({ src: repo, dryRun: true });
  assert.equal(d.autoload.status, "would_add");
  assert.equal(readFileSync(join(repo, "project.godot"), "utf8"), before);
  assert.ok(!existsSync(join(repo, "gamedexy_capture.gd")));
  assert.ok(!existsSync(join(repo, "gamedexy", "capture.gd")), "a dry run writes nothing");
});

test("autoload wiring: joins an existing [autoload] section, keeps CRLF, never edits a conflicting line", () => {
  const dir = tmp("gdx-wire-");
  const file = join(dir, "project.godot");
  writeFileSync(file, 'config_version=5\n\n[application]\nconfig/name="X"\n\n[autoload]\n\nGame="*res://game.gd"\n\n[display]\n\nwindow/size/viewport_width=720\n');
  assert.equal(wireGodotAutoload(dir, LINE).status, "added");
  assert.equal(readFileSync(file, "utf8"), 'config_version=5\n\n[application]\nconfig/name="X"\n\n[autoload]\n\nGame="*res://game.gd"\n' + LINE + '\n\n[display]\n\nwindow/size/viewport_width=720\n');
  assert.equal(wireGodotAutoload(dir, LINE).status, "already_wired");

  writeFileSync(file, 'config_version=5\r\n\r\n[autoload]\r\n\r\nGame="*res://game.gd"\r\n');
  assert.equal(wireGodotAutoload(dir, LINE, { dryRun: true }).status, "would_add");
  assert.equal(wireGodotAutoload(dir, LINE).status, "added");
  const crlf = readFileSync(file, "utf8");
  assert.ok(crlf.includes(`${LINE}\r\n`) && !/[^\r]\n/.test(crlf), "line endings stay CRLF");

  const other = 'GamedexyCapture="*res://elsewhere.gd"';
  writeFileSync(file, `config_version=5\n\n[autoload]\n\n${other}\n`);
  const c = wireGodotAutoload(dir, LINE);
  assert.equal(c.status, "conflict");
  assert.equal(readFileSync(file, "utf8"), `config_version=5\n\n[autoload]\n\n${other}\n`);

  assert.equal(wireGodotAutoload(tmp("gdx-none-"), LINE).status, "not_found");
});

// ---- 3. guessed placeholder openers (capture list side) ------------------------------------

test("a guessed opener is flagged in the capture list and the plan", () => {
  const d = captureInit({ src: fx("godot_code"), dryRun: true });
  const guessed = d.screens.filter((s) => s.guessed_args);
  assert.ok(guessed.length > 0, "the fixture has openers with guessed arguments");
  for (const g of guessed) {
    assert.match(g.wire, /GUESSED arguments/);
    const line = d.content.split("\n").find((l) => l.startsWith(`\t"${g.key}":`));
    assert.match(line, /# GUESSED arguments/, g.key);
  }
  // Sure openers carry no such comment.
  assert.ok(!d.content.split("\n").filter((l) => l.startsWith('\t"shop_sheets_upgrades":')).some((l) => l.includes("GUESSED")));
});

// ---- 6. seed snippet ------------------------------------------------------------------------

test("the seed and scene-screen snippets look the autoload up by name, so --script tests compile", () => {
  const c = captureInit({ src: fx("godot_code"), dryRun: true }).content;
  const md = readFileSync(join(here, "..", "skill", "ENGINES.md"), "utf8");
  for (const [name, text] of [["capture file", c], ["ENGINES.md", md]]) {
    assert.ok(text.includes('get_node_or_null("/root/GamedexyCapture")'), name);
    // No line of code may call the autoload by its bare identifier.
    const bare = text.split("\n").filter((l) => /^\s*(##\s*)?(var|if|match)\b.*(^|[^\w/"])GamedexyCapture\.(seed_value|take_screen|value)\(/.test(l));
    assert.deepEqual(bare, [], name);
  }
});

// ---- 7. left-out checklist ------------------------------------------------------------------

test("the scan leaves classes nothing creates off the checklist, says how many, and --include-dead brings them back", () => {
  const out = tmp("gdx-left-");
  const r = scan({ src: fx("godot_code_negative"), out });
  assert.equal(r.left_out, 4);
  assert.match(r.left_out_why, /4 screens left off the capture checklist/);
  const sc = JSON.parse(readFileSync(r.scan, "utf8"));
  assert.ok(!sc.checklist.some((c) => c.code?.live === false));
  assert.deepEqual(sc.checklist_left_out.map((x) => x.key).sort(), ["arena", "dead_hub_celebration", "dead_hub_play", "dead_hub_shop"]);
  assert.ok(sc.screens.some((s) => s.key === "arena"), "still a screen in the scan");
  assert.equal(r.to_capture, sc.checklist.length);

  const all = scan({ src: fx("godot_code_negative"), out: tmp("gdx-left-"), includeDead: true });
  assert.equal(all.left_out, undefined);
  assert.equal(all.to_capture, r.to_capture + 4);
  assert.equal(JSON.parse(readFileSync(all.scan, "utf8")).checklist_left_out, undefined);
});

test("scan output has no new keys for engines and projects with nothing left out", () => {
  for (const e of ["swift", "kotlin", "unity", "godot", "godot_code_collision"]) {
    const sc = JSON.parse(readFileSync(scan({ src: fx(e), out: tmp("gdx-same-") }).scan, "utf8"));
    assert.equal(sc.checklist_left_out, undefined, e);
  }
});

test("the scan keeps live classes made by an autoload, a var preload alias, an inline preload or load().new()", () => {
  const sc = JSON.parse(readFileSync(scan({ src: fx("godot_code_live"), out: tmp("gdx-live-") }).scan, "utf8"));
  assert.deepEqual(sc.checklist.map((c) => c.key).sort(), ["levels", "pause", "queued", "shop", "toast"]);
  assert.ok(sc.checklist.every((c) => c.code?.live !== false), "none of them is marked dead");
  // Only what nothing in the project names (class or res:// path) is dead code.
  assert.deepEqual((sc.checklist_left_out ?? []).map((x) => x.key), ["dead"]);
  // Autoload, var alias and inline/load makers count as creating it; a class only named by its res:// path stays on the list too.
  const by = (k) => sc.checklist.find((c) => c.key === k);
  for (const k of ["toast", "shop", "pause", "levels", "queued"]) assert.ok(by(k).code, `${k} keeps its code entry`);
});

// ---- the gamedexy/ dev folder (JT decision 2026-11-24) ------------------------------------------

const PRESETS = `[preset.0]

name="iOS"
platform="iOS"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter="tests/*,screenshots/*"
export_path="build/ios/Game.xcodeproj"
script_export_mode=2

[preset.0.options]

application/bundle_identifier="com.example.game"

[preset.1]

name="Android"
platform="Android"
runnable=true
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path="build/android/game.apk"

[preset.1.options]

package/unique_name="com.example.game"
`;

test("capture init (Godot) puts the capture code in gamedexy/ and a tiny stub autoload outside it", () => {
  const repo = godotRepo();
  const r = captureInit({ src: repo });
  assert.equal(r.written, "gamedexy/capture.gd");
  assert.equal(r.stub, "gamedexy_stub.gd");
  assert.ok(existsSync(join(repo, "gamedexy", "capture.gd")));
  assert.ok(!existsSync(join(repo, "gamedexy_capture.gd")), "nothing capture-related at the repo root but the stub");
  const stub = readFileSync(join(repo, "gamedexy_stub.gd"), "utf8");
  assert.match(stub, /OS\.is_debug_build\(\)/);
  assert.match(stub, /ResourceLoader\.exists\(REAL\)/);
  assert.ok(!stub.includes("gdxState") && !stub.includes("OPENERS"), "the stub holds no capture code");
  assert.ok(readFileSync(join(repo, "project.godot"), "utf8").includes(LINE));
  // The stub swaps itself for the real script (so every property and method is reached), and answers the four calls in release.
  assert.match(stub, /set_script\(script\)/);
  assert.ok(!/_real/.test(stub), "no forwarding through a child node: that hid properties such as values");
  const real = readFileSync(join(repo, "gamedexy", "capture.gd"), "utf8");
  for (const fn of ["take_screen", "value", "open_screen", "seed_value"]) {
    assert.match(real, new RegExp(`func ${fn}\\(`));
    assert.match(stub, new RegExp(`func ${fn}\\(`));
  }
  assert.match(real, /^var values := \{\}/m);
  // Second run: nothing more changes.
  const again = captureInit({ src: repo, force: true });
  assert.equal(again.autoload.status, "already_wired");
  assert.equal(again.exports.status, "not_found"); // this fixture has no export_presets.cfg
});

test("export presets: gamedexy/* is added to every exclude_filter, existing filters kept, idempotent, with a capture copy", () => {
  const repo = godotRepo();
  writeFileSync(join(repo, "export_presets.cfg"), PRESETS);
  const before = readFileSync(join(repo, "export_presets.cfg"), "utf8");
  const d = wireExportPresets(repo, { dryRun: true });
  assert.equal(d.status, "would_change");
  assert.equal(readFileSync(join(repo, "export_presets.cfg"), "utf8"), before, "dry run writes nothing");
  assert.ok(d.diff.includes('-exclude_filter="tests/*,screenshots/*"'));
  assert.ok(d.diff.includes('+exclude_filter="tests/*,screenshots/*,gamedexy/*"'));
  assert.ok(d.diff.includes('+exclude_filter="gamedexy/*"'));
  assert.deepEqual(d.capture_presets, ["iOS (Gamedexy capture)", "Android (Gamedexy capture)"]);

  const w = wireExportPresets(repo);
  assert.equal(w.status, "changed");
  const after = readFileSync(join(repo, "export_presets.cfg"), "utf8");
  assert.ok(after.includes('exclude_filter="tests/*,screenshots/*,gamedexy/*"'));
  assert.ok(after.includes('[preset.0.options]\n\napplication/bundle_identifier="com.example.game"'), "options untouched");
  // The copies: new numbers, not runnable, the folder kept in, their own output path, options carried over.
  assert.ok(after.includes('[preset.2]\n\nname="iOS (Gamedexy capture)"'));
  assert.ok(after.includes('runnable=false'));
  assert.ok(after.includes('export_path="build/gamedexy-capture/Game.xcodeproj"'));
  assert.ok(after.includes('[preset.2.options]\n\napplication/bundle_identifier="com.example.game"'));
  assert.ok(after.includes('[preset.3.options]\n\npackage/unique_name="com.example.game"'));
  const copy = after.slice(after.indexOf("[preset.2]"), after.indexOf("[preset.2.options]"));
  assert.ok(copy.includes('exclude_filter="tests/*,screenshots/*"'), "the copy keeps the other filters and drops gamedexy/*");
  assert.ok(!copy.includes("gamedexy/*"));
  // Idempotent.
  assert.equal(wireExportPresets(repo).status, "already_set");
  assert.equal(readFileSync(join(repo, "export_presets.cfg"), "utf8"), after);
  assert.deepEqual(exportFilterState(repo), { missing: [], stale: [], total: 2 });
});

test("export presets: a preset without an exclude_filter line gets one; CRLF stays CRLF", () => {
  const repo = tmp("gdx-presets-");
  writeFileSync(join(repo, "export_presets.cfg"), '[preset.0]\r\n\r\nname="Web"\r\nplatform="Web"\r\ninclude_filter=""\r\nexport_path=""\r\n\r\n[preset.0.options]\r\n\r\nx=1\r\n');
  assert.deepEqual(exportFilterState(repo), { missing: ["Web"], stale: [], total: 1 });
  wireExportPresets(repo);
  const out = readFileSync(join(repo, "export_presets.cfg"), "utf8");
  assert.ok(out.includes('include_filter=""\r\nexclude_filter="gamedexy/*"\r\nexport_path=""'));
  assert.ok(!/[^\r]\n/.test(out), "line endings stay CRLF");
});

test("capture init wires exports and .gdignore for screenshot folders; a dry run lists them without writing", () => {
  const repo = godotRepo();
  writeFileSync(join(repo, "export_presets.cfg"), PRESETS);
  mkdirSync(join(repo, "screenshots"));
  writeFileSync(join(repo, "screenshots", "a.png"), "x");
  mkdirSync(join(repo, "tools", "shots"), { recursive: true });
  const d = captureInit({ src: repo, dryRun: true });
  assert.deepEqual(d.gdignore.added, ["screenshots/.gdignore", "tools/shots/.gdignore"]);
  assert.equal(d.exports.status, "would_change");
  assert.ok(!existsSync(join(repo, "screenshots", ".gdignore")));
  const w = captureInit({ src: repo });
  assert.equal(w.exports.status, "changed");
  assert.ok(existsSync(join(repo, "screenshots", ".gdignore")) && existsSync(join(repo, "tools", "shots", ".gdignore")));
  assert.equal(captureInit({ src: repo, force: true }).gdignore.status, "already_set");
});

test("capture init migrates an older root-level capture file into gamedexy/ unchanged and moves the autoload to the stub", () => {
  const repo = godotRepo();
  const old = "extends Node\n# hand-wired OPENERS live here\nconst OPENERS := {}\n";
  writeFileSync(join(repo, "gamedexy_capture.gd"), old);
  writeFileSync(join(repo, "gamedexy_capture.gd.uid"), "uid://abc\n");
  writeFileSync(join(repo, "project.godot"), readFileSync(join(repo, "project.godot"), "utf8") + '\n[autoload]\n\nGamedexyCapture="*res://gamedexy_capture.gd"\n');
  const d = captureInit({ src: repo, dryRun: true });
  assert.deepEqual(d.migrate.from, "gamedexy_capture.gd");
  assert.equal(d.autoload.status, "would_replace");
  assert.deepEqual(d.autoload.diff.slice(1), ['-GamedexyCapture="*res://gamedexy_capture.gd"', `+${LINE}`]);
  assert.ok(existsSync(join(repo, "gamedexy_capture.gd")), "dry run moves nothing");
  assert.ok(!d.already_reads_gdxState, "our own old file is not 'already reads gdxState'");
  const w = captureInit({ src: repo });
  assert.equal(readFileSync(join(repo, "gamedexy", "capture.gd"), "utf8"), old, "contents unchanged");
  assert.ok(existsSync(join(repo, "gamedexy", "capture.gd.uid")));
  assert.ok(!existsSync(join(repo, "gamedexy_capture.gd")));
  assert.equal(w.autoload.status, "replaced");
  const proj = readFileSync(join(repo, "project.godot"), "utf8");
  assert.ok(proj.includes(LINE) && !proj.includes("gamedexy_capture.gd"));
});

test("the scan never reads Gamedexy's own folder or stub as the game", () => {
  const repo = godotRepo();
  captureInit({ src: repo });
  const out = tmp("gdx-scan-own-");
  const sc = JSON.parse(readFileSync(scan({ src: repo, out }).scan, "utf8"));
  assert.ok(!JSON.stringify(sc).includes("gamedexy/capture.gd"));
  assert.ok(!JSON.stringify(sc).includes("gamedexy_stub.gd"));
});

test("only iOS and Android presets get a capture copy; other platforms just get the filter", () => {
  const repo = tmp("gdx-copy-plat-");
  writeFileSync(join(repo, "export_presets.cfg"), '[preset.0]\n\nname="Web"\nplatform="Web"\nexclude_filter=""\n\n[preset.1]\n\nname="Pixel"\nplatform="Android"\nexclude_filter=""\nexport_path="build/p.apk"\n\n[preset.1.options]\n\na=1\n');
  const w = wireExportPresets(repo);
  assert.deepEqual(w.capture_presets, ["Pixel (Gamedexy capture)"]);
  const text = readFileSync(join(repo, "export_presets.cfg"), "utf8");
  assert.ok(!text.includes("Web (Gamedexy capture)"));
  assert.ok(text.includes('name="Web"\nplatform="Web"\nexclude_filter="gamedexy/*"'));
});

test("re-running capture init refreshes a stale capture copy from its original; doctor flags it until then", () => {
  const repo = godotRepo();
  writeFileSync(join(repo, "export_presets.cfg"), PRESETS);
  wireExportPresets(repo);
  assert.equal(wireExportPresets(repo).status, "already_set");
  // The original changes: a new filter, a new option, a new output path.
  const cfg = readFileSync(join(repo, "export_presets.cfg"), "utf8")
    .replace('exclude_filter="tests/*,screenshots/*,gamedexy/*"', 'exclude_filter="tests/*,screenshots/*,docs/*,gamedexy/*"')
    .replace('application/bundle_identifier="com.example.game"\n\n[preset.1]', 'application/bundle_identifier="com.example.game"\napplication/version="7"\n\n[preset.1]')
    .replace('export_path="build/ios/Game.xcodeproj"\nscript_export_mode=2\n\n[preset.0.options]', 'export_path="build/ios/Renamed.xcodeproj"\nscript_export_mode=2\n\n[preset.0.options]');
  writeFileSync(join(repo, "export_presets.cfg"), cfg);
  assert.deepEqual(exportFilterState(repo).stale, ["iOS (Gamedexy capture)"]);
  const d = wireExportPresets(repo, { dryRun: true });
  assert.deepEqual(d.refreshed, ["iOS (Gamedexy capture)"]);
  assert.ok(d.diff.some((l) => l === '+exclude_filter="tests/*,screenshots/*,docs/*"'), d.diff.join("\n"));
  const w = wireExportPresets(repo);
  assert.equal(w.status, "changed");
  const after = readFileSync(join(repo, "export_presets.cfg"), "utf8");
  const copy = after.slice(after.indexOf('[preset.2]'), after.indexOf('[preset.3]'));
  assert.ok(copy.includes('exclude_filter="tests/*,screenshots/*,docs/*"') && !copy.includes("gamedexy/*"));
  assert.ok(copy.includes('application/version="7"'));
  assert.ok(copy.includes('export_path="build/gamedexy-capture/Renamed.xcodeproj"'));
  assert.ok(copy.includes('name="iOS (Gamedexy capture)"') && copy.includes("runnable=false"));
  assert.equal((after.match(/\[preset\.\d+\]/g) ?? []).length, 4, "no duplicate copies");
  assert.equal(wireExportPresets(repo).status, "already_set");
  assert.deepEqual(exportFilterState(repo).stale, []);
});

test("migrating warns about every use of the old autoload that the release stub does not answer", () => {
  const repo = godotRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "log.gd"),
    'class_name Log\nstatic func on() -> bool:\n\tvar cap: Node = (Engine.get_main_loop() as SceneTree).root.get_node_or_null("GamedexyCapture")\n\tvar vals = cap.get("values")\n\tcap.extra_fn()\n\tvar s = cap.take_screen()  # fine\n\treturn GamedexyCapture.mode == 1\n',
  );
  const d = captureInit({ src: repo, dryRun: true });
  assert.deepEqual(d.autoload_uses_outside_stub.map((u) => [u.file, u.line, u.member]), [["src/log.gd", 4, "values"], ["src/log.gd", 5, "extra_fn"], ["src/log.gd", 7, "mode"]]);
  assert.match(d.autoload_uses_warning, /values, extra_fn, mode/);
  assert.match(d.autoload_uses_warning, /null check/);
  // Nothing to warn about when the game only uses the four calls.
  assert.equal(captureInit({ src: godotRepo(), dryRun: true }).autoload_uses_outside_stub, undefined);
});

// A real Godot probe (skipped when no Godot is installed): after capture init, the autoload must still expose
// `values` and the game's own helper must stay active, exactly as before the file moved into gamedexy/.
const GODOT = (() => {
  for (const b of [process.env.GODOT, "godot", "/opt/homebrew/bin/godot", "/Applications/Godot.app/Contents/MacOS/Godot"].filter(Boolean)) {
    try {
      execFileSync(b, ["--version"], { stdio: "ignore" });
      return b;
    } catch {
      /* next */
    }
  }
  return null;
})();

test("Godot probe: the autoload keeps its properties after the move (values, log_active), and is empty without the folder", { skip: GODOT ? false : "no Godot installed" }, () => {
  const repo = tmp("gdx-probe-");
  git(repo, "init", "-q", "-b", "gamedexy/capture");
  writeFileSync(join(repo, "project.godot"), 'config_version=5\n\n[application]\nconfig/name="Probe"\nrun/main_scene="res://probe.tscn"\n');
  writeFileSync(join(repo, "probe.tscn"), '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://probe.gd" id="1"]\n\n[node name="Probe" type="Node"]\nscript = ExtResource("1")\n');
  // Like Rattlepop's capture_log.gd: reads a property of the autoload with get("values").
  writeFileSync(join(repo, "probe.gd"), 'extends Node\nfunc _active() -> bool:\n\tvar cap = get_node_or_null("/root/GamedexyCapture")\n\tif cap == null:\n\t\treturn false\n\tvar vals = cap.get("values")\n\treturn vals is Dictionary and not (vals as Dictionary).is_empty()\nfunc _ready() -> void:\n\tvar cap = get_node_or_null("/root/GamedexyCapture")\n\tprint("PROBE values=", cap.get("values") if cap != null else "<none>", " log_active=", _active(), " seed=", cap.seed_value() if cap != null else "-")\n\tget_tree().quit()\n');
  // The older setup: the capture file at the repo root, registered as the autoload.
  const before = captureInit({ src: repo, dryRun: true, engine: "godot" });
  assert.ok(before.content);
  writeFileSync(join(repo, "gamedexy_capture.gd"), before.content);
  writeFileSync(join(repo, "project.godot"), readFileSync(join(repo, "project.godot"), "utf8") + '\n[autoload]\n\nGamedexyCapture="*res://gamedexy_capture.gd"\n');
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x");
  const run = () => execFileSync(GODOT, ["--headless", "--path", repo, "--", "-gdxState", "screen=world,seed=7"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").find((l) => l.startsWith("PROBE")) ?? "";
  execFileSync(GODOT, ["--headless", "--path", repo, "--import"], { stdio: "ignore" });
  const was = run();
  assert.match(was, /values=\{ ?"screen": "world", "seed": "7" ?\} log_active=true seed=7/, was);
  captureInit({ src: repo, engine: "godot" }); // migrates into gamedexy/ and swaps in the stub
  assert.ok(existsSync(join(repo, "gamedexy", "capture.gd")) && !existsSync(join(repo, "gamedexy_capture.gd")));
  execFileSync(GODOT, ["--headless", "--path", repo, "--import"], { stdio: "ignore" });
  assert.equal(run(), was, "the same answers before and after the move");
  // What a release export looks like: the folder is not there.
  renameSync(join(repo, "gamedexy"), join(repo, "gamedexy_off"));
  assert.match(run(), /values=<null> log_active=false seed=-1/);
});

// ---- re-running capture init (review round 2) -----------------------------------------------------------------

const cfgOf = (repo) => readFileSync(join(repo, "export_presets.cfg"), "utf8");

test("re-run with a stale capture copy: capture.gd is kept untouched, the copy is refreshed, exit is clean; dry run says the same", () => {
  const repo = godotRepo();
  writeFileSync(join(repo, "export_presets.cfg"), PRESETS);
  captureInit({ src: repo });
  // The developer wired the capture file by hand.
  const capture = join(repo, "gamedexy", "capture.gd");
  const wired = readFileSync(capture, "utf8") + '\n# hand-wired opener\nconst MINE := {"shop": {"path": "res://x.gd"}}\n';
  writeFileSync(capture, wired);
  // The original preset changes: the capture copy is now stale.
  writeFileSync(join(repo, "export_presets.cfg"), cfgOf(repo).replace('application/bundle_identifier="com.example.game"\n\n[preset.1]', 'application/bundle_identifier="com.example.game"\napplication/short_version="9.9.9"\n\n[preset.1]'));
  assert.deepEqual(exportFilterState(repo).stale, ["iOS (Gamedexy capture)"]);

  const dry = captureInit({ src: repo, dryRun: true });
  assert.match(dry.capture_file, /^would be kept/);
  assert.deepEqual(dry.exports.refreshed, ["iOS (Gamedexy capture)"]);
  assert.equal(readFileSync(capture, "utf8"), wired, "dry run changes nothing");

  const real = captureInit({ src: repo }); // no --force: must not throw
  assert.equal(real.capture_file, "kept");
  assert.equal(real.kept, "gamedexy/capture.gd");
  assert.equal(real.written, undefined);
  assert.deepEqual(real.exports.refreshed, dry.exports.refreshed, "dry run and real run report the same refresh");
  assert.match(real.summary, /Kept gamedexy\/capture\.gd as it is/);
  assert.match(real.summary, /refreshed iOS \(Gamedexy capture\)/);
  assert.equal(readFileSync(capture, "utf8"), wired, "the hand-wired capture file is untouched");
  assert.ok(cfgOf(repo).includes('[preset.2.options]\n\napplication/bundle_identifier="com.example.game"\napplication/short_version="9.9.9"'), "the copy's options follow the original");
  assert.deepEqual(exportFilterState(repo).stale, []);
});

test("re-run with nothing to change is idempotent and says so; --force rewrites the capture file", () => {
  const repo = godotRepo();
  writeFileSync(join(repo, "export_presets.cfg"), PRESETS);
  captureInit({ src: repo });
  const capture = join(repo, "gamedexy", "capture.gd");
  const cfg = cfgOf(repo);
  const proj = readFileSync(join(repo, "project.godot"), "utf8");
  writeFileSync(capture, "extends Node\n# hand-wired\n");
  const again = captureInit({ src: repo });
  assert.equal(again.capture_file, "kept");
  assert.match(again.summary, /Everything else was already up to date/);
  assert.equal(again.exports.status, "already_set");
  assert.equal(again.autoload.status, "already_wired");
  assert.equal(readFileSync(capture, "utf8"), "extends Node\n# hand-wired\n");
  assert.equal(cfgOf(repo), cfg);
  assert.equal(readFileSync(join(repo, "project.godot"), "utf8"), proj);
  // --force: a fresh capture file, the wiring is gone, the other steps still idempotent.
  const forced = captureInit({ src: repo, force: true });
  assert.equal(forced.capture_file, "overwritten");
  assert.equal(forced.written, "gamedexy/capture.gd");
  assert.ok(readFileSync(capture, "utf8").includes("const OPENERS"));
  assert.ok(!readFileSync(capture, "utf8").includes("hand-wired"));
  assert.equal(forced.exports.status, "already_set");
  assert.equal(cfgOf(repo), cfg);
});

test("re-run still repairs a missing stub or autoload line and refuses on a shared branch, with the capture file kept", () => {
  const repo = godotRepo();
  captureInit({ src: repo });
  rmSync(join(repo, "gamedexy_stub.gd"));
  writeFileSync(join(repo, "project.godot"), readFileSync(join(repo, "project.godot"), "utf8").replace(LINE, ""));
  const r = captureInit({ src: repo });
  assert.equal(r.capture_file, "kept");
  assert.equal(r.autoload.status, "added");
  assert.ok(existsSync(join(repo, "gamedexy_stub.gd")));
  git(repo, "switch", "-q", "-c", "main2");
  git(repo, "branch", "-m", "main");
  assert.throws(() => captureInit({ src: repo }), /never the main one/);
});

test("autoloadUses leaves Node and Object built-ins out (get_script, name, queue_free) but still names real uses", () => {
  const repo = godotRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "x.gd"), 'extends Node\nfunc f():\n\tvar cap = get_node_or_null("/root/GamedexyCapture")\n\tcap.get_script()\n\tcap.name\n\tcap.queue_free()\n\tcap.is_inside_tree()\n\tcap.get("name")\n\tcap.mode\n');
  const d = captureInit({ src: repo, dryRun: true });
  assert.deepEqual(d.autoload_uses_outside_stub.map((u) => u.member), ["mode"]);
});
