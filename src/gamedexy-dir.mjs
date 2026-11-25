// The `gamedexy/` dev folder (JT decision 2026-11-24): everything Gamedexy adds to a Godot game for
// capture lives in `res://gamedexy/` and never ships. Three pieces keep that true:
//
//   1. a tiny stub autoload OUTSIDE the folder (`res://gamedexy_stub.gd`). Godot registers autoloads in
//      project.godot, so an autoload whose file is excluded from an export makes the release build fail
//      at start. The stub ships, does nothing, and only in a debug build with the folder present loads
//      `res://gamedexy/capture.gd` and adds it as its child.
//   2. `gamedexy/*` in every export preset's exclude_filter (idempotent, existing filters kept).
//      A capture build needs the folder, so each preset also gets a copy named "<name> (Gamedexy capture)"
//      without that filter; capture builds are exported from the copy, release builds from the original.
//   3. a `.gdignore` in screenshot folders so Godot does not import captured PNGs.
//
// `gamedexy check-export` (export-check.mjs) is the proof: it fails when a build holds any of it.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const STUB_FILE = "gamedexy_stub.gd";
export const CAPTURE_FILE = "gamedexy/capture.gd";
export const LEGACY_CAPTURE_FILE = "gamedexy_capture.gd";
export const AUTOLOAD_LINE = `GamedexyCapture="*res://${STUB_FILE}"`;
export const LEGACY_AUTOLOAD_LINE = `GamedexyCapture="*res://${LEGACY_CAPTURE_FILE}"`;
export const EXCLUDE = "gamedexy/*";
export const CAPTURE_SUFFIX = " (Gamedexy capture)";

// Node and Object members every node has, stub or not: not "uses of the capture script" (cap.get_script(), cap.name, cap.queue_free()).
const BUILTINS = new Set([
  "get", "set", "call", "callv", "call_deferred", "set_deferred", "has_method", "get_indexed", "set_indexed", "get_method_list", "get_property_list",
  "get_script", "set_script", "get_class", "is_class", "get_instance_id", "is_instance_valid", "to_string", "free", "notification", "can_process",
  "has_signal", "connect", "disconnect", "is_connected", "emit_signal", "get_signal_list", "add_user_signal",
  "name", "owner", "process_mode", "process_priority", "scene_file_path", "unique_name_in_owner", "multiplayer",
  "get_name", "set_name", "get_path", "get_node", "get_node_or_null", "has_node", "find_child", "find_children", "get_parent", "get_children", "get_child", "get_child_count",
  "get_tree", "get_viewport", "get_window", "is_inside_tree", "is_node_ready", "is_queued_for_deletion", "queue_free", "add_child", "remove_child", "reparent",
  "add_to_group", "remove_from_group", "is_in_group", "get_groups", "set_process", "set_physics_process", "set_process_input", "set_process_mode", "is_processing",
]);
export const STUB_API = ["take_screen", "value", "open_screen", "seed_value"];

export const stubFile = () => `extends Node
## Gamedexy capture stub. It ships in every build and does nothing in a release build.
## Added by \`gamedexy capture init\`; the capture code itself is in res://gamedexy/ (never exported).
## Registered as the autoload GamedexyCapture, so game code keeps looking it up by name in every build:
##   var cap := get_node_or_null("/root/GamedexyCapture")
## In a debug build that still has res://gamedexy/capture.gd, this node swaps its own script for that file
## as it enters the tree, so the autoload IS the capture script (its _enter_tree does not run after the swap, so use _ready or _init): every method and property of it
## (take_screen(), value(), open_screen(), seed_value(), values, anything you add) is reached directly, as
## before the file moved into the folder. Anywhere else (release export, folder left out) the four methods
## below return their empty answer and a property read such as cap.get("values") gives null.

const REAL := "res://gamedexy/capture.gd"

func _enter_tree() -> void:
	if not OS.is_debug_build() or not ResourceLoader.exists(REAL):
		return
	var script = load(REAL)
	if script == null or not script.can_instantiate():
		return
	set_script(script)

func take_screen() -> String:
	return ""

func value(_key: String) -> String:
	return ""

func open_screen(_key: String) -> bool:
	return false

func seed_value() -> int:
	return -1
`;

/**
 * Where game code reaches the GamedexyCapture autoload for something the release stub does not answer: a property
 * (cap.values, cap.get("values")) or a method other than the four the stub has. Those work in a debug build (the
 * node is the capture script) but give null or an error in a release export, so the code must tolerate that.
 * Looks at .gd files outside gamedexy/ and the stub itself.
 */
