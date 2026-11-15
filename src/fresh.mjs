// Fresh first sessions and Gamedexy debug states.
//
// Safety model (nothing here can touch a real device, another app, or a player):
// - Only simulators and emulators (the bridges refuse physical devices).
// - A full wipe (Keychain included) only on a simulator this tool created and named
//   "Gamedexy Map ...". Any other simulator keeps everything except the game's own data,
//   and that data is backed up into the run folder first so `map restore-data` can put it back.
// - Android: the game's data is backed up (debug builds, `run-as`) before `pm clear`.
//   If it cannot be backed up, nothing is cleared unless the developer passes --no-backup.
// - Debug states are launch arguments. The game reads them only in debug builds; `doctor
//   --release-app` checks that a Release build does not contain them.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { android, ios } from "./devices.mjs";

export const DEDICATED_PREFIX = "Gamedexy Map";
export const STATE_ARG = "-gdxState";
export const isDedicated = (name) => String(name ?? "").startsWith(DEDICATED_PREFIX);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });

// ---- debug states ---------------------------------------------------------------

/** "level=26, gems=100" -> "level=26,gems=100". Keys are words; values are short and plain, so nothing can be injected. */
export function parseState(s) {
  const pairs = String(s ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!pairs.length) throw new Error('--state needs pairs like "level=26,gems=100"');
  const out = [];
  for (const p of pairs) {
    const m = p.match(/^([a-zA-Z][\w-]{0,31})=([\w.:-]{1,64})$/);
    if (!m) throw new Error(`Bad state pair "${p}". Use key=value with letters, digits, dot, dash or colon.`);
    out.push(`${m[1]}=${m[2]}`);
  }
  return out.join(",");
}

/** Launch arguments for a state. iOS: process arguments. Android: an intent string extra. */
export function stateArgs(platform, state) {
  if (!state) return [];
  const s = parseState(state);
  return platform === "android" ? ["--es", "gdxState", s] : [STATE_ARG, s];
}

const MACHO = new Set(["cffaedfe", "cefaedfe", "cafebabe", "feedfacf", "feedface", "bebafeca"]);

/**
 * True when any binary in a built app carries the debug-state hook (it must not in Release).
 * Scans every Mach-O or ELF file in the bundle, not only the main executable: Xcode debug builds
 * keep the code in `<App>.debug.dylib`, and engines put it in frameworks or `.so` libraries.
 */
export function releaseHasHook(appPath) {
  if (!existsSync(appPath)) throw new Error(`No app at ${appPath}`);
  const needle = Buffer.from("gdxState");
  const files = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    else if (st.size > 64) files.push(p);
  };
  walk(appPath);
  let binaries = 0;
  for (const f of files) {
    const head = readFileSync(f).subarray(0, 4);
    const isBin = MACHO.has(head.toString("hex")) || head.toString("latin1") === "\x7fELF" || f.endsWith(".so") || f.endsWith(".dex");
    if (!isBin) continue;
    binaries++;
    if (readFileSync(f).includes(needle)) return true;
  }
  if (!binaries) throw new Error(`No binaries found in ${appPath}. Pass the built .app (or an unzipped .apk).`);
  return false;
}

// ---- dedicated simulator ------------------------------------------------------------

/** A simulator just for mapping, same model and iOS as `like`. Reused if it already exists. */
export function createDevice({ like, type }) {
  // --type "iPhone SE (3rd generation)" makes that model on the newest installed iOS runtime
  // (the small-phone variant run needs one even when no such simulator exists yet).
  if (type) {
    const types = JSON.parse(sh("xcrun", ["simctl", "list", "devicetypes", "--json"])).devicetypes;
    const t = types.find((x) => x.name.toLowerCase() === String(type).toLowerCase());
    if (!t) throw new Error(`No simulator model named "${type}". Try: "iPhone SE (3rd generation)", "iPhone 17 Pro". List them with: xcrun simctl list devicetypes`);
    const runtimes = JSON.parse(sh("xcrun", ["simctl", "list", "runtimes", "--json"])).runtimes
      .filter((r) => r.isAvailable && r.platform === "iOS" && (r.supportedDeviceTypes ?? []).some((d) => d.identifier === t.identifier))
      .sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
    if (!runtimes.length) throw new Error(`No installed iOS runtime supports ${t.name}.`);
    const rt = runtimes[0].identifier;
    const name = `${DEDICATED_PREFIX} - ${t.name}`;
    const all = JSON.parse(sh("xcrun", ["simctl", "list", "devices", "--json"])).devices;
    for (const d of all[rt] ?? []) if (d.name === name && d.isAvailable !== false) return { udid: d.udid, name, created: false, state: d.state };
    const udid = sh("xcrun", ["simctl", "create", name, t.identifier, rt]).trim();
    return { udid, name, created: true, state: "Shutdown", runtime: runtimes[0].name };
  }
  const base = ios.device(like);
  const all = JSON.parse(sh("xcrun", ["simctl", "list", "devices", "--json"])).devices;
  const name = `${DEDICATED_PREFIX} - ${base.name}`;
  for (const d of all[base.runtime] ?? []) if (d.name === name && d.isAvailable !== false) return { udid: d.udid, name, created: false, state: d.state };
  if (!base.deviceTypeIdentifier) throw new Error("This simulator does not report its device type. Create one in Xcode named \"Gamedexy Map\" instead.");
  const udid = sh("xcrun", ["simctl", "create", name, base.deviceTypeIdentifier, base.runtime]).trim();
  return { udid, name, created: true, state: "Shutdown" };
}

