// `gamedexy doctor`: catch the setup traps before a run starts. Every check
// here is something that broke or would have broken the phase 0 dogfood run.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { ios, android, has } from "./devices.mjs";
import { checkExport } from "./export-check.mjs";
import { exportFilterState } from "./gamedexy-dir.mjs";
import { releaseHasHook } from "./fresh.mjs";
import { readerName, visionAvailable } from "./ocr.mjs";

function ok(name, pass, detail, fix) {
  return { check: name, ok: pass, detail, ...(pass ? {} : { fix }) };
}

function freeGb() {
  try {
    const s = statfsSync(".");
    return Math.round((s.bavail * s.bsize) / 1024 ** 3);
  } catch {
    return null;
  }
}

/** Where Godot keeps the export templates it installed, by OS. */
export function godotTemplateRoot(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Godot", "export_templates");
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Godot", "export_templates");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "godot", "export_templates");
}

function godotVersion() {
  for (const bin of [process.env.GODOT, "godot", "/opt/homebrew/bin/godot", "/Applications/Godot.app/Contents/MacOS/Godot"].filter(Boolean)) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 8000 });
    const m = r.status === 0 ? /^(\d+\.\d+(?:\.\d+)?\.[a-z]+\d*)/.exec(String(r.stdout).trim()) : null;
    if (m) return m[1];
  }
  return null;
}

function listFiles(dir, depth = 4, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0 && out.length < 5000) listFiles(p, depth - 1, out);
    else out.push(p);
  }
  return out;
}

// What the official export templates are called per platform. These zips and apks hold both the debug and release builds.
const OFFICIAL = { ios: /(^|[\\/])ios\.zip$/i, android: /(^|[\\/])android_(source\.zip|debug\.apk)$/i };
const FOR_PLATFORM = { ios: /ios|simulator/i, android: /android/i };

/**
 * Godot capture needs a debug engine: `OS.is_debug_build()` is false in a release export, so the
 * capture hooks do nothing and every screenshot is the start screen. Looks at the installed export
 * templates for this Godot version and at `--engine-dir` (a folder of custom engine builds).
 * `dirs` and `version` are injectable for tests.
 */
export function godotDebugEngine(o, { dirs, version } = {}) {
  const platform = o.platform;
  const name = "Godot debug engine (OS.is_debug_build() true)";
  const ver = version === undefined ? godotVersion() : version;
  // --engine-dir is the engine the export really uses (a custom build), so it is checked alone;
  // official templates installed elsewhere do not make a release-only custom engine capture-ready.
  const roots = dirs ?? (o.engineDir ? [o.engineDir] : [
    ...(() => {
      const root = godotTemplateRoot();
      if (ver && existsSync(join(root, ver))) return [join(root, ver)];
      try {
        return readdirSync(root).map((d) => join(root, d));
      } catch {
        return [];
      }
    })(),
  ]);
  const files = roots.flatMap((r) => listFiles(r).map((f) => relative(r, f)));
  const mine = files.filter((f) => FOR_PLATFORM[platform]?.test(f));
  const official = mine.some((f) => OFFICIAL[platform]?.test(f));
  const debug = mine.filter((f) => /debug/i.test(f));
  const release = mine.filter((f) => /release/i.test(f));
  const how = platform === "ios"
    ? "Install Godot's export templates (Editor > Manage Export Templates), or build the debug engine from the Godot source with the same flags as your release one, but target=template_debug (for the simulator: scons platform=ios target=template_debug arch=arm64 simulator=yes), then export with --export-debug."
    : "Install Godot's export templates (Editor > Manage Export Templates; they include android_debug.apk), then export with --export-debug.";
  if (official || debug.length) return ok(name, true, official ? `official ${platform} export templates${ver ? ` (${ver})` : ""}` : `debug engine found: ${debug[0]}`);
  if (release.length) return ok(name, false, `only a release engine found (${release[0]}): OS.is_debug_build() is false there, so the capture list does nothing and every screenshot is the start screen`, how);
  return { check: name, ok: null, detail: `no ${platform} engine or export templates found${ver ? ` for Godot ${ver}` : ""} in ${roots.join(", ") || godotTemplateRoot()}`, fix: how };
}

