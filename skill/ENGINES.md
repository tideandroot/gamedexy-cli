# Game Map engine recipes

A **quick run** needs no engine code at all: Game Map drives the built app on a simulator or
emulator, so any engine works once its build installs. This file is for **deep runs**, which use
debug states (`--state "coins=500"`, `outcome=win`, `clock=3d`, `offline=1`) to reach screens
that play alone cannot reach fast. Every hook below is for debug builds only, goes on its own
branch (for example `gamedexy/debug-states`), and needs the developer's yes before you add it.

How states arrive:

| Platform | How the CLI passes `--state "a=1,b=2"` |
|---|---|
| Android | Intent string extra `gdxState` = `a=1,b=2` |
| iOS | Launch arguments `-gdxState a=1,b=2` |

Parse the string the same way everywhere: split on `,`, then on the first `=`.

## Godot 4 (tested on Android 2026-11-10 with Godot 4.7.2)

**Build for the Android emulator**

1. Install the Android export template (Editor > Manage Export Templates, or only the Android
   debug template if disk space matters) and point Editor Settings > Export > Android > Java SDK
   Path at a JDK 17.
2. **Set the renderer to Compatibility** (Project Settings > Rendering > Renderer > Rendering
   Method: `gl_compatibility`). Android emulators draw Forward+ and Mobile (Vulkan) as a black
   screen. A game that must ship on Vulkan can keep it for release and switch only the emulator
   export preset's renderer.
3. Capture needs a **debug** engine (`OS.is_debug_build()` is false in a release export, so the capture
   list does nothing and every screenshot is the start screen). The official export templates include
   debug builds. For a custom engine (for example an arm64 iOS Simulator build) build
   `target=template_debug`, not only `template_release`. `gamedexy doctor --platform ios|android --src <repo>
   [--engine-dir <folder of engine builds>]` says when only a release engine is installed.
4. Export a debug APK from the command line:
   `godot --headless --path . --export-debug Android build/game.apk`
   (the preset name is the one in `export_presets.cfg`).
5. Install: `adb -s emulator-5554 install -r build/game.apk`. A Godot export can leave adb
   offline for a moment; run `adb wait-for-device` first if the install says "device offline".
6. Cold starts of a debug build on an emulator take 10 to 20 seconds. That is normal.

