// Variant runs: the same screens again with the player's text size turned up, in another
// language, or on a small phone. Each later screenshot records the variant, so Gamedexy can
// compare a screen with itself under different conditions (D-090).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// iOS content size categories (Settings > Accessibility > Larger Text).
export const IOS_SIZES = [
  "extra-small", "small", "medium", "large", "extra-large", "extra-extra-large", "extra-extra-extra-large",
  "accessibility-medium", "accessibility-large", "accessibility-extra-large", "accessibility-extra-extra-large", "accessibility-extra-extra-extra-large",
];
const SIZE_ALIAS = { default: "large", largest: "accessibility-extra-extra-extra-large", large: "large", big: "accessibility-large" };
// Android font_scale for the same names.
const ANDROID_SCALE = { default: "1.0", large: "1.0", big: "1.5", largest: "2.0" };

/** "largest" -> the iOS category; unknown names throw with the list. */
export function textSizeOf(platform, name) {
  const n = String(name ?? "").toLowerCase();
  if (platform === "android") {
    if (ANDROID_SCALE[n]) return ANDROID_SCALE[n];
    if (/^\d(\.\d+)?$/.test(n) && Number(n) >= 0.85 && Number(n) <= 2) return n;
    throw new Error("--text-size on Android: default, big, largest, or a scale from 0.85 to 2.0");
  }
  const v = SIZE_ALIAS[n] ?? n;
  if (!IOS_SIZES.includes(v)) throw new Error(`--text-size must be default, big, largest or one of: ${IOS_SIZES.join(", ")}`);
  return v;
}
export const isDefaultSize = (platform, v) => (platform === "android" ? Number(v) === 1 : v === "large");

// Languages a variant run can switch to, with the locale the app should also get.
export const LANGS = {
  en: { apple: "en", locale: "en_US", android: "en-US", label: "English" },
  de: { apple: "de", locale: "de_DE", android: "de-DE", label: "German" },
  ja: { apple: "ja", locale: "ja_JP", android: "ja-JP", label: "Japanese" },
  fr: { apple: "fr", locale: "fr_FR", android: "fr-FR", label: "French" },
  es: { apple: "es", locale: "es_ES", android: "es-ES", label: "Spanish" },
  pt: { apple: "pt-BR", locale: "pt_BR", android: "pt-BR", label: "Portuguese (Brazil)" },
  it: { apple: "it", locale: "it_IT", android: "it-IT", label: "Italian" },
  ko: { apple: "ko", locale: "ko_KR", android: "ko-KR", label: "Korean" },
  zh: { apple: "zh-Hans", locale: "zh_CN", android: "zh-CN", label: "Chinese (Simplified)" },
};
export function langOf(code) {
  const c = String(code ?? "").toLowerCase();
  if (!LANGS[c]) throw new Error(`--lang must be one of: ${Object.keys(LANGS).join(", ")}, or default`);
  return c;
}

/** Launch arguments for the app's language on iOS (the app reads them as its preferred language). */
export function langArgs(platform, lang) {
  if (!lang || platform !== "ios") return [];
  const l = LANGS[lang];
  return ["-AppleLanguages", `(${l.apple})`, "-AppleLocale", l.locale];
}

// ---- device actions ------------------------------------------------------------

export function getTextSize(platform, udid) {
  try {
    if (platform === "android") return run("adb", ["-s", udid, "shell", "settings", "get", "system", "font_scale"]).trim() || "1.0";
    const out = run("xcrun", ["simctl", "ui", udid, "content_size"]).trim();
    return IOS_SIZES.includes(out) ? out : "large";
  } catch {
    return platform === "android" ? "1.0" : "large";
  }
}

export function setTextSize(platform, udid, value) {
  if (platform === "android") run("adb", ["-s", udid, "shell", "settings", "put", "system", "font_scale", value]);
  else run("xcrun", ["simctl", "ui", udid, "content_size", value]);
}

/** Android 13+: per-app language. Empty string resets to the system language. */
export function setAndroidAppLang(udid, pkg, lang) {
  const loc = lang ? LANGS[lang].android : "";
  const r = spawnSync("adb", ["-s", udid, "shell", "cmd", "locale", "set-app-locales", pkg, "--locales", loc], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("Per-app language needs Android 13 or later on the emulator.");
}

/** Boot a simulator if needed and install the build on it. */
export function prepareIosDevice(udid, app) {
  spawnSync("xcrun", ["simctl", "boot", udid], { stdio: "ignore" }); // already booted is fine
  spawnSync("xcrun", ["simctl", "bootstatus", udid, "-b"], { stdio: "ignore" });
  if (app) {
    if (!existsSync(app)) throw new Error(`No app at ${app}`);
    run("xcrun", ["simctl", "install", udid, app]);
  }
}

/** Small phones by point width: iPhone SE and mini sizes. Used to name a device switch. */
export const smallPhone = (widthPt) => widthPt > 0 && widthPt <= 375;