/** An exported build holds none of Gamedexy's dev folder (see export-check.mjs). */
function exportCheck(path) {
  const r = checkExport(path);
  return ok("Exported build has no gamedexy/ folder or capture script", r.ok, r.ok ? r.verdict : `${r.verdict} ${r.found.slice(0, 3).map((f) => f.path).join(", ")}${r.unreadable[0] ? ` (${r.unreadable[0].why})` : ""}`, r.next);
}

/** A Godot repo with Gamedexy capture code: its export presets must leave the dev folder out. */
function devFolderCheck(src) {
  const legacy = existsSync(join(src, "gamedexy_capture.gd"));
  const st = exportFilterState(src);
  const missing = st?.missing ?? [];
  const fix = "Run: gamedexy capture init --src <repo> (adds gamedexy/* to each preset's exclude filter and moves the capture file into gamedexy/); then check a build with: gamedexy check-export <build>.";
  if (legacy) return ok("Gamedexy dev folder stays out of exports", false, "gamedexy_capture.gd sits at the repo root, where every export includes it", fix);
  if (!st) return { check: "Gamedexy dev folder stays out of exports", ok: null, detail: "no export_presets.cfg yet", fix: "When you create export presets, add gamedexy/* to each one's exclude filter." };
  if (!missing.length && st.stale.length) return ok("Gamedexy dev folder stays out of exports", false, `the capture preset copy is out of date with its original (${st.stale.join(", ")})`, "Run gamedexy capture init --src <repo> again: it refreshes each \"(Gamedexy capture)\" copy from its original preset and keeps your gamedexy/capture.gd as it is.");
  return ok("Gamedexy dev folder stays out of exports", missing.length === 0, missing.length ? `gamedexy/* is missing from the exclude filter of: ${missing.join(", ")}` : `gamedexy/* is excluded in all ${st.total} export preset${st.total === 1 ? "" : "s"}`, fix);
}