/** Delete a simulator, only one this tool created. */
export function deleteDevice({ device }) {
  const d = ios.device(device);
  if (!isDedicated(d.name)) return { refused: `${d.name} was not created by Gamedexy. Only "${DEDICATED_PREFIX} ..." simulators can be deleted here.` };
  spawnSync("xcrun", ["simctl", "shutdown", d.udid]);
  sh("xcrun", ["simctl", "delete", d.udid]);
  return { deleted: d.udid, name: d.name };
}

// ---- fresh install ----------------------------------------------------------------

export function freshIos({ device, appId, app, dir }) {
  const d = ios.device(device);
  if (!app || !existsSync(app)) throw new Error("--fresh needs --app <path to the built .app> so the game can be reinstalled.");
  if (isDedicated(d.name)) {
    // Ours alone: wipe it all, Keychain included, so the first session is really the first.
    spawnSync("xcrun", ["simctl", "shutdown", d.udid]);
    sh("xcrun", ["simctl", "erase", d.udid]);
    sh("xcrun", ["simctl", "boot", d.udid]);
    sh("xcrun", ["simctl", "bootstatus", d.udid, "-b"]);
    sh("xcrun", ["simctl", "install", d.udid, app]);
    return { fresh: "whole simulator", keychain: "reset", device: d.udid, name: d.name };
  }
  // Shared simulator: only the game's own data, backed up first. Other apps and the Keychain stay.
  let backup = null;
  let container = null;
  try {
    container = ios.dataContainer(d.udid, appId);
  } catch {
    container = null; // not installed yet: nothing to keep
  }
  if (container && existsSync(container)) {
    backup = join(dir, "app-data-backup");
    mkdirSync(dir, { recursive: true });
    sh("ditto", [container, backup]);
  }
  ios.terminate(d.udid, appId);
  if (container) sh("xcrun", ["simctl", "uninstall", d.udid, appId]);
  sh("xcrun", ["simctl", "install", d.udid, app]);
  return {
    fresh: "game only",
    keychain: "kept",
    backup,
    warning:
      "The simulator Keychain survives a reinstall, so saved currency or sign-ins can carry over. For a first session that is truly fresh, use a dedicated simulator: gamedexy device create --platform ios --like " + d.udid,
    ...(backup ? { restore: `gamedexy map restore-data --dir ${dir}` } : {}),
  };
}

export function freshAndroid({ device, appId, dir, noBackup }) {
  android.device(device); // refuses anything that is not an emulator
  const backup = join(dir, "app-data-backup.tar");
  let saved = false;
  try {
    const tar = execFileSync("adb", ["-s", device, "exec-out", "run-as", appId, "tar", "cf", "-", "."], { maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (tar.length >= 1024) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(backup, tar);
      saved = true;
    }
  } catch {
    saved = false;
  }
  if (!saved && !noBackup) {
    return { refused: "Could not back up this game's data (run-as works on debug builds only), so nothing was cleared. Use a debug build, a fresh emulator, or pass --no-backup to clear it anyway." };
  }
  sh("adb", ["-s", device, "shell", "pm", "clear", appId]);
  return { fresh: "game only", backup: saved ? backup : null, ...(saved ? { restore: `gamedexy map restore-data --dir ${dir}` } : {}) };
}

export function restoreData({ run, dir }) {
  if (run.platform === "ios") {
    const backup = join(dir, "app-data-backup");
    if (!existsSync(backup)) return { refused: "No backup in this run folder." };
    ios.terminate(run.device, run.app_id);
    const container = ios.dataContainer(run.device, run.app_id);
    sh("ditto", [backup, container]);
    return { restored: true, into: container };
  }
  const backup = join(dir, "app-data-backup.tar");
  if (!existsSync(backup)) return { refused: "No backup in this run folder." };
  android.terminate(run.device, run.app_id);
  const tmp = "/data/local/tmp/gdx-restore.tar";
  sh("adb", ["-s", run.device, "push", backup, tmp]);
  sh("adb", ["-s", run.device, "shell", "run-as", run.app_id, "tar", "xf", tmp]);
  spawnSync("adb", ["-s", run.device, "shell", "rm", "-f", tmp]);
  return { restored: true };
}
