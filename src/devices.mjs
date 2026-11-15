// Device bridges. iOS Simulator: `xcrun simctl` for screenshots, launch and
// state, and AXe (or idb) for input. Android emulator: `adb`. Only simulators
// and emulators: a physical device id is refused.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export function has(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

/** A blocking pause that works on every OS (`sleep` does not exist on Windows). */
export function pause(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: opts.binary ? undefined : "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

// AXe's first input on a freshly booted simulator often times out while the automation session
// starts (seen on every new simulator in the Gloamwick variant run). One retry after a pause fixes it.
const SESSION_TIMEOUT = /remote automation session/i;
function input(args) {
  // A just-wiped simulator can need 15 s or more before AXe's first input works.
  for (let attempt = 0; ; attempt++) {
    try {
      return run("axe", args);
    } catch (e) {
      if (attempt >= 2 || !SESSION_TIMEOUT.test(String(e?.stderr ?? e?.message ?? ""))) throw e;
      pause(6);
    }
  }
}

// ---- iOS Simulator ------------------------------------------------------------

export const ios = {
  name: "ios",
  booted() {
    const list = JSON.parse(run("xcrun", ["simctl", "list", "devices", "booted", "--json"])).devices;
    return Object.entries(list).flatMap(([runtime, ds]) => ds.map((d) => ({ ...d, runtime })));
  },
  device(udid) {
    const all = JSON.parse(run("xcrun", ["simctl", "list", "devices", "--json"])).devices;
    for (const [runtime, ds] of Object.entries(all)) for (const d of ds) if (d.udid === udid) return { ...d, runtime };
    throw new Error(`No simulator with id ${udid}. Only simulators are supported, never a physical device.`);
  },
  screenshot(udid, path) {
    run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", path]);
  },
  running(udid, bundle) {
    try {
      return run("xcrun", ["simctl", "spawn", udid, "launchctl", "list"]).includes(`UIKitApplication:${bundle}`);
    } catch {
      return false;
    }
  },
  launch(udid, bundle, args = []) {
    run("xcrun", ["simctl", "launch", "--terminate-running-process", udid, bundle, ...args]);
  },
  terminate(udid, bundle) {
    spawnSync("xcrun", ["simctl", "terminate", udid, bundle]);
  },
  driver() {
    if (has("axe")) return "axe";
    if (has("idb")) return "idb";
    return null;
  },
  tap(udid, x, y, hold = 0) {
    const d = ios.driver();
    if (d === "axe") {
      if (hold > 0) input(["touch", "-x", String(x), "-y", String(y), "--down", "--up", "--delay", String(Math.min(hold, 10)), "--udid", udid]);
      // physical = a real touch down and up; WebKit games ignore AXe's default synthesized tap.
      else {
        const physical = () => input(["tap", "-x", String(x), "-y", String(y), "--tap-style", "physical", "--udid", udid]);
        try {
          physical();
        } catch {
          // Native UIKit/SwiftUI screens can reject the physical style; the standard tap works there.
          try {
            input(["tap", "-x", String(x), "-y", String(y), "--udid", udid]);
          } catch {
            // Right after a fresh boot both styles can fail once; a pause and one more physical tap works.
            pause(6);
            physical();
          }
        }
      }
    } else if (d === "idb") {
      run("idb", ["ui", "tap", String(x), String(y), ...(hold > 0 ? ["--duration", String(hold)] : []), "--udid", udid]);
    } else throw new Error("No tap tool. Install AXe (brew install cameroncooke/axe/axe) or idb. See `gamedexy doctor`.");
  },
  swipe(udid, x1, y1, x2, y2, seconds = 0.4) {
    const d = ios.driver();
    if (d === "axe") input(["swipe", "--start-x", String(x1), "--start-y", String(y1), "--end-x", String(x2), "--end-y", String(y2), "--duration", String(seconds), "--udid", udid]);
    else if (d === "idb") run("idb", ["ui", "swipe", String(x1), String(y1), String(x2), String(y2), "--duration", String(seconds), "--udid", udid]);
    else throw new Error("No swipe tool. Install AXe or idb.");
  },
  home(udid) {
    if (ios.driver() === "axe") run("axe", ["button", "home", "--udid", udid]);
    else if (ios.driver() === "idb") run("idb", ["ui", "button", "HOME", "--udid", udid]);
  },
  /**
   * The app in front, from AXe's accessibility tree (its root is the application). Null when it
   * cannot tell. Found 2026-11-09: a system banner opened Settings over the game and taps landed there.
   */
  frontApp(udid) {
    if (ios.driver() !== "axe") return null;
    try {
      const tree = JSON.parse(run("axe", ["describe-ui", "--udid", udid]));
      const root = Array.isArray(tree) ? tree[0] : tree;
      // System alerts (permission prompts) report a blank name: unknown, not "another app".
      return root?.role === "AXApplication" || root?.type === "Application" ? String(root.AXLabel ?? root.label ?? "").trim() || null : null;
    } catch {
      return null;
    }
  },
  /** Point scale: screenshots are in pixels, input is in points. */
  scale(widthPx) {
    return widthPx >= 1100 ? 3 : widthPx >= 700 ? 2 : 1;
  },
  dataContainer(udid, bundle) {
    return run("xcrun", ["simctl", "get_app_container", udid, bundle, "data"]).trim();
  },
  /** Write the game's own saved value through the simulator's preferences daemon (editing the plist file directly is ignored). */
  writeDefault(udid, bundle, key, value) {
    const plist = `${ios.dataContainer(udid, bundle)}/Library/Preferences/${bundle}`;
    run("xcrun", ["simctl", "spawn", udid, "defaults", "write", plist, key, "-string", value]);
  },
  readDefault(udid, bundle, key) {
    const plist = `${ios.dataContainer(udid, bundle)}/Library/Preferences/${bundle}`;
    try {
      return run("xcrun", ["simctl", "spawn", udid, "defaults", "read", plist, key]).trim();
    } catch {
      return null;
    }
  },
};

// ---- Android emulator -----------------------------------------------------------

export const android = {
  name: "android",
  booted() {
    return run("adb", ["devices"])
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter(([id, st]) => id && st === "device")
      .map(([udid]) => ({ udid, name: udid, runtime: "android", isEmulator: udid.startsWith("emulator-") }));
  },
  device(udid) {
    if (!udid.startsWith("emulator-")) throw new Error(`${udid} is not an emulator. Only emulators are supported.`);
    const release = run("adb", ["-s", udid, "shell", "getprop", "ro.build.version.release"]).trim();
    const model = run("adb", ["-s", udid, "shell", "getprop", "ro.product.model"]).trim();
    return { udid, name: model || udid, runtime: `Android-${release}` };
  },
  screenshot(udid, path, writeFile) {
    writeFile(path, run("adb", ["-s", udid, "exec-out", "screencap", "-p"], { binary: true }));
  },
  running(udid, pkg) {
    try {
      return Boolean(run("adb", ["-s", udid, "shell", "pidof", pkg]).trim());
    } catch {
      return false;
    }
  },
  foreground(udid) {
    const out = run("adb", ["-s", udid, "shell", "dumpsys", "activity", "activities"]);
    const m = out.match(/(?:topResumedActivity|mResumedActivity)[^\n]*?\s([\w.]+)\/([\w.$]+)/);
    return m ? { pkg: m[1], activity: m[2] } : { pkg: "", activity: "" };
  },
  versionOf(udid, pkg) {
    try {
      const out = run("adb", ["-s", udid, "shell", "dumpsys", "package", pkg]);
      return { version: out.match(/versionName=(\S+)/)?.[1] ?? null, number: out.match(/versionCode=(\d+)/)?.[1] ?? null };
    } catch {
      return {};
    }
  },
  installed(udid, pkg) {
    try {
      return run("adb", ["-s", udid, "shell", "pm", "path", pkg]).includes("package:");
    } catch {
      return false;
    }
  },
  /** How many Google accounts the emulator is signed in to (a signed-in Play Store can charge real money). */
  googleAccounts(udid) {
    try {
      return (run("adb", ["-s", udid, "shell", "dumpsys", "account"]).match(/Account \{name=[^,]+, type=com\.google\}/g) ?? []).length;
    } catch {
      return null;
    }
  },
  launch(udid, pkg, extras = []) {
    // Always by the launcher activity's name: `monkey` exits with an error on emulators that have
    // no hardware keys ("SYS_KEYS has no physical keys"), found on the first Android run 2026-11-10.
    const comp = run("adb", ["-s", udid, "shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", pkg]).trim().split("\n").pop().trim();
    if (!comp.includes("/")) {
      if (extras.length) throw new Error(`Could not find the launcher activity of ${pkg}. Is it installed? adb -s ${udid} install <path to .apk>`);
      run("adb", ["-s", udid, "shell", "monkey", "--pct-syskeys", "0", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
      return;
    }
    run("adb", ["-s", udid, "shell", "am", "force-stop", pkg]);
    run("adb", ["-s", udid, "shell", "am", "start", "-W", "-n", comp, ...extras]);
  },
  terminate(udid, pkg) {
    spawnSync("adb", ["-s", udid, "shell", "am", "force-stop", pkg]);
  },
  driver() {
    return has("adb") ? "adb" : null;
  },
  tap(udid, x, y, hold = 0) {
    if (hold > 0) run("adb", ["-s", udid, "shell", "input", "swipe", String(x), String(y), String(x), String(y), String(Math.round(hold * 1000))]);
    else run("adb", ["-s", udid, "shell", "input", "tap", String(x), String(y)]);
  },
  swipe(udid, x1, y1, x2, y2, seconds = 0.4) {
    run("adb", ["-s", udid, "shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(Math.round(seconds * 1000))]);
  },
  back(udid) {
    run("adb", ["-s", udid, "shell", "input", "keyevent", "4"]);
  },
  home(udid) {
    run("adb", ["-s", udid, "shell", "input", "keyevent", "3"]);
  },
  /** Android input is in pixels. */
  scale() {
    return 1;
  },
  /** UI text with bounds from the free UI dump. Canvas games return little or nothing. */
  uiText(udid) {
    try {
      run("adb", ["-s", udid, "shell", "uiautomator", "dump", "/sdcard/gdx_ui.xml"]);
      const xml = run("adb", ["-s", udid, "exec-out", "cat", "/sdcard/gdx_ui.xml"]);
      return parseUiDump(xml);
    } catch {
      return [];
    }
  },
};

export function parseUiDump(xml) {
  const out = [];
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = m[0];
    const text = (node.match(/\btext="([^"]*)"/)?.[1] || node.match(/\bcontent-desc="([^"]*)"/)?.[1] || "")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
    const b = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (text.trim() && b) out.push({ text: text.trim(), x0: +b[1], y0: +b[2], x1: +b[3], y1: +b[4] });
  }
  return out;
}

export function bridge(platform) {
  if (platform === "ios") return ios;
  if (platform === "android") return android;
  throw new Error(`Unsupported platform "${platform}". Use ios or android.`);
}

export const isMac = process.platform === "darwin";
export const fileExists = existsSync;
