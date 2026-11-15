// On-device text reading. Nothing leaves the machine, and nothing is downloaded.
// - macOS: Apple's Vision framework through a tiny Swift program compiled once into the user's
//   cache (needs Xcode command line tools, which every iOS developer has).
// - Windows 10 and 11: the OCR engine built into Windows (Windows.Media.Ocr), called from the
//   Windows PowerShell that ships with every copy of Windows.
// - Anywhere else: Tesseract, if the developer has it installed.
// - Android, as a last resort: the UI dump's text (see devices.mjs). Canvas games (Godot, Unity,
//   Cocos) draw their own buttons, so the dump is empty for them.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, encodePng, resize } from "./png.mjs";

const SWIFT = `import AppKit
import Foundation
import Vision
guard CommandLine.arguments.count == 2,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let w = Double(cg.width), h = Double(cg.height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg).perform([request])
var out: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    out.append(["text": top.string, "x0": b.minX * w, "y0": (1 - b.maxY) * h, "x1": b.maxX * w, "y1": (1 - b.minY) * h])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))
`;
const VERSION = "1";

export function cacheDir() {
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "gamedexy");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function visionAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function visionBinary() {
  const dir = cacheDir();
  const exe = join(dir, `ocr_vision_v${VERSION}`);
  if (existsSync(exe) && statSync(exe).size > 0) return exe;
  const src = join(dir, `ocr_vision_v${VERSION}.swift`);
  writeFileSync(src, SWIFT);
  execFileSync("xcrun", ["swiftc", "-O", src, "-o", exe], { stdio: "ignore" });
  return exe;
}

// ---- Windows ------------------------------------------------------------------------

// Windows PowerShell 5.1 (powershell.exe) can call the WinRT OCR engine; PowerShell 7 cannot.
// Lines come back with the union of their words' boxes, in image pixels.
const WIN_PS = `param([string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US')) }
if ($null -eq $engine) { Write-Output 'NO_ENGINE'; exit 3 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) {
  $words = @()
  foreach ($w in $line.Words) { $r = $w.BoundingRect; $words += @($r.X, $r.Y, ($r.X + $r.Width), ($r.Y + $r.Height)) }
  $lines += ,@($line.Text, $words)
}
ConvertTo-Json -InputObject @($lines) -Depth 4 -Compress
`;
const WIN_VERSION = "1";
// Windows' engine refuses images larger than this on either side (OcrEngine.MaxImageDimension).
const WIN_MAX = 2600;

let winCache;
export function windowsOcrAvailable() {
  if (process.platform !== "win32") return false;
  if (winCache !== undefined) return winCache;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null; [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages.Count"], { encoding: "utf8" });
  winCache = r.status === 0 && Number(String(r.stdout).trim()) > 0;
  return winCache;
}

/** Windows output (an array of [line text, [x0,y0,x1,y1, x0,y0,x1,y1, ...]]) to boxes, scaled by `k`. */
export function parseWindowsOcr(raw, k = 1) {
  const rows = JSON.parse(raw || "[]");
  const list = Array.isArray(rows[0]) || rows.length === 0 ? rows : [rows]; // one line comes back unwrapped
  const out = [];
  for (const [text, nums] of list) {
    const n = (nums ?? []).map(Number);
    if (!text || n.length < 4) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 3 < n.length; i += 4) {
      x0 = Math.min(x0, n[i]); y0 = Math.min(y0, n[i + 1]); x1 = Math.max(x1, n[i + 2]); y1 = Math.max(y1, n[i + 3]);
    }
    out.push({ text: String(text), x0: x0 * k, y0: y0 * k, x1: x1 * k, y1: y1 * k });
  }
  return out;
}

function windowsRead(pngPath) {
  const dir = cacheDir();
  const script = join(dir, `ocr_windows_v${WIN_VERSION}.ps1`);
  if (!existsSync(script)) writeFileSync(script, WIN_PS);
  // Downscale anything over the engine's limit, then scale the boxes back up.
  let path = pngPath;
  let k = 1;
  const img = decodePng(readFileSync(pngPath));
  if (Math.max(img.width, img.height) > WIN_MAX) {
    const w = Math.floor((img.width * WIN_MAX) / Math.max(img.width, img.height));
    k = img.width / w;
    path = join(tmpdir(), `gdx_ocr_${process.pid}.png`);
    writeFileSync(path, encodePng(resize(img, w)));
  }
  try {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", path], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return parseWindowsOcr(raw.trim(), k);
  } finally {
    if (path !== pngPath) rmSync(path, { force: true });
  }
}

// ---- Tesseract (optional, any OS) ------------------------------------------------------

/** Tesseract's TSV (word rows) to line boxes. */
export function parseTesseractTsv(tsv) {
  const lines = new Map();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5" || !c[11].trim() || Number(c[10]) < 30) continue;
    const key = `${c[2]}.${c[3]}.${c[4]}`;
    const [l, t, w, h] = [c[6], c[7], c[8], c[9]].map(Number);
    const cur = lines.get(key);
    if (!cur) lines.set(key, { text: c[11].trim(), x0: l, y0: t, x1: l + w, y1: t + h });
    else Object.assign(cur, { text: `${cur.text} ${c[11].trim()}`, x0: Math.min(cur.x0, l), y0: Math.min(cur.y0, t), x1: Math.max(cur.x1, l + w), y1: Math.max(cur.y1, t + h) });
  }
  return [...lines.values()];
}

let tessCache;
function tesseractAvailable() {
  if (tessCache === undefined) tessCache = spawnSync("tesseract", ["--version"], { stdio: "ignore" }).status === 0;
  return tessCache;
}

// ---- entry ------------------------------------------------------------------------------

/** The text reader this machine has, or null. */
export function readerName() {
  if (visionAvailable()) return "vision";
  if (windowsOcrAvailable()) return "windows";
  if (tesseractAvailable()) return "tesseract";
  return null;
}

/** Text boxes in image pixels: [{text, x0, y0, x1, y1}]. Empty when no reader is available. */
export function readText(pngPath) {
  const reader = readerName();
  if (reader === "vision") {
    const raw = execFileSync(visionBinary(), [pngPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(raw || "[]");
  }
  if (reader === "windows") return windowsRead(pngPath);
  if (reader === "tesseract") return parseTesseractTsv(execFileSync("tesseract", [pngPath, "stdout", "tsv"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }));
  return [];
}
