// Level and stage lists for `gamedexy scan` (Slice 26 Part G, PR 1b). Plain code, no AI.
// Three shapes cover most mobile games:
//   1. a list literal of level values in code: `static let all: [Stage] = [Stage(...), Stage(...)]`,
//      `listOf(Level(...), ...)`, `new Level[] { new Level(...), ... }`, `[Level.new(...), ...]`
//   2. an enum of levels: `enum World { case meadow, marsh }`, `enum class Stage { A, B }`
//   3. level files: a `levels/` folder of scenes or data files, or scenes named `Level01`, `stage_2`
// Each list gets its count, order, names and the unlock rule when a labelled field says it
// (`unlockScore: 2500`). Names and numbers only: no code leaves the machine.
import { basename, extname } from "node:path";

/** A type name that holds levels: Stage, Level, World, Chapter (with an optional prefix or Data/Def suffix). */
export const LEVEL_TYPE = /^(?:[A-Z][A-Za-z0-9]*?)?(Stage|Level|World|Chapter|Zone|Island|Episode|Region|Area)(?:Def|Data|Info|Config|Spec|Definition|Model)?$/;
const NOT_LEVEL = /^(LevelUp|LevelUpView|XPLevel|PlayerLevel|AccountLevel|UserLevel|AudioLevel|VolumeLevel|LogLevel|ZoomLevel|BatteryLevel|CompressionLevel|DebugLevel|SafeArea|AdArea|TextArea|TapArea|HitArea)$/;
const LEVEL_DIR = /^(levels?|stages?|worlds?|chapters?|episodes?|maps?)$/i;
const LEVEL_FILE = /^(level|stage|world|chapter|episode|lvl)[ _-]?(\d{1,4})$/i;
const LEVEL_DATA_EXT = new Set([".tscn", ".unity", ".json", ".tres", ".asset", ".txt", ".lvl", ".yaml", ".yml", ".csv", ".xml", ".prefab", ".tmx", ".ldtk", ".plist"]);
const DECL_BEFORE = /\b(struct|class|enum|record|interface|protocol|func|fun|init|extension|typealias|object|data|sealed|static\s+func)\s*$/;
const UNLOCK_FIELD = /\b(\w*(?:[Uu]nlock|[Rr]equire|[Nn]eed|[Ss]tars|[Cc]ost|[Mm]inScore|[Gg]ate)\w*)\s*[:=]\s*(-?\d[\d_]*)/;
const NAME_FIELD = /\b(?:name|title|displayName|label|levelName|stageName)\s*[:=]\s*(?:@)?"([^"\n]{1,60})"/;
const ID_FIELD = /\b(?:id|index|number|num|order|levelId|stageId)\s*[:=]\s*(\d{1,5})\b/;

const slug = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40);
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Index of the `)` closing the `(` at `open` (strings skipped), or -1. */
function closeParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

function itemFrom(args, i) {
  const name = args.match(NAME_FIELD)?.[1] ?? args.match(/"([^"\n]{1,60})"/)?.[1] ?? null;
  const id = args.match(ID_FIELD);
  const unlock = args.match(UNLOCK_FIELD);
  return {
    key: slug(name ?? `${i + 1}`) || String(i + 1),
    name,
    id: id ? Number(id[1]) : i,
    ...(unlock ? { unlock: { field: unlock[1], value: Number(unlock[2].replace(/_/g, "")) } } : {}),
  };
}

/** Shape 1: two or more calls of a level type in a row, separated only by commas (a list literal). */
function codeLists(f) {
  const text = f.text;
  const out = [];
  const calls = [];
  const re = /\b(?:new\s+)?([A-Z][A-Za-z0-9]*)(?:\.new)?\s*\(/g;
  for (const m of text.matchAll(re)) {
    const type = m[1];
    if (!LEVEL_TYPE.test(type) || NOT_LEVEL.test(type)) continue;
    if (DECL_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = closeParen(text, open);
    if (close < 0) continue;
    calls.push({ type, start: m.index, open, close });
  }
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const items = run.map((c, i) => itemFrom(text.slice(c.open + 1, c.close), i));
      if (items.some((it) => it.name)) out.push({ kind: "list", type: run[0].type, where: `${f.rel}:${lineAt(text, run[0].start)}`, items });
    }
    run = [];
  };
  for (const c of calls) {
    const prev = run.at(-1);
    if (prev && prev.type === c.type && /^\s*,\s*$/.test(text.slice(prev.close + 1, c.start))) run.push(c);
    else {
      flush();
      run = [c];
    }
  }
  flush();
  return out;
}