**Debug states** (autoload or the main scene's `_ready`):

```gdscript
# Gamedexy debug states. Debug builds only: OS.is_debug_build() is false in release exports.
func read_gdx_state() -> Dictionary:
	var out := {}
	if not OS.is_debug_build():
		return out
	var raw := ""
	if OS.has_feature("android") and Engine.has_singleton("AndroidRuntime"):
		var intent = Engine.get_singleton("AndroidRuntime").getActivity().getIntent()
		if intent != null and intent.hasExtra("gdxState"):
			raw = str(intent.getStringExtra("gdxState"))
	else:
		var args := OS.get_cmdline_args()
		var i := args.find("-gdxState")
		if i >= 0 and i + 1 < args.size():
			raw = args[i + 1]
	for pair in raw.split(",", false):
		var kv := pair.split("=", false, 1)
		if kv.size() == 2:
			out[kv[0].strip_edges()] = kv[1].strip_edges()
	return out
```

**Screens built in code.** `gamedexy scan` also reads GDScript for UI that has no `.tscn`: scripts that
extend a UI node and are made with `.new()` and `add_child`, `match` or `enum` screen switches, `show_*`
and `open_*` functions, and `AcceptDialog.new()`-style popups. Each gets `code` in `scan.json` (script
path, function to call, arguments); `sure: false` and `guessed_args` mean read it before trusting it
(a screen with guessed arguments is never sure).
`gamedexy capture init --src <repo> [--seed N]` writes them into an `OPENERS` table in
`gamedexy/capture.gd` and adds the `GamedexyCapture` autoload line (the stub, see "The `gamedexy/` folder" below) to
`project.godot` itself (once; a run with `--dry-run` shows every diff, and an existing line is never changed); the autoload opens the screen itself after a few frames (finding the node by
script, or making one), calling `seed(N)` first when a seed is set. The seed only applies to a launch with
`-gdxState`; a normal debug run gets -1 from `seed_value()` and its randomness is left alone. That seeds Godot's global generator
only (`randi()`, `randf()`, `shuffle()`). A game that makes its own `RandomNumberGenerator` is not made
repeatable by it: read the seed from the autoload (-1 unless the launch has `-gdxState` and a seed) and set `rng.seed` yourself.
Look the autoload up by name, never by the bare identifier `GamedexyCapture`: autoloads are not registered under
`godot --script` tests, so the bare name fails to compile there (and in any build without the autoload).

```gdscript
var cap := get_node_or_null("/root/GamedexyCapture")  # null under --script tests and builds without it
if cap != null and cap.seed_value() >= 0:
	_rng.seed = cap.seed_value()   # or cap.value("seed")
```

The same goes for opening a scene screen: `var cap := get_node_or_null("/root/GamedexyCapture")`, then
`if cap != null: match cap.take_screen(): ...`. `-gdxState screen=<key>,seed=7` overrides the seed for one launch; a seed
that is not a whole number is ignored with a warning. Fix an `OPENERS` line when a placeholder argument
opens it wrong. A screen whose function needs an object argument gets no `OPENERS` line (the scan lists
it as unsure; so does a class whose `_init` needs arguments), and the autoload refuses a call whose arguments do
not fit, or a class whose `_init` needs arguments, with a warning instead of crashing. A class that nothing creates and nothing names (not as an autoload, not by `ClassName`, not by its `res://` path, not through a
`preload`/`load`; the scan marks its code `live: false`) stays in the screen list but is left off the capture checklist (the scan says
how many; `--include-dead` on `scan` or `capture init` adds them) and gets no `OPENERS` line: a guessed call on it
can crash the game, so open it by hand. An `OPENERS` line made with guessed placeholder arguments
(`show_celebration("", "")`) is marked `GUESSED`; `map capture` skips it unless `--include-guessed`, and then reports it as
unsure, not captured. A key that comes up looking like the start screen (animation tolerated: a close picture AND the same text) is reported as not reached; text that differs, even only in its numbers, is a different screen. A code-built screen whose key matches a scene's key is listed as
`<key>_code` and the scene keeps its own key. The scan reads `extends Control` and `class_name X extends Control`;
the path form `extends "res://base.gd"` is not detected.
Classes nothing creates, `Resource` data classes, helper widgets (`ShopItemCard`) and scene scripts are
not listed as sure screens.

`AndroidRuntime` is built into Godot 4.4 and later. On iOS, Godot passes launch arguments to
`OS.get_cmdline_args()`; that path follows Godot's source and is not yet tested on a real run.

**The `gamedexy/` folder (never ships).** All of Gamedexy's test, debug and capture code for a Godot game lives in one
folder, `res://gamedexy/` (the capture list `gamedexy/capture.gd`; put a codex render hook there too as
`gamedexy/codex.gd`, which `codex render` finds by itself). `capture init` sets it up and leaves it out of every
export:

- **The autoload trap.** Godot registers autoloads in `project.godot`, so an autoload whose script is excluded from
  an export makes the release build fail at start. The registered autoload is therefore a tiny stub **outside**
  the folder, `res://gamedexy_stub.gd` (named `GamedexyCapture`, so game code still looks up
  `/root/GamedexyCapture` in every build). It holds no capture code: only in a debug build (`OS.is_debug_build()`)
  where `res://gamedexy/capture.gd` exists does it **swap its own script for that file** as it enters the tree, so the
  autoload *is* the capture script and every method and property of it (`take_screen()`, `value()`, `open_screen()`,
  `seed_value()`, `values`, anything you added, `cap.get("values")`) is reached directly, exactly as before the file
  moved. One difference: the capture file's own `_enter_tree` does not run after the swap (its `_ready`, `_process` and
  the rest do), so put start-up code in `_ready` or `_init`. (An earlier design that added the file as a child and forwarded four calls hid properties such as `values`;
  a game's own log helper that reads `cap.get("values")` went silent.) In a release export the folder is not there,
  so the four calls return their empty answer (`""`, `false`, `-1`) and any other read, such as `cap.get("values")`,
  gives null: guard such uses with a null check. `capture init` lists them (`autoload_uses_outside_stub`). The stub
  ships (33 lines, no capture code); `check-export` allows it on purpose. Probed on Godot 4.7.2 against a game that
  reads `values` and `seed_value()`: identical answers before and after the move, and null/empty without the folder.
- **Export filters.** `gamedexy/*` is added to the `exclude_filter` of every preset in `export_presets.cfg` (existing
  filters kept, once only; `--dry-run` prints the diff). A capture build needs the folder, so each preset also gets a
  copy (iOS and Android presets only, where capture builds are made) named `<name> (Gamedexy capture)` (not runnable,
  filter without `gamedexy/*`, output under `build/gamedexy-capture/`). **Export capture builds from the copy and
  release builds from the original**: `godot --headless --export-debug "Android (Gamedexy capture)" build/capture.apk`.
  The copy is a snapshot: when you change the original preset (filters, options, output path) it goes stale. Re-run
  `gamedexy capture init` to refresh it from the original (the copy is rewritten, so do not edit it by hand; a re-run
  keeps `gamedexy/capture.gd` exactly as it is and only updates the stub, autoload line, presets and `.gdignore`;
  `--force` is only for writing a fresh capture file);
  `gamedexy doctor --src <repo>` fails while a copy is out of date.
- **`.gdignore`.** Screenshot folders (`screenshots`, `screenshot`, `shots`) get an empty `.gdignore`, so Godot does not
  import captured PNGs.
- **Older repos.** A `gamedexy_capture.gd` at the repo root (an earlier `capture init`) is moved into `gamedexy/`
  unchanged (your wired `OPENERS` stay) and its autoload line is pointed at the stub.
- **Proof.** `gamedexy check-export <build>` reads an exported `.pck` (Godot 4 file table, no Godot needed), an
  `.apk`, `.ipa`, `.aab` or `.zip` (and every `.pck` inside), or an exported folder, and exits 1 when any `gamedexy/`
  path or capture script is inside, or when the build cannot be read. Run it in the ship script and refuse the build
  on a non-zero exit. It checks **paths only**: debug-gated code that lives outside the folder (a game file that
  reads `-gdxState`, a seed or log helper such as `capture_seed.gd`) can still ship, and `capture init` lists those
  as `already_reads_gdxState`; `gamedexy doctor --release-app` looks for the string in a Release build. `gamedexy doctor --src <repo>` also fails while a preset lacks the filter or the old root file
  is still there, and `gamedexy doctor --release-app <build>` still checks the debug-state string is absent.

Debug-only still holds inside a debug build: the folder's text is not in release exports (excluded), and
`OS.is_debug_build()` switches the code off wherever it is present. Prove it before shipping: export release,
run `gamedexy check-export` on it, launch it with `--state "coins=999"` and check with a screenshot that nothing changed.

**Clock** (`clock=3d`): keep one helper and use it wherever the game reads the time.

```gdscript
var gdx_clock_days := 0  # set from read_gdx_state(): int(state.get("clock", "0d").trim_suffix("d"))
func now_unix() -> float:
	return Time.get_unix_time_from_system() + gdx_clock_days * 86400.0
```

**Reading the screen.** Godot draws its own buttons, so Android's UI dump is empty. The purchase
guard reads the screenshot instead (Apple Vision on a Mac, the reader built into Windows, or
Tesseract). With no reader, taps are refused rather than sent unchecked.

## Unity (written from Unity's documentation; not yet tested on a real Unity game)

**Build for the emulator or simulator**

- Android: install the Android Build Support module (with OpenJDK and the SDK/NDK) in Unity Hub.
  File > Build Settings > Android, tick **Development Build**, build an APK, then
  `adb install -r game.apk`. Use an x86_64 or arm64 emulator image that matches the build's
  target architectures (Player Settings > Other Settings > Target Architectures).
- iOS: Player Settings > Target SDK **Simulator SDK**, build the Xcode project, then build it
  for a simulator with `xcodebuild ... -sdk iphonesimulator CODE_SIGN_IDENTITY=-`.

**Debug states.** `DEVELOPMENT_BUILD` is a compile-time define, so release builds do not contain
this code at all.

```csharp
using System.Collections.Generic;
using UnityEngine;

public static class GdxState
{
    public static Dictionary<string, string> Read()
    {
        var o = new Dictionary<string, string>();
#if DEVELOPMENT_BUILD || UNITY_EDITOR
        string raw = null;
#if UNITY_ANDROID && !UNITY_EDITOR
        using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
        using (var activity = player.GetStatic<AndroidJavaObject>("currentActivity"))
        using (var intent = activity.Call<AndroidJavaObject>("getIntent"))
            raw = intent.Call<string>("getStringExtra", "gdxState");
#else
        var args = System.Environment.GetCommandLineArgs();
        var i = System.Array.IndexOf(args, "-gdxState");
        if (i >= 0 && i + 1 < args.Length) raw = args[i + 1];
#endif
        if (!string.IsNullOrEmpty(raw))
            foreach (var pair in raw.Split(','))
            {
                var kv = pair.Split(new[] { '=' }, 2);
                if (kv.Length == 2) o[kv[0].Trim()] = kv[1].Trim();
            }
#endif
        return o;
    }
}
```

Call `GdxState.Read()` once at startup (a `[RuntimeInitializeOnLoadMethod]` or the first
scene's `Awake`) and apply each key. For `clock=Nd`, route the game's time reads through one
helper that adds N days, the same as the Godot example.

If anything here does not work on a real Unity project, tell Gamedexy with
`gamedexy map feedback --kind missing-tool --text "..."`, or ask for help at support@gamedexy.com.

## Native, React Native, Flutter, web games

See the debug-state examples in SKILL.md (Swift, Kotlin, web view). React Native and Flutter
read the same Android extra and iOS launch arguments through their platform channels.
