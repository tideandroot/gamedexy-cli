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
3. Export a debug APK from the command line:
   `godot --headless --path . --export-debug Android build/game.apk`
   (the preset name is the one in `export_presets.cfg`).
4. Install: `adb -s emulator-5554 install -r build/game.apk`. A Godot export can leave adb
   offline for a moment; run `adb wait-for-device` first if the install says "device offline".
5. Cold starts of a debug build on an emulator take 10 to 20 seconds. That is normal.

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

`AndroidRuntime` is built into Godot 4.4 and later. On iOS, Godot passes launch arguments to
`OS.get_cmdline_args()`; that path follows Godot's source and is not yet tested on a real run.

Godot keeps scripts in the exported package, so the hook's text is present in release builds too;
`OS.is_debug_build()` is what switches it off. Prove it before shipping: export release, launch it
with `--state "coins=999"` and check with a screenshot that nothing changed.

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