export function autoloadUses(src) {
  const out = [];
  const skip = new Set([STUB_FILE, LEGACY_CAPTURE_FILE]);
  const walkDir = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(src, abs).split(sep).join("/");
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP.has(e.name) && depth < 8) walkDir(abs, depth + 1);
      } else if (e.name.endsWith(".gd") && !skip.has(rel)) {
        let text;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        if (!text.includes("GamedexyCapture")) continue;
        const vars = new Set(["GamedexyCapture"]);
        for (const m of text.matchAll(/\b(?:var|const)\s+(\w+)\s*(?::\s*[\w.]+\s*)?:?=[^\n]*GamedexyCapture/g)) vars.add(m[1]);
        text.split("\n").forEach((line, i) => {
          const code = line.replace(/#.*$/, "");
          for (const v of vars) {
            for (const m of code.matchAll(new RegExp(`\\b${v}\\.(?:(get|set|call|callv|has_method|get_indexed)\\(\\s*"(\\w+)"|(\\w+))`, "g"))) {
              const member = m[2] ?? m[3];
              if (!member || STUB_API.includes(member)) continue;
              if (BUILTINS.has(member)) continue; // Node/Object API, present on the release stub too
              out.push({ file: rel, line: i + 1, member, how: m[1] ? `${m[1]}("${member}")` : `.${member}` });
            }
          }
        });
      }
    }
  };
  walkDir(src, 0);
  return out;
}

// ---- export_presets.cfg ---------------------------------------------------------------------------------------

const HEADER = /^\[preset\.(\d+)(\.options)?\]\s*$/;
const kv = (line, key) => {
  const m = new RegExp(`^${key}\\s*=\\s*"(.*)"\\s*$`).exec(line);
  return m ? m[1] : null;
};
const splitFilter = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
const hasExclude = (items) => items.some((i) => i === EXCLUDE || i === "gamedexy/**");

/** Group the lines of an export_presets.cfg into presets: { n, main: [start, end), options: [start, end) | null }. */
function presetsOf(lines) {
  const byN = new Map();
  let cur = null;
  for (let i = 0; i <= lines.length; i++) {
    const m = i < lines.length ? HEADER.exec(lines[i].trim()) : null;
    const isHeader = i === lines.length || /^\[.+\]\s*$/.test(lines[i].trim());
    if (cur && isHeader) {
      cur.range[1] = i;
      cur = null;
    }
    if (m) {
      const n = Number(m[1]);
      const p = byN.get(n) ?? { n, main: null, options: null };
      const range = [i, lines.length];
      if (m[2]) p.options = range;
      else p.main = range;
      byN.set(n, p);
      cur = { range };
    }
  }
  return [...byN.values()].filter((p) => p.main).sort((a, b) => a.n - b.n);
}

const lineIdx = (lines, [start, end], key) => {
  for (let i = start + 1; i < end; i++) if (new RegExp(`^${key}\\s*=`).test(lines[i])) return i;
  return -1;
};

const trimEnd = (arr) => {
  const a = [...arr];
  while (a.length && a.at(-1).trim() === "") a.pop();
  return a;
};
const blanksAfter = (arr) => arr.length - trimEnd(arr).length;
// Only phone presets get a capture copy: that is where capture builds are made (emulator and simulator).
const COPY_PLATFORMS = new Set(["iOS", "Android"]);

/** The capture copy of preset `p` as index `n`: not runnable, no gamedexy/* filter, its own output folder, options carried over. */
function desiredCopy(lines, p, n, name, items) {
  const block = trimEnd(lines.slice(p.main[0], p.main[1]));
  const opts = p.options ? trimEnd(lines.slice(p.options[0], p.options[1])) : [];
  const rewrite = (l, key, value) => (new RegExp(`^${key}\\s*=`).test(l) ? `${key}=${value}` : l);
  const kept = items.filter((i) => i !== EXCLUDE && i !== "gamedexy/**");
  const exportPath = kv(block.find((l) => /^export_path\s*=/.test(l)) ?? "", "export_path");
  const newPath = exportPath ? `build/gamedexy-capture/${exportPath.split(/[\\/]/).pop()}` : null;
  const main = block.map((l, i) => {
    if (i === 0) return `[preset.${n}]`;
    let o = l;
    o = rewrite(o, "name", `"${name}${CAPTURE_SUFFIX}"`);
    o = rewrite(o, "runnable", "false");
    o = rewrite(o, "exclude_filter", `"${kept.join(",")}"`);
    if (newPath) o = rewrite(o, "export_path", `"${newPath}"`);
    return o;
  });
  return { main, options: opts.map((l, i) => (i === 0 ? `[preset.${n}.options]` : l)), newPath };
}

