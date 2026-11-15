// `gamedexy doctor`: catch the setup traps before a run starts. Every check
// here is something that broke or would have broken the phase 0 dogfood run.
import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { ios, android, has } from "./devices.mjs";
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

export function doctor(o) {
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