export function doctor(o) {
  // `doctor --export <build>` alone checks a finished build, no device needed.
  if (o.export && !o.platform) {
    const c = exportCheck(o.export);
    return { ready: c.ok === true, failed: c.ok === true ? 0 : 1, checks: [c] };
  }
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(ok("Node 20 or newer", major >= 20, process.versions.node, "Install Node 20+ from nodejs.org."));
  const gb = freeGb();
  if (gb !== null) checks.push(ok("Free disk space", gb >= 5, `${gb} GB free`, "Free at least 5 GB; simulators and screenshots need room."));

  if (o.platform === "ios") {
    const mac = process.platform === "darwin";
    checks.push(ok("macOS", mac, process.platform, "The iOS Simulator only runs on a Mac. Map the Android build instead, or use a Mac."));
    if (mac) {
      const xcrun = has("xcrun");
      checks.push(ok("Xcode command line tools", xcrun, xcrun ? "xcrun found" : "missing", "Install Xcode, then run: xcode-select --install"));
      let booted = [];
      try {
        booted = ios.booted();
      } catch {
        /* reported below */
      }
      checks.push(ok("A booted simulator", booted.length > 0, booted.map((d) => `${d.name} (${d.udid})`).join(", ") || "none", "Boot one: open -a Simulator, or xcrun simctl boot <id>"));
      const driver = ios.driver();
      checks.push(ok("Tap tool (AXe or idb)", Boolean(driver), driver ?? "none", "Install AXe (free, MIT): brew install cameroncooke/axe/axe"));
      checks.push(ok("On-device text reading (Apple Vision)", visionAvailable(), visionAvailable() ? "available" : "missing", "Needs Xcode command line tools."));
      if (o.device && o.appId) {
        let installed = false;
        try {
          installed = Boolean(ios.dataContainer(o.device, o.appId));
        } catch {
          installed = false;
        }
        checks.push(ok("Game installed on the simulator", installed, o.appId, "Build for the simulator and install: xcrun simctl install <id> <path/to/App.app>"));
      }
      if (o.app) {
        const exists = existsSync(o.app);
        checks.push(ok("App bundle found", exists, o.app, "Pass the built .app path with --app."));
        if (exists) {
          const sig = spawnSync("codesign", ["-dv", o.app], { encoding: "utf8" });
          // CODE_SIGNING_ALLOWED=NO leaves only the linker's ad hoc signature: no entitlements, so no Keychain.
          const unsigned = /not signed|linker-signed/i.test(sig.stderr ?? "");
          checks.push(
            ok(
              "Build is signed (ad hoc is fine)",
              !unsigned,
              unsigned ? "only linker-signed (no entitlements)" : "signed",
              "Unsigned simulator builds cannot save to the Keychain, so currencies and purchases kept there silently fail. Build with CODE_SIGN_IDENTITY=- instead of CODE_SIGNING_ALLOWED=NO.",
            ),
          );
        }
      }
      checks.push({
        check: "Store prices",
        ok: null,
        detail: "Launching with simctl does not attach the scheme's StoreKit configuration file.",
        fix: "If prices show as unavailable, note it in the run, or test purchases from Xcode. Never confirm a purchase sheet.",
      });
    }
  } else if (o.platform === "android") {
    const adb = has("adb");
    checks.push(ok("adb (Android platform tools)", adb, adb ? "found" : "missing", process.platform === "win32" ? "Install Android Studio (or the platform-tools zip) and add %LOCALAPPDATA%\\Android\\Sdk\\platform-tools to PATH." : "Install Android platform-tools and add them to PATH."));
    let emu = null;
    if (adb) {
      const emus = android.booted().filter((d) => d.isEmulator);
      emu = o.device ?? emus[0]?.udid ?? null;
      checks.push(ok("A running emulator", emus.length > 0, emus.map((d) => d.udid).join(", ") || "none", "Start one: emulator -avd <name>. Physical devices are not supported."));
      if (emu && o.appId) {
        checks.push(ok("Game installed on the emulator", android.installed(emu, o.appId), o.appId, "Install the debug build: adb -s <id> install -r <path/to/game.apk>"));
      }
      if (emu) {
        const google = android.googleAccounts(emu);
        if (google) {
          checks.push({
            check: "Google Play account on the emulator",
            ok: null,
            detail: `${google} Google account${google === 1 ? "" : "s"} signed in`,
            fix: "A signed-in Play Store can charge real money. The tap guard refuses prices and stops on purchase sheets, but an emulator image without the Play Store (\"Google APIs\") or signed out is safest.",
          });
        }
      }
    }
    const reader = readerName();
    checks.push(
      ok(
        "Text reader for the purchase guard",
        Boolean(reader),
        { vision: "Apple Vision (built into macOS)", windows: "Windows OCR (built into Windows)", tesseract: "Tesseract" }[reader] ?? "none: only the Android UI dump, which is empty for Godot, Unity and Cocos games",
        process.platform === "win32"
          ? "Windows 10 and 11 include a text reader; it needs at least one language with OCR installed (Settings > Time & language > Language & region > add English). Without it, taps on canvas games are refused."
          : "Install tesseract (free). Without a reader, taps on canvas games are refused, because prices cannot be checked.",
      ),
    );
  } else {
    throw new Error("Use --platform ios or --platform android.");
  }
  if ((o.engine === "godot" || (o.src && existsSync(join(o.src, "project.godot"))) || o.engineDir) && FOR_PLATFORM[o.platform]) checks.push(godotDebugEngine(o));
  if (o.src && existsSync(join(o.src, "project.godot")) && (existsSync(join(o.src, "gamedexy")) || existsSync(join(o.src, "gamedexy_capture.gd")) || existsSync(join(o.src, "gamedexy_stub.gd")))) checks.push(devFolderCheck(o.src));
  if (o.export) checks.push(exportCheck(o.export));
  if (o.releaseApp) {
    // Debug states must never ship: the Release build's executable must not carry the hook.
    let hook = null;
    let detail = "";
    try {
      hook = releaseHasHook(o.releaseApp);
      detail = hook ? "gdxState found in this build" : "no gdxState in this build";
    } catch (e) {
      detail = e.message;
    }
    checks.push(ok("Debug states left out of Release", hook === false, detail, "Wrap the -gdxState code in #if DEBUG (Swift), BuildConfig.DEBUG (Android) or the engine's debug-build check, then rebuild Release."));
  }
  const failed = checks.filter((c) => c.ok === false).length;
  return { ready: failed === 0, failed, checks };
}