/**
 * Pure planner for export_presets.cfg text: `gamedexy/*` in every preset's exclude_filter, and for each iOS or
 * Android preset a "<name> (Gamedexy capture)" copy that keeps the folder in. A copy that already exists is
 * refreshed from its original (it goes stale when the original changes), so re-running keeps it current.
 */
export function planExportPresets(raw) {
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const presets = presetsOf(lines);
  const nameOf = (p) => {
    const i = lineIdx(lines, p.main, "name");
    return i >= 0 ? kv(lines[i], "name") : null;
  };
  const platformOf = (p) => {
    const i = lineIdx(lines, p.main, "platform");
    return i >= 0 ? kv(lines[i], "platform") : null;
  };
  const byName = new Map(presets.map((p) => [nameOf(p), p]));
  const ops = []; // { start, end, repl }: replace lines [start, end) with repl
  const diff = [];
  const excluded = [];
  const created = [];
  const refreshed = [];
  let next = (presets.at(-1)?.n ?? -1) + 1;
  const appended = [];

  for (const p of presets) {
    const name = nameOf(p);
    if (name?.endsWith(CAPTURE_SUFFIX)) continue;
    const head = `@@ export_presets.cfg [preset.${p.n}]${name ? ` "${name}"` : ""} @@`;
    const exIdx = lineIdx(lines, p.main, "exclude_filter");
    const items = exIdx >= 0 ? splitFilter(kv(lines[exIdx], "exclude_filter") ?? "") : [];
    if (!hasExclude(items)) {
      const after = `exclude_filter="${[...items, EXCLUDE].join(",")}"`;
      if (exIdx >= 0) {
        ops.push({ start: exIdx, end: exIdx + 1, repl: [after] });
        diff.push(head, `-${lines[exIdx]}`, `+${after}`);
      } else {
        const anchor = [lineIdx(lines, p.main, "include_filter"), lineIdx(lines, p.main, "export_filter"), p.main[0]].find((i) => i >= 0);
        ops.push({ start: anchor + 1, end: anchor + 1, repl: [after] });
        diff.push(head, `+${after}`);
      }
      excluded.push(name ?? `preset.${p.n}`);
    }
    if (!name || !COPY_PLATFORMS.has(platformOf(p) ?? "")) continue;
    const have = byName.get(name + CAPTURE_SUFFIX);
    if (!have) {
      const n = next++;
      const c = desiredCopy(lines, p, n, name, items);
      appended.push(...c.main, "", ...(c.options.length ? [...c.options, ""] : []));
      created.push(name + CAPTURE_SUFFIX);
      diff.push(
        `@@ export_presets.cfg (end) @@`,
        `+[preset.${n}]  copy of [preset.${p.n}] "${name}" for capture builds: name="${name}${CAPTURE_SUFFIX}", runnable=false, exclude_filter without ${EXCLUDE}${c.newPath ? `, export_path="${c.newPath}"` : ""}; its options are copied as [preset.${n}.options]`,
      );
      continue;
    }
    // Existing copy: bring it back in line with its original (same index, same place in the file).
    const c = desiredCopy(lines, p, have.n, name, items);
    const curMain = trimEnd(lines.slice(have.main[0], have.main[1]));
    const curOpts = have.options ? trimEnd(lines.slice(have.options[0], have.options[1])) : [];
    const sameMain = curMain.length === c.main.length && curMain.every((l, i) => l === c.main[i]);
    const sameOpts = curOpts.length === c.options.length && curOpts.every((l, i) => l === c.options[i]);
    if (sameMain && sameOpts) continue;
    const changed = [];
    const show = (cur, want) => {
      for (let i = 0; i < Math.max(cur.length, want.length) && changed.length < 24; i++) if (cur[i] !== want[i]) changed.push(...(cur[i] !== undefined ? [`-${cur[i]}`] : []), ...(want[i] !== undefined ? [`+${want[i]}`] : []));
    };
    show(curMain, c.main);
    show(curOpts, c.options);
    diff.push(`@@ export_presets.cfg [preset.${have.n}] "${name}${CAPTURE_SUFFIX}" refreshed from [preset.${p.n}] "${name}" @@`, ...changed);
    if (!sameMain) ops.push({ start: have.main[0], end: have.main[1], repl: [...c.main, ...Array(Math.max(1, blanksAfter(lines.slice(have.main[0], have.main[1])))).fill("")] });
    if (have.options && !sameOpts) ops.push({ start: have.options[0], end: have.options[1], repl: [...c.options, ...Array(Math.max(1, blanksAfter(lines.slice(have.options[0], have.options[1])))).fill("")] });
    refreshed.push(name + CAPTURE_SUFFIX);
  }

  const out = [...lines];
  for (const op of [...ops].sort((a, b) => b.start - a.start || b.end - a.end)) out.splice(op.start, op.end - op.start, ...op.repl);
  let text = out.join(nl);
  if (appended.length) {
    const sep = text.endsWith(nl) ? nl : nl + nl;
    text = `${text}${sep}${appended.join(nl)}`.replace(new RegExp(`(${nl})+$`), nl);
  }
  return { text, changed: text !== raw, excluded, created, refreshed, diff, presets: presets.length };
}

