// gamedexy capture init: write the debug-only capture list into the developer's game repo
// (Slice 26 Part G, PR 2, D-102). The file reads the same `-gdxState` launch argument as every
// Gamedexy debug state, so `gamedexy doctor --release-app` already proves it is not in Release.
// It only parses the argument and lists the screen keys from the scan; the agent wires each key to
// the code that opens that screen (the scan says which), with the developer's yes, on its own branch.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { AUTOLOAD_LINE, CAPTURE_FILE, autoloadUses, LEGACY_AUTOLOAD_LINE, LEGACY_CAPTURE_FILE, STUB_FILE, addGdignore, stubFile, wireExportPresets } from "./gamedexy-dir.mjs";
import { scanRepo, walk } from "./scan.mjs";

const PROTECTED = /^(main|master|trunk|develop|dev|release.*|prod|production|stable)$/;

function branchOf(src) {
  try {
    return execFileSync("git", ["-C", src, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const rel = (src, p) => relative(src, p).split(sep).join("/");
const comment = (c) => `${c.key}${c.needs ? `  (opens with: ${c.needs}${c.from ? `, from ${c.from}` : ""})` : ""}`;

function swiftFile(cl) {
  const keys = cl.map((c) => `"${c.key}"`).join(", ");
  return `#if DEBUG
import Foundation

/// Gamedexy capture list (debug builds only; added by \`gamedexy capture init\` on its own branch).
/// Gamedexy launches the game with \`-gdxState screen=<key>\` and screenshots what opens, so Game Map
/// can capture every screen without playing. Nothing here is compiled into Release builds;
/// \`gamedexy doctor --release-app <Release .app>\` checks that.
///
/// Wire each key where that screen is opened (the scan's trigger is next to each key):
///
///     .onAppear {
///         #if DEBUG
///         switch GamedexyCapture.takeScreen() {
///         case "shop": sheet = .shop
///         default: break
///         }
///         #endif
///     }
///
${cl.map((c) => `///   ${comment(c)}`).join("\n")}
enum GamedexyCapture {
    static let screens: [String] = [${keys}]

    /// All key=value pairs passed with -gdxState (screen, stage, tab and any game values).
    static let values: [String: String] = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-gdxState"), i + 1 < args.count else { return [:] }
        return args[i + 1].split(separator: ",").reduce(into: [:]) { out, pair in
            let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).trimmingCharacters(in: .whitespaces) }
            guard kv.count == 2,
                  kv[0].range(of: #"^[A-Za-z][\\w-]{0,31}$"#, options: .regularExpression) != nil,
                  kv[1].range(of: #"^[\\w.:-]{1,64}$"#, options: .regularExpression) != nil else { return }
            out[kv[0]] = kv[1]
        }
    }()

    private static var taken = false
    /// The screen to open, once per launch (so closing it does not reopen it).
    static func takeScreen() -> String? {
        guard !taken, let s = values["screen"] else { return nil }
        taken = true
        return s
    }

    static func value(_ key: String) -> String? { values[key] }
    static func int(_ key: String) -> Int? { values[key].flatMap(Int.init) }
}
#endif
`;
}

function kotlinFile(cl, pkg) {
  return `${pkg ? `package ${pkg}\n\n` : ""}import android.content.Intent

/**
 * Gamedexy capture list (debug builds only; added by \`gamedexy capture init\` on its own branch).
 * Gamedexy launches the game with \`--es gdxState screen=<key>\` and screenshots what opens. Every use
 * is behind BuildConfig.DEBUG; \`gamedexy doctor --release-app <unzipped release apk>\` checks it.
 *
 * Call GamedexyCapture.read(intent) in onCreate, then open GamedexyCapture.takeScreen() where your
 * navigation starts (for example navController.navigate(it) after the NavHost is set up):
${cl.map((c) => ` *   ${comment(c)}`).join("\n")}
 */
object GamedexyCapture {
    val screens = listOf(${cl.map((c) => `"${c.key}"`).join(", ")})
    var values: Map<String, String> = emptyMap()
        private set
    private var taken = false

    fun read(intent: Intent?) {
        if (!BuildConfig.DEBUG) return
        val raw = intent?.getStringExtra("gdxState") ?: return
        values = raw.split(",").mapNotNull { pair ->
            val kv = pair.split("=", limit = 2).map { it.trim() }
            if (kv.size == 2 && Regex("^[A-Za-z][\\\\w-]{0,31}$").matches(kv[0]) && Regex("^[\\\\w.:-]{1,64}$").matches(kv[1])) kv[0] to kv[1] else null
        }.toMap()
    }

    fun takeScreen(): String? {
        if (!BuildConfig.DEBUG || taken) return null
        taken = true
        return values["screen"]
    }

    fun value(key: String): String? = if (BuildConfig.DEBUG) values[key] else null
}
`;
}

const gdLit = (v) => JSON.stringify(v);

/** One OPENERS line for a screen the scan found built in GDScript (see godot-code.mjs). */
function godotOpener(c) {
  const k = c.code;
  const parts = [`"path": ${gdLit(k.path)}`];
  if (k.call) parts.push(`"call": ${gdLit(k.call)}`, `"args": [${(k.args ?? []).join(", ")}]`);
  else if (k.set) parts.push(`"set": ${gdLit(k.set)}`, `"value": ${k.value}`);
  return `\t${gdLit(c.key)}: {${parts.join(", ")}},${k.guessed_args ? "  # GUESSED arguments: check them, or this opens the wrong thing (gamedexy map capture skips it unless --include-guessed)" : ""}`;
}

function godotFile(cl, seedValue = -1) {
  // A class nothing creates (live: false) is listed in SCREENS but gets no opener: a guessed call on it can crash the game.
  const built = cl.filter((c) => c.code && c.code.live !== false);
  return `extends Node
## Gamedexy capture list (debug builds only; added by \`gamedexy capture init\` on its own branch).
## This file lives in res://gamedexy/, which is left out of every export (gamedexy/* in each preset's
## exclude filter), so nothing here ships. The autoload named GamedexyCapture is the tiny stub
## res://gamedexy_stub.gd outside the folder: in a debug build that has this file it swaps its own script for
## this one (so every method and property here, such as values, is reached directly); in a release export
## it only answers take_screen(), value(), open_screen() and seed_value() with empty values.
## Gamedexy launches the game with \`-gdxState screen=<key>\` and screenshots what opens. Everything here
## returns early outside debug builds; \`gamedexy check-export <build>\` proves the folder is not in a build.
##
## Screens built in GDScript are opened for you from OPENERS below: the autoload waits a few
## frames, finds the node whose script is "path" (or makes one), then makes the call. A guessed
## call or argument is marked in the scan (guessed_args, sure=false): fix the line if it opens the
## wrong thing. Screens that come from scenes: open the capture screen where the game starts. Look the
## autoload up by name (get_node_or_null) so the game still compiles in --script tests and in builds
## without the autoload; the bare identifier GamedexyCapture does not:
##   var cap := get_node_or_null("/root/GamedexyCapture")
##   if cap != null:
##       match cap.take_screen():
##           "shop": $ShopPopup.popup_centered()
${cl.map((c) => `##   ${comment(c)}`).join("\n")}

const SCREENS := [${cl.map((c) => `"${c.key}"`).join(", ")}]
## Fixed seed for repeatable captures. -1 leaves randomness alone; \`-gdxState screen=<key>,seed=7\`
## overrides it for one launch. It seeds Godot's global generator (randi, randf, shuffle). A game that
## makes its own RandomNumberGenerator is not affected until it reads the seed itself:
##   var cap := get_node_or_null("/root/GamedexyCapture")   # null in --script tests and builds without it
##   if cap != null and cap.seed_value() >= 0: _rng.seed = cap.seed_value()   # also cap.value("seed")
const DEFAULT_SEED := ${seedValue}
const OPENERS := {
${built.map(godotOpener).join("\n")}
}
var values := {}
var _taken := false
var _warned_seed := false
var _launched := false

func _ready() -> void:
	if not OS.is_debug_build():
		return
	var args := OS.get_cmdline_args() + OS.get_cmdline_user_args()
	var i := args.find("-gdxState")
	if i < 0 or i + 1 >= args.size():
		return
	_launched = true
	for pair in String(args[i + 1]).split(","):
		var kv := pair.split("=", true, 1)
		if kv.size() == 2:
			values[kv[0].strip_edges()] = kv[1].strip_edges()
	if DEFAULT_SEED >= 0 and not values.has("seed"):
		values["seed"] = str(DEFAULT_SEED)
	_seed_rng()
	var key: String = values.get("screen", "")
	if OPENERS.has(key):
		_taken = true
		_open_when_ready.call_deferred(key)

func take_screen() -> String:
	if not OS.is_debug_build() or _taken:
		return ""
	_taken = true
	return values.get("screen", "")

func value(key: String) -> String:
	return values.get(key, "") if OS.is_debug_build() else ""

func open_screen(key: String) -> bool:
	if not OS.is_debug_build() or not OPENERS.has(key):
		return false
	_seed_rng()
	var spec: Dictionary = OPENERS[key]
	var node := _find_by_script(get_tree().root, String(spec["path"]))
	if node == null:
		node = _spawn(String(spec["path"]))
	if node == null:
		push_warning("GamedexyCapture: cannot open '%s': %s could not be loaded or made" % [key, spec["path"]])
		return false
	var method := String(spec.get("call", ""))
	var args: Array = spec.get("args", [])
	if method != "" and not (node.has_method(method) and _args_fit(node, method, args)):
		push_warning("GamedexyCapture: cannot open '%s': %s() is missing or does not take these arguments" % [key, method])
		return false
	if node is CanvasItem:
		node.visible = true
	if method != "":
		node.callv(method, args)
	elif spec.has("set"):
		node.set(spec["set"], spec.get("value"))
	return true

## The fixed seed for this launch, or -1. Only a launch with -gdxState has one; a normal debug run gets -1.
## A bad value (seed=abc) is ignored with a warning.
func seed_value() -> int:
	if not OS.is_debug_build() or not _launched:
		return -1
	var raw := String(values.get("seed", ""))
	if raw == "":
		return DEFAULT_SEED
	if not raw.is_valid_int():
		if not _warned_seed:
			_warned_seed = true
			push_warning("GamedexyCapture: seed=%s is not a whole number; ignored" % raw)
		return DEFAULT_SEED
	return maxi(int(raw), -1)

func _seed_rng() -> void:
	var seed_val := seed_value()
	if seed_val >= 0:
		seed(seed_val)

## True when the method takes exactly these arguments (count and type), so a placeholder null for an
## object parameter is refused instead of crashing the game.
func _args_fit(node: Object, method: String, args: Array) -> bool:
	for info in node.get_method_list():
		if info["name"] != method:
			continue
		var params: Array = info["args"]
		var optional: int = info["default_args"].size()
		if args.size() > params.size() or args.size() < params.size() - optional:
			return false
		for i in args.size():
			var want: int = params[i]["type"]
			var got := typeof(args[i])
			if want == TYPE_NIL or got == want:
				continue
			if want == TYPE_FLOAT and got == TYPE_INT:
				continue
			if want == TYPE_STRING_NAME and got == TYPE_STRING:
				continue
			return false
		return true
	return false

func _open_when_ready(key: String) -> void:
	for _i in 3:
		await get_tree().process_frame
	open_screen(key)

func _find_by_script(n: Node, path: String) -> Node:
	var s = n.get_script()
	if s != null and s.resource_path == path:
		return n
	for c in n.get_children():
		var hit := _find_by_script(c, path)
		if hit != null:
			return hit
	return null

## True when the script (or one it extends) has an _init that needs arguments: new() would be a script error.
func _needs_init_args(script: Script) -> bool:
	var s := script
	while s != null:
		for info in s.get_script_method_list():
			if info["name"] == "_init":
				return info["args"].size() > info["default_args"].size()
		s = s.get_base_script()
	return false

func _spawn(path: String) -> Node:
	var script = load(path)
	if script == null or not script.can_instantiate():
		return null
	if _needs_init_args(script):
		return null
	var made = script.new()
	if not (made is Node):
		# A data class (Resource, RefCounted, Object): nothing to show.
		if made is Object and not (made is RefCounted):
			made.free()
		return null
	var node: Node = made
	var layer := CanvasLayer.new()
	layer.layer = 100
	get_tree().root.add_child(layer)
	layer.add_child(node)
	return node
`;
}

function unityFile(cl) {
  return `#if DEVELOPMENT_BUILD || UNITY_EDITOR
using System;
using System.Collections.Generic;
using UnityEngine;

/// Gamedexy capture list (development builds only; added by \`gamedexy capture init\` on its own branch).
/// Gamedexy launches the game with \`-gdxState screen=<key>\` (iOS arguments, Android intent extra
/// gdxState) and screenshots what opens. Compiled out of release builds;
/// \`gamedexy doctor --release-app <release build>\` checks the string is absent.
///
/// Open GamedexyCapture.TakeScreen() where your first scene starts, for example:
///   switch (GamedexyCapture.TakeScreen()) { case "shop": shopPanel.SetActive(true); break; }
${cl.map((c) => `///   ${comment(c)}`).join("\n")}
public static class GamedexyCapture
{
    public static readonly string[] Screens = { ${cl.map((c) => `"${c.key}"`).join(", ")} };
    static Dictionary<string, string> values;
    static bool taken;

    public static Dictionary<string, string> Values => values ??= Read();

    static Dictionary<string, string> Read()
    {
        var raw = "";
        try
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            using var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            using var activity = player.GetStatic<AndroidJavaObject>("currentActivity");
            using var intent = activity.Call<AndroidJavaObject>("getIntent");
            raw = intent.Call<string>("getStringExtra", "gdxState") ?? "";
#else
            var args = Environment.GetCommandLineArgs();
            var i = Array.IndexOf(args, "-gdxState");
            if (i >= 0 && i + 1 < args.Length) raw = args[i + 1];
#endif
        }
        catch (Exception) { }
        var d = new Dictionary<string, string>();
        foreach (var pair in raw.Split(','))
        {
            var kv = pair.Split(new[] { '=' }, 2);
            if (kv.Length == 2) d[kv[0].Trim()] = kv[1].Trim();
        }
        return d;
    }

    public static string TakeScreen()
    {
        if (taken) return null;
        taken = true;
        return Values.TryGetValue("screen", out var s) ? s : null;
    }

    public static string Value(string key) => Values.TryGetValue(key, out var v) ? v : null;
}
#endif
`;
}

/** Where the file goes: beside the app entry point for the engine. */
function target(src, engine, files) {
  const read = (f) => {
    try {
      return readFileSync(f.abs, "utf8");
    } catch {
      return "";
    }
  };
  if (engine === "swift") {
    const app = files.find((f) => f.ext === ".swift" && /@main\b/.test(read(f)));
    return { path: join(app ? dirname(app.abs) : src, "GamedexyCapture.swift") };
  }
  if (engine === "kotlin") {
    const main = files.find((f) => (f.ext === ".kt") && /:\s*(ComponentActivity|AppCompatActivity|Activity|FragmentActivity)\s*\(/.test(read(f)) && !/[\\/]test/.test(f.rel));
    const pkg = main ? read(main).match(/^\s*package\s+([\w.]+)/m)?.[1] ?? null : null;
    return { path: join(main ? dirname(main.abs) : src, "GamedexyCapture.kt"), pkg };
  }
  // Everything of Gamedexy's lives in gamedexy/ and never ships; the stub autoload outside it keeps release builds starting.
  if (engine === "godot") return { path: join(src, CAPTURE_FILE), stub: join(src, STUB_FILE), legacy: join(src, LEGACY_CAPTURE_FILE), autoload: AUTOLOAD_LINE };
  if (engine === "unity") return { path: join(src, "Assets", "Gamedexy", "GamedexyCapture.cs") };
  return null;
}

/**
 * Add the autoload line to project.godot, idempotently. Returns what happened without writing when
 * `dryRun`. An existing `GamedexyCapture=` line is never changed (a different path is reported as a
 * conflict). The branch is the backup (capture init refuses main), and the exact diff is returned.
 */
export function wireGodotAutoload(src, line, { dryRun = false, replace = [] } = {}) {
  const file = join(src, "project.godot");
  if (!existsSync(file)) return { file: "project.godot", status: "not_found", note: `No project.godot in ${src}. Add this under [autoload] by hand: ${line}` };
  const raw = readFileSync(file, "utf8");
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const name = line.slice(0, line.indexOf("="));
  const head = lines.findIndex((l) => l.trim() === "[autoload]");
  let end = lines.length;
  if (head >= 0) {
    const next = lines.findIndex((l, i) => i > head && /^\s*\[.+\]\s*$/.test(l));
    if (next >= 0) end = next;
    const have = lines.slice(head + 1, end).find((l) => l.startsWith(`${name}=`));
    if (have !== undefined && replace.includes(have.trim())) {
      // The old capture-init line (the file at the repo root) moves to the stub: swap it in place.
      const at = head + 1 + lines.slice(head + 1, end).indexOf(have);
      const out2 = [...lines];
      out2[at] = line;
      if (!dryRun) writeFileSync(file, out2.join(nl));
      return { file: "project.godot", status: dryRun ? "would_replace" : "replaced", diff: [`@@ project.godot [autoload] @@`, `-${have.trim()}`, `+${line}`] };
    }
    if (have !== undefined) {
      const same = have.trim() === line;
      return { file: "project.godot", status: same ? "already_wired" : "conflict", ...(same ? {} : { note: `project.godot already has ${have.trim()} (expected ${line}); left unchanged. Fix it by hand.` }) };
    }
  }
  let out;
  let diff;
  if (head >= 0) {
    // After the last key of the section, before its trailing blank lines.
    let at = end;
    while (at > head + 1 && lines[at - 1].trim() === "") at--;
    out = [...lines.slice(0, at), line, ...lines.slice(at)];
    diff = [`@@ project.godot [autoload] @@`, ...(at - 1 > head ? [` ${lines[at - 1]}`] : [` [autoload]`]), `+${line}`];
  } else {
    const body = raw.endsWith("\n") || raw === "" ? raw : raw + nl;
    out = null;
    diff = ["@@ project.godot (end) @@", "+[autoload]", "+", `+${line}`];
    if (!dryRun) writeFileSync(file, `${body}${nl}[autoload]${nl}${nl}${line}${nl}`);
    return { file: "project.godot", status: dryRun ? "would_add" : "added", diff };
  }
  if (!dryRun) writeFileSync(file, out.join(nl));
  return { file: "project.godot", status: dryRun ? "would_add" : "added", diff };
}

/**
 * Write the debug-only capture list into the repo. Refuses on main/master and other shared
 * branches: the developer makes a branch first (the agent asks them). `--dry-run` shows the file.
 */
export function captureInit(o) {
  const src = o.src;
  // --include-dead needs the source scanned again: a scan.json made without it has already dropped those keys.
  const r = o.scan && existsSync(o.scan) && !o.includeDead ? JSON.parse(readFileSync(o.scan, "utf8")) : scanRepo(src, { engine: o.engine, includeDead: o.includeDead });
  const cl = (r.checklist ?? []).filter((c) => !c.level);
  const lv = r.levels?.[0] ?? null;
  const files = walk(src);
  const t = target(src, r.engine, files);
  if (!t) throw new Error(`No capture template for engine "${r.engine}". Pass --engine swift|kotlin|godot|unity.`);
  const branch = branchOf(src);
  const existing = files.filter((f) => [".swift", ".kt", ".java", ".gd", ".cs"].includes(f.ext) && f.abs !== t.path && f.abs !== t.stub && f.abs !== t.legacy && !f.rel.startsWith("gamedexy/")).filter((f) => {
    try {
      return readFileSync(f.abs, "utf8").includes("gdxState");
    } catch {
      return false;
    }
  }).map((f) => f.rel);
  // Godot: the capture code goes in gamedexy/ (never exported). A capture file from an earlier capture init sits at the
  // repo root: its contents (the OPENERS you wired) move into the folder unchanged unless --force asks for a fresh one.
  const legacy = r.engine === "godot" && t.legacy && existsSync(t.legacy) ? t.legacy : null;
  const body = { swift: () => swiftFile(cl), kotlin: () => kotlinFile(cl, t.pkg), godot: () => godotFile(cl, Number.isInteger(o.seed) && o.seed >= 0 ? o.seed : -1), unity: () => unityFile(cl) }[r.engine]();
  const migrate = legacy && !o.force && !existsSync(t.path) ? { from: rel(src, legacy), to: rel(src, t.path), note: "moved, contents unchanged (your OPENERS stay); a .uid file moves with it" } : null;
  const godot = r.engine === "godot";
  const uses = godot ? autoloadUses(src) : [];
  // Godot, capture file already in gamedexy/ and no --force: it is kept untouched (your wiring stays) while the stub, the
  // autoload line, the export presets (a stale capture copy is refreshed here) and .gdignore are still brought up to date.
  // Other engines keep the old rule: an existing file needs --force.
  const keep = godot && existsSync(t.path) && !o.force;
  const captureFile = keep ? "kept" : migrate ? "migrated" : existsSync(t.path) ? "overwritten" : "created";
  const plan = {
    file: rel(src, t.path),
    capture_file: o.dryRun ? `would be ${captureFile}${keep ? " (unchanged: your wiring stays; pass --force to write a fresh one)" : ""}` : captureFile,
    ...(godot ? { stub: rel(src, t.stub) } : {}),
    branch,
    screens: cl.map((c) => ({ key: c.key, open: c.open, wire: c.code?.live === false ? "no opener written: nothing in the project creates or names this class (open it by hand)" : c.code?.guessed_args ? `opener written with GUESSED arguments (${c.code.call}(${(c.code.args ?? []).join(", ")})): check the OPENERS line; map capture skips it unless --include-guessed` : c.code ? `opened by the capture file (${c.code.call ? `${c.code.call}()` : c.code.set ? `${c.code.set} = ${c.code.value}` : "instance shown"} on ${c.code.class ?? c.code.path})` : c.needs, from: c.from, ...(c.code ? { code_built: true, sure: c.sure, ...(c.code.guessed_args ? { guessed_args: true } : {}) } : {}) })),
    ...(r.checklist_left_out?.length ? { left_out: r.checklist_left_out.length, left_out_keys: r.checklist_left_out.map((x) => x.key), left_out_why: "Left off the list: nothing in the project creates or names these classes (dead code). Add them with --include-dead." } : {}),
    ...(lv ? { levels: { type: lv.type, count: lv.count, param: lv.param, wire: `read GamedexyCapture value "${lv.param}" (0 to ${lv.count - 1}) where a run starts, with screen=${(r.checklist ?? []).find((c) => c.level)?.open.split(",")[0].slice(7) ?? "play"}` } } : {}),
    ...(migrate ? { migrate } : {}),
    ...(legacy && !migrate ? { legacy_file: `${rel(src, legacy)} is an older capture file at the repo root. It is left where it is; remove it by hand once ${rel(src, t.path)} is in place.` } : {}),
    ...(godot && uses.length ? { autoload_uses_outside_stub: uses, autoload_uses_warning: `${uses.length} place${uses.length === 1 ? "" : "s"} in the game read the GamedexyCapture autoload beyond take_screen/value/open_screen/seed_value (${[...new Set(uses.map((u) => u.member))].join(", ")}). In a debug build with gamedexy/ they work as before (the stub swaps itself for gamedexy/capture.gd). In a release export the stub has only those four methods, so they get null (or an error for a method call): guard them with a null check.` } : {}),
    ...(godot ? { autoload: wireGodotAutoload(src, t.autoload, { dryRun: true, replace: [LEGACY_AUTOLOAD_LINE] }), exports: wireExportPresets(src, { dryRun: true }), gdignore: addGdignore(src, { dryRun: true }) } : {}),
    ...(existing.length ? { already_reads_gdxState: existing, tip: "This repo already reads -gdxState there. Add the screen keys to that code instead, or keep both (they read the same argument)." } : {}),
  };
  if (o.dryRun) return { dry_run: true, ...plan, content: keep ? `(unchanged: ${plan.file} is kept as it is)` : migrate ? `(unchanged: ${migrate.from} moves to ${migrate.to})` : body, ...(godot ? { stub_content: stubFile() } : {}) };
  if (!branch) throw new Error(`${src} is not a git repo. Capture mode goes on its own branch: git init, commit, then git switch -c gamedexy/capture (ask the developer first).`);
  if (PROTECTED.test(branch)) throw new Error(`The repo is on "${branch}". Capture mode goes on its own branch, never the main one. With the developer's yes: git -C "${src}" switch -c gamedexy/capture, then run capture init again.`);
  if (existsSync(t.path) && !o.force && !keep) throw new Error(`${plan.file} already exists. Pass --force to rewrite it (the wiring you added inside it is lost).`);
  mkdirSync(dirname(t.path), { recursive: true });
  if (keep) {
    /* the capture file stays exactly as it is */
  } else if (migrate) {
    renameSync(legacy, t.path);
    if (existsSync(`${legacy}.uid`)) renameSync(`${legacy}.uid`, `${t.path}.uid`);
  } else writeFileSync(t.path, body);
  let autoload = null;
  let exportsPlan = null;
  let gdignore = null;
  if (godot) {
    if (!existsSync(t.stub)) writeFileSync(t.stub, stubFile());
    autoload = wireGodotAutoload(src, t.autoload, { replace: [LEGACY_AUTOLOAD_LINE] });
    exportsPlan = wireExportPresets(src);
    gdignore = addGdignore(src);
  } else if (t.autoload) autoload = wireGodotAutoload(src, t.autoload);
  // What this run changed, in one line each (a kept capture file and an all-current repo say so plainly).
  const changed = [
    autoload && ["added", "replaced"].includes(autoload.status) ? `autoload ${autoload.status}` : null,
    exportsPlan?.status === "changed" ? `export presets updated${exportsPlan.refreshed?.length ? ` (refreshed ${exportsPlan.refreshed.join(", ")})` : ""}${exportsPlan.capture_presets?.length ? ` (created ${exportsPlan.capture_presets.join(", ")})` : ""}` : null,
    gdignore?.status === "added" ? `.gdignore added: ${gdignore.added.join(", ")}` : null,
  ].filter(Boolean);
  const summary = keep
    ? `Kept ${plan.file} as it is (your wiring stays).${changed.length ? ` Updated: ${changed.join("; ")}.` : " Everything else was already up to date."}`
    : null;
  return {
    ...(keep ? { kept: plan.file, summary } : { written: plan.file }),
    ...plan,
    ...(autoload ? { autoload } : {}),
    ...(exportsPlan ? { exports: exportsPlan } : {}),
    ...(gdignore ? { gdignore } : {}),
    next: keep ? [summary, autoload?.status === "conflict" ? autoload.note : null, "Pass --force only to throw away the wiring in the capture file and write a fresh one."].filter(Boolean) : [
      "Show the developer the new file and wire each screen key where the scan says it opens (debug builds only), with their yes.",
      autoload && autoload.status !== "added" && autoload.status !== "already_wired" ? autoload.note : null,
      r.engine === "godot" ? "Godot: the debug-only capture list needs a debug engine (OS.is_debug_build() is true). Check: gamedexy doctor --platform ios|android --src <repo>" : null,
      r.engine === "swift" ? "If the project uses xcodegen or a file list, regenerate it so the new file is in the target." : null,
      "Build Debug, then: gamedexy map capture --dir <run folder> --scan <scan.json> --all",
      "Before any release: gamedexy doctor --release-app <Release build> must say debug states are left out.",
    ].filter(Boolean),
  };
}
