// gamedexy capture init: write the debug-only capture list into the developer's game repo
// (Slice 26 Part G, PR 2, D-102). The file reads the same `-gdxState` launch argument as every
// Gamedexy debug state, so `gamedexy doctor --release-app` already proves it is not in Release.
// It only parses the argument and lists the screen keys from the scan; the agent wires each key to
// the code that opens that screen (the scan says which), with the developer's yes, on its own branch.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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

function godotFile(cl) {
  return `extends Node
## Gamedexy capture list (debug builds only; added by \`gamedexy capture init\` on its own branch).
## Add this file as an autoload named GamedexyCapture. Gamedexy launches the game with
## \`-gdxState screen=<key>\` and screenshots what opens. Everything returns early outside debug
## builds; \`gamedexy doctor --release-app <exported release build>\` checks the string is absent.
##
## Open GamedexyCapture.take_screen() where the game starts, for example:
##   match GamedexyCapture.take_screen():
##       "shop": $ShopPopup.popup_centered()
${cl.map((c) => `##   ${comment(c)}`).join("\n")}

const SCREENS := [${cl.map((c) => `"${c.key}"`).join(", ")}]
var values := {}
var _taken := false

func _ready() -> void:
	if not OS.is_debug_build():
		return
	var args := OS.get_cmdline_args() + OS.get_cmdline_user_args()
	var i := args.find("-gdxState")
	if i < 0 or i + 1 >= args.size():
		return
	for pair in String(args[i + 1]).split(","):
		var kv := pair.split("=", true, 1)
		if kv.size() == 2:
			values[kv[0].strip_edges()] = kv[1].strip_edges()

func take_screen() -> String:
	if not OS.is_debug_build() or _taken:
		return ""
	_taken = true
	return values.get("screen", "")

func value(key: String) -> String:
	return values.get(key, "") if OS.is_debug_build() else ""
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
  if (engine === "godot") return { path: join(src, "gamedexy_capture.gd"), autoload: 'GamedexyCapture="*res://gamedexy_capture.gd"' };
  if (engine === "unity") return { path: join(src, "Assets", "Gamedexy", "GamedexyCapture.cs") };
  return null;
}

/**
 * Write the debug-only capture list into the repo. Refuses on main/master and other shared
 * branches: the developer makes a branch first (the agent asks them). `--dry-run` shows the file.
 */
export function captureInit(o) {
  const src = o.src;
  const r = o.scan && existsSync(o.scan) ? JSON.parse(readFileSync(o.scan, "utf8")) : scanRepo(src, { engine: o.engine });
  const cl = (r.checklist ?? []).filter((c) => !c.level);
  const lv = r.levels?.[0] ?? null;
  const files = walk(src);
  const t = target(src, r.engine, files);
  if (!t) throw new Error(`No capture template for engine "${r.engine}". Pass --engine swift|kotlin|godot|unity.`);
  const branch = branchOf(src);
  const existing = files.filter((f) => [".swift", ".kt", ".java", ".gd", ".cs"].includes(f.ext) && f.abs !== t.path).filter((f) => {
    try {
      return readFileSync(f.abs, "utf8").includes("gdxState");
    } catch {
      return false;
    }
  }).map((f) => f.rel);
  const body = { swift: () => swiftFile(cl), kotlin: () => kotlinFile(cl, t.pkg), godot: () => godotFile(cl), unity: () => unityFile(cl) }[r.engine]();
  const plan = {
    file: rel(src, t.path),
    branch,
    screens: cl.map((c) => ({ key: c.key, open: c.open, wire: c.needs, from: c.from })),
    ...(lv ? { levels: { type: lv.type, count: lv.count, param: lv.param, wire: `read GamedexyCapture value "${lv.param}" (0 to ${lv.count - 1}) where a run starts, with screen=${(r.checklist ?? []).find((c) => c.level)?.open.split(",")[0].slice(7) ?? "play"}` } } : {}),
    ...(t.autoload ? { autoload: `Add to project.godot under [autoload]: ${t.autoload}` } : {}),
    ...(existing.length ? { already_reads_gdxState: existing, tip: "This repo already reads -gdxState there. Add the screen keys to that code instead, or keep both (they read the same argument)." } : {}),
  };
  if (o.dryRun) return { dry_run: true, ...plan, content: body };
  if (!branch) throw new Error(`${src} is not a git repo. Capture mode goes on its own branch: git init, commit, then git switch -c gamedexy/capture (ask the developer first).`);
  if (PROTECTED.test(branch)) throw new Error(`The repo is on "${branch}". Capture mode goes on its own branch, never the main one. With the developer's yes: git -C "${src}" switch -c gamedexy/capture, then run capture init again.`);
  if (existsSync(t.path) && !o.force) throw new Error(`${plan.file} already exists. Pass --force to rewrite it (the wiring you added inside it is lost).`);
  mkdirSync(dirname(t.path), { recursive: true });
  writeFileSync(t.path, body);
  return {
    written: plan.file,
    ...plan,
    next: [
      "Show the developer the new file and wire each screen key where the scan says it opens (debug builds only), with their yes.",
      r.engine === "swift" ? "If the project uses xcodegen or a file list, regenerate it so the new file is in the target." : null,
      "Build Debug, then: gamedexy map capture --dir <run folder> --scan <scan.json> --all",
      "Before any release: gamedexy doctor --release-app <Release build> must say debug states are left out.",
    ].filter(Boolean),
  };
}