/**
 * Plan (and, unless dryRun, write) the export_presets.cfg changes. Idempotent: a second run reports
 * `already_set` and changes nothing.
 */
export function wireExportPresets(src, { dryRun = false } = {}) {
  const file = join(src, "export_presets.cfg");
  if (!existsSync(file)) {
    return { file: "export_presets.cfg", status: "not_found", note: `No export_presets.cfg in ${src}. Before the first export, add ${EXCLUDE} to the exclude filter of every preset (Project > Export > Resources > Filters to exclude), so the folder never ships.` };
  }
  const raw = readFileSync(file, "utf8");
  const plan = planExportPresets(raw);
  if (!plan.changed) return { file: "export_presets.cfg", status: "already_set", presets: plan.presets };
  if (!dryRun) writeFileSync(file, plan.text);
  return {
    file: "export_presets.cfg",
    status: dryRun ? "would_change" : "changed",
    excluded_in: plan.excluded,
    capture_presets: plan.created,
    ...(plan.refreshed.length ? { refreshed: plan.refreshed } : {}),
    diff: plan.diff,
  };
}

/** Which presets keep `gamedexy/*` out of exports, and which capture copies are stale (for doctor). */
export function exportFilterState(src) {
  const file = join(src, "export_presets.cfg");
  if (!existsSync(file)) return null;
  const plan = planExportPresets(readFileSync(file, "utf8"));
  return { missing: plan.excluded, stale: plan.refreshed, total: countOriginals(file) };
}

function countOriginals(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  return presetsOf(lines).filter((p) => {
    const i = lineIdx(lines, p.main, "name");
    return !(i >= 0 && kv(lines[i], "name")?.endsWith(CAPTURE_SUFFIX));
  }).length;
}

// ---- .gdignore -----------------------------------------------------------------------------------------------

const SHOT_DIRS = /^(screenshots?|shots)$/i;
const SKIP = new Set([".git", ".godot", ".import", "node_modules", "build", "builds", "export", "exports", "gamedexy", "addons"]);

/** Screenshot folders in the repo (top three levels), as repo-relative paths. */
export function screenshotDirs(src) {
  const found = [];
  const walkDir = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (SHOT_DIRS.test(e.name)) found.push(relative(src, abs).split(sep).join("/"));
      if (depth < 3) walkDir(abs, depth + 1);
    }
  };
  walkDir(src, 1);
  return found.sort();
}

/**
 * A `.gdignore` in each screenshot folder, so Godot stops importing captured PNGs (and listing
 * them in the editor). A folder that already has one is left alone.
 */
export function addGdignore(src, { dryRun = false } = {}) {
  const added = [];
  const had = [];
  for (const d of screenshotDirs(src)) {
    const file = join(src, d, ".gdignore");
    if (existsSync(file)) {
      had.push(`${d}/.gdignore`);
      continue;
    }
    if (!dryRun) writeFileSync(file, "");
    added.push(`${d}/.gdignore`);
  }
  return { status: added.length ? (dryRun ? "would_add" : "added") : "already_set", added, ...(had.length ? { already_there: had } : {}) };
}

export const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