/** Shape 2: an enum whose name says it holds levels. */
function enums(f) {
  const out = [];
  for (const m of f.text.matchAll(/\benum\s+(?:class\s+)?([A-Z][A-Za-z0-9]*)[^{\n]*\{/g)) {
    const type = m[1];
    if (!LEVEL_TYPE.test(type) || NOT_LEVEL.test(type)) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < f.text.length; i++) {
      if (f.text[i] === "{") depth++;
      else if (f.text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    const body = f.text.slice(open + 1, end);
    let names = [];
    if (f.ext === ".swift") {
      // Top-level `case a, b = "x"` lines only; a `switch` inside a computed property also says `case`.
      for (const c of body.matchAll(/^\s*case\s+([^\n]+)/gm)) {
        const before = body.slice(0, c.index);
        if ((before.match(/\{/g)?.length ?? 0) !== (before.match(/\}/g)?.length ?? 0)) continue;
        for (const part of c[1].split(",")) {
          const n = part.trim().match(/^`?([A-Za-z_]\w*)`?/);
          if (n) names.push(n[1]);
        }
      }
    } else {
      const head = body.split(";")[0];
      names = head.split(",").map((s) => s.trim().match(/^([A-Za-z_]\w*)/)?.[1]).filter(Boolean);
    }
    names = names.filter((n) => !/^(none|unknown|count|max|min|all)$/i.test(n));
    if (names.length >= 2) out.push({ kind: "enum", type, where: `${f.rel}:${lineAt(f.text, m.index)}`, items: names.map((n, i) => ({ key: slug(n), name: n, id: i })) });
  }
  return out;
}

/** Shape 3: level files, in a levels/ folder or named Level01, stage_2. */
function levelFiles(all) {
  const groups = new Map();
  for (const f of all) {
    if (f.name.endsWith(".meta") || f.name.endsWith(".import") || f.name.endsWith(".uid")) continue;
    const ext = extname(f.name).toLowerCase();
    if (!LEVEL_DATA_EXT.has(ext)) continue;
    const parts = f.rel.split("/");
    const dir = parts.slice(0, -1).join("/");
    const stem = basename(f.name, extname(f.name));
    const inDir = parts.length >= 2 && LEVEL_DIR.test(parts.at(-2));
    const named = LEVEL_FILE.test(stem);
    if (!inDir && !named) continue;
    const k = `${dir}|${ext}`;
    if (!groups.has(k)) groups.set(k, { dir, ext, files: [] });
    groups.get(k).files.push(stem);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.files.length < 2) continue;
    const files = [...new Set(g.files)].sort(natural);
    out.push({
      kind: "files",
      type: g.ext.slice(1),
      where: g.dir || ".",
      items: files.map((s, i) => ({ key: slug(s) || String(i + 1), name: s, id: i })),
    });
  }
  return out;
}

/** Every level list the scan can see, best first (code lists, then enums, then files; longer first). */
export function findLevels(files, all) {
  const code = files.filter((f) => [".swift", ".kt", ".java", ".cs", ".gd"].includes(f.ext) && f.text);
  const found = [...code.flatMap(codeLists), ...code.flatMap(enums), ...levelFiles(all)];
  const rank = { list: 0, enum: 1, files: 2 };
  found.sort((a, b) => rank[a.kind] - rank[b.kind] || b.items.length - a.items.length);
  // The same levels seen twice (an enum and its list, or a file per level beside the list): keep the first.
  const seen = new Set();
  return found
    .filter((l) => {
      const sig = `${l.items.length}:${l.items.map((i) => i.key).join(",")}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    })
    .slice(0, 6)
    .map((l) => {
      const fields = [...new Set(l.items.map((i) => i.unlock?.field).filter(Boolean))];
      return {
        type: l.type,
        kind: l.kind,
        where: l.where,
        count: l.items.length,
        unlock_rule: fields.length === 1 ? fields[0] : fields.length ? fields.join(" / ") : null,
        param: slug(l.kind === "files" ? "level" : l.type.replace(/(Def|Data|Info|Config|Spec|Definition|Model)$/, "")).split("_").pop() || "level",
        items: l.items,
      };
    });
}
