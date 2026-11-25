// Godot 4 screens that are built in GDScript instead of in .tscn scenes (plain static reading, no
// AI, nothing uploaded). Four signals, each with a `why` and a `sure` flag:
//   1. a script that `extends` a UI node, is made with `.new()` and added to the tree
//   2. a function that switches screens by a string or enum (`match _active_sheet:` with one
//      builder per arm, or `enum Screen {HOME, SHOP}` plus a state variable)
//   3. functions named `show_*` / `open_*` / `_build_*_modal|_panel|_sheet|...`
//   4. popups made in code (`AcceptDialog.new()` and friends)
// Every screen found this way carries `code`: how a debug build can open it (the class's script
// path, the call to make, the arguments). `gamedexy capture init` turns that into the capture list.
import { basename } from "node:path";

const UI_BASE = /^(Control|CanvasLayer|Panel|PanelContainer|MarginContainer|VBoxContainer|HBoxContainer|CenterContainer|ScrollContainer|Container|BoxContainer|GridContainer|ColorRect|TextureRect|Window|Popup|PopupPanel|PopupMenu|AcceptDialog|ConfirmationDialog|FileDialog)$/;
// A screen word has to END the class name: ShopItemCard, SettingsToggle and PageDots are widgets, ShopScreen is not.
const UI_NAME = /(Screen|Modal|Popup|Dialog|Sheet|Overlay|Panel|Menu|Hub|Hud|HUD|Shop|Store|Page|View|Window|Settings|Pause|Result|Summary|Guide|Lobby|Title)s?$/;
// The unambiguous ones: a class with one of these endings is a screen without any other sign. The rest also need children (a dispatch or openers).
const STRONG_NAME = /(Screen|Modal|Popup|Dialog|Sheet|Overlay|Page|Lobby|Hub)s?$/;
// Godot node types a screen can derive from. Resource, RefCounted and Object data classes are not screens, whatever they are called.
const NODE_BASE = /^(Node|Node2D|Node3D|CanvasItem|CanvasLayer|Control|Window|Viewport|SubViewport)$|(2D|3D)$|(Container|Button|Label|Rect|Panel|Dialog|Popup|PopupMenu|Menu|Bar|Edit|Tree|List)$/;
const WORLD_NAME = /^(World|Arena|Level|Stage|Battle|Board|Game|Map)(Controller|Scene|Screen|Root|Main|View)?$|(Screen|Scene)$/;
const OVERLAY_NAME = /(Modal|Popup|Dialog|Sheet|Overlay|Hud|HUD)/;
const POPUP_NEW = /\b(AcceptDialog|ConfirmationDialog|PopupPanel|PopupMenu|Popup|FileDialog)\.new\s*\(\s*\)/g;
const ENUM_NAME = /Screen|Page|View|Menu|Panel|Tab|State|Mode/;
const ENUM_STRONG = /Screen|Page|View|Menu/;
const SCREEN_WORD = /^(HOME|MENU|MAIN_MENU|TITLE|SHOP|STORE|SETTINGS|OPTIONS|PAUSE|PAUSED|RESULTS?|WIN|LOSE|GAME_?OVER|MAP|WORLD_MAP|STAGES?|LEVELS?|PLAY|UPGRADES?|FORGE|CHESTS?|INVENTORY|PROFILE|LOBBY|LOADING|SPLASH|CREDITS|LEADERBOARD|QUESTS?|MISSIONS?|GOALS|CAMP|BATTLE|ARENA|TUTORIAL|REWARDS?|OFFERS?|BOOT|INTRO|SKINS?|GUIDE)$/;
const BUILDER_CALL = /\b((?:_(?:build|show|open|populate|render|make|create)_\w+)|(?:build|show|open)_\w+)\s*\(/;
const OPENER_NAME = /^(?:show|open|popup)_(\w+)$/;
const WORLD_OPENER = /^(?:show|open|popup|start|begin|enter)_(\w+)$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_LINE = 2000; // longer lines (minified data) are cut: the line regexes below are quadratic on them
const BUILD_SURFACE = /^_build_(\w+?)_(screen|panel|modal|sheet|popup|overlay|menu|page|dialog)$/;

const width = (s) => {
  let w = 0;
  for (const c of s) {
    if (c === "\t") w += 4;
    else if (c === " ") w += 1;
    else break;
  }
  return w;
};

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) (out.push(cur), (cur = ""));
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseParams(raw) {
  return splitTop(raw).map((p) => {
    const m = p.trim().match(/^(\w+)\s*(?::\s*([\w.]+(?:\[[^\]]*\])?))?\s*(?::?=\s*(.+))?$/);
    return m ? { name: m[1], type: m[2] ?? null, hasDefault: m[3] != null } : { name: p.trim(), type: null, hasDefault: false };
  });
}

function functionsOf(lines) {
  const fns = [];
  let cur = null;
  lines.forEach((ln, i) => {
    const m = ln.match(/^(?:static\s+)?func\s+(\w+)\s*\(([^)]*)\)/);
    if (m) {
      if (cur) cur.end = i - 1;
      cur = { name: m[1], params: parseParams(m[2]), start: i, end: lines.length - 1 };
      fns.push(cur);
    } else if (cur && ln.length && !/^\s/.test(ln)) {
      cur.end = i - 1;
      cur = null;
    }
  });
  return fns;
}

/** `match X:` blocks inside lines [from, to]: their arms and each arm's text. */
function matchBlocks(lines, from, to) {
  const out = [];
  for (let i = from; i <= to; i++) {
    const m = lines[i].match(/^(\s*)match\s+(.+?)\s*:\s*$/);
    if (!m) continue;
    const base = width(m[1]);
    const arms = [];
    let armW = null;
    for (let j = i + 1; j <= to; j++) {
      const ln = lines[j];
      if (!ln.trim()) continue;
      const w = width(ln);
      if (w <= base) break;
      if (armW == null) armW = w;
      if (w === armW) {
        const a = ln.trim().match(/^(&?"[^"]*"|[A-Za-z_][\w.]*)\s*:(.*)$/);
        if (a) arms.push({ label: a[1].replace(/^&?"|"$/g, ""), raw: a[1], line: j, body: [a[2]] });
        else arms.push({ label: null, raw: null, line: j, body: [ln] });
      } else if (arms.length) arms[arms.length - 1].body.push(ln);
    }
    out.push({ expr: m[2].trim(), line: i, arms });
  }
  return out;
}

/** A value that is safe to pass for a parameter of type `t`; undefined when there is none (objects, typed arrays). */
const gdDefault = (t) => {
  if (!t || t === "Variant") return "null";
  if (t === "String" || t === "StringName") return '""';
  if (t === "int") return "0";
  if (t === "float") return "0.0";
  if (t === "bool") return "false";
  if (t === "Array") return "[]";
  if (t === "Dictionary") return "{}";
  if (t === "Vector2") return "Vector2.ZERO";
  if (t === "Vector2i") return "Vector2i.ZERO";
  if (t === "Vector3") return "Vector3.ZERO";
  if (t === "Color") return "Color.WHITE";
  if (t === "NodePath") return 'NodePath("")';
  if (t === "Callable") return "Callable()";
  return undefined;
};

/**
 * Arguments to call `fn` with: the given ones by position, defaults for the rest of the required ones.
 * `unsafe` names a required parameter with no safe default (an object): there is no opener for it.
 */
function argsFor(fn, given = {}) {
  const need = fn.params.findLastIndex((p, i) => !p.hasDefault || i in given) + 1;
  let guessed = false;
  let unsafe = null;
  const args = fn.params.slice(0, need).map((p, i) => {
    if (i in given) return given[i];
    guessed = true;
    const d = gdDefault(p.type);
    if (d === undefined) {
      unsafe ??= p.name;
      return "null";
    }
    return d;
  });
  return { args, guessed, unsafe };
}

const gdStr = (s) => JSON.stringify(s);

/**
 * ctx: { addScreen, addEdge, lineAt, screenKey, isTest(rel), scriptScenes: Map<path, keys[]>, ownersOf(rel) }
 * Adds screens, edges and `unsure` rows to `r`. One script that cannot be read never stops the rest.
 */
export function scanGodotCode(r, files, ctx) {
  const { addEdge, lineAt, screenKey } = ctx;
  // A guessed argument is a guess: such a screen is never sure.
  const addScreen = (rr, s) => ctx.addScreen(rr, s.code?.guessed_args && s.sure ? { ...s, sure: false } : s);
  // Keys that already belong to a screen from another source (scenes). A code-built screen never takes one over.
  const taken = new Set(r.screens.map((x) => x.key));
  const fresh = (key, where, name) => {
    if (!taken.has(key)) return key;
    let k = `${key}_code`;
    for (let n = 2; taken.has(k); n++) k = `${key}_code${n}`;
    r.unsure.push({ where, name: k, reason: `built in code, but "${key}" is already a screen from a scene; listed as "${k}" so the scene keeps its key` });
    return k;
  };
  const skip = (where, name, e) => r.unsure.push({ where, name, reason: `could not read this script (${String(e?.message ?? e).slice(0, 80)}); read it by hand` });
  const gd = files.filter((f) => f.ext === ".gd" && !ctx.isTest(f.rel));
  const info = new Map(); // rel -> class info
  for (const f of gd) {
    try {
      const text = f.text;
      const lines = text.split("\n").map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));
      const cn = text.match(/^class_name\s+(\w+)/m)?.[1] ?? null;
      const ext = text.match(/^(?:class_name\s+\w+\s+)?extends\s+(\w+)/m)?.[1] ?? null;
      const sceneKeys = ctx.scriptScenes.get(f.rel) ?? [];
      info.set(f.rel, { f, text, lines, className: cn, base: ext, sceneKeys, fns: functionsOf(lines), uiBase: Boolean(ext && UI_BASE.test(ext)) });
    } catch (e) {
      skip(`${f.rel}:1`, basename(f.rel), e);
    }
  }
  const byClass = new Map([...info.values()].filter((c) => c.className).map((c) => [c.className, c]));
  const aliasOf = new Map(); // const Foo := preload("res://x.gd") / var Foo = load("res://x.gd") -> class info
  for (const c of info.values())
    for (const m of c.text.matchAll(/^\s*(?:const|var)\s+(\w+)\s*(?::\s*\w+\s*)?:?=\s*(?:preload|load)\s*\(\s*"res:\/\/([^"]+\.gd)"\s*\)/gm)) {
      const target = info.get(m[2]);
      if (target) aliasOf.set(`${c.f.rel}:${m[1]}`, target);
    }
  /** The Godot type a class finally derives from (through other scripts' class_name). */
  const rootBase = (c, depth = 0) => {
    const p = c.base && depth < 8 ? byClass.get(c.base) : null;
    return p ? rootBase(p, depth + 1) : c.base;
  };

  // ---- 1. UI scripts made with .new() ---------------------------------------------------
  for (const c of info.values()) {
    // A class that is a scene's script is that scene; any other class must not reuse a scene's key.
    c.key = c.sceneKeys[0] ?? fresh(screenKey(c.className ?? basename(c.f.rel, ".gd")), `${c.f.rel}:1`);
    c.initNeeds = c.fns.find((g) => g.name === "_init" && g.params.some((p) => !p.hasDefault)) ?? null;
    const root = rootBase(c);
    c.isNode = Boolean(root && (UI_BASE.test(root) || NODE_BASE.test(root)));
    const uiName = Boolean(c.className && UI_NAME.test(c.className));
    const worldName = Boolean(c.className && WORLD_NAME.test(c.className));
    const enumHint = c.uiBase && /^enum\s+\w*(Screen|Page|View|Menu)\w*\s*\{/m.test(c.text);
    // Only Node-derived scripts are screens (a Resource called Level is data), and a scene script already is one.
    c.screenLike = Boolean(c.isNode && ((uiName && c.uiBase) || worldName || enumHint) && !c.sceneKeys.length);
    c.makers = []; // files that create it
    c.armOf = new Map(); // builder function -> the screen it builds
  }
  // Who makes whom: one pass over every file's `X.new(` (a class name, or an alias of a preloaded script).
  const byName = new Map();
  for (const c of info.values()) if (c.className) byName.set(c.className, [...(byName.get(c.className) ?? []), c]);
  for (const o of info.values()) {
    try {
      const seen = new Set();
      for (const m of o.text.matchAll(/\b(\w+)\.new\s*\(/g)) {
        const targets = [...(byName.get(m[1]) ?? []), ...(aliasOf.has(`${o.f.rel}:${m[1]}`) ? [aliasOf.get(`${o.f.rel}:${m[1]}`)] : [])];
        for (const c of targets) {
          if (c === o || seen.has(c)) continue;
          seen.add(c);
          o.adds ??= /\badd_child\s*\(|\badd_sibling\s*\(/.test(o.text);
          c.makers.push({ file: o, idx: m.index, added: o.adds });
        }
      }
    } catch (e) {
      skip(`${o.f.rel}:1`, basename(o.f.rel), e);
    }
  }

  // Inline `preload("res://x.gd").new()` / `load("res://x.gd").new()`, and scripts registered as autoloads in project.godot.
  for (const o of info.values()) {
    for (const m of o.text.matchAll(/\b(?:preload|load)\s*\(\s*"res:\/\/([^"]+\.gd)"\s*\)\s*\.new\s*\(/g)) {
      const c = info.get(m[1]);
      if (!c || c === o) continue;
      o.adds ??= /\badd_child\s*\(|\badd_sibling\s*\(/.test(o.text);
      if (!c.makers.some((x) => x.file === o)) c.makers.push({ file: o, idx: m.index, added: o.adds });
    }
  }
  let projText = "";
  try {
    projText = files.find((f) => f.name === "project.godot")?.text ?? "";
  } catch {}
  const autoloadSection = projText.match(/^\[autoload\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  for (const m of autoloadSection.matchAll(/^\s*\w+\s*=\s*"\*?res:\/\/([^"]+)"/gm)) {
    const c = info.get(m[1]);
    if (c) c.autoload = true; // the engine creates and adds it
  }
  /** Does anything else in the project name this class or its res:// path? Then it is not safe to call it dead code. */
  const nameRe = (c) => (c.className ? new RegExp(`\\b${c.className}\\b`) : null);
  const referenced = (c) => {
    const re = nameRe(c);
    const path = `res://${c.f.rel}`;
    return files.some((f) => {
      if (f === c.f) return false;
      try {
        return f.text != null && (f.text.includes(path) || Boolean(re && f.ext === ".gd" && re.test(f.text)));
      } catch {
        return false; // an unreadable file is reported where it is read; it cannot name this class
      }
    });
  };

  const classes = [...info.values()];
  const registry = new Map(); // opener function name -> [{ cls, screen key, argIndex, label }]
  const reg = (name, entry) => registry.set(name, [...(registry.get(name) ?? []), entry]);

  for (const c of classes) {
    try {
      scanClass(c);
    } catch (e) {
      skip(`${c.f.rel}:1`, c.className ?? basename(c.f.rel), e);
    }
  }

  function scanClass(c) {
    const where = (i) => `${c.f.rel}:${i + 1}`;
    const text = c.text;
    // A class something creates and adds to the tree (or a scene script) is live; a child screen is never surer than that.
    // A class whose _init needs an argument cannot be made with .new(): no opener, and never sure.
    const live = (c.sceneKeys.length > 0 || c.autoload || c.makers.some((x) => x.added)) && !c.initNeeds;
    // Dead code only when nothing in the project creates it AND nothing names its class or its res:// path.
    const dead = !live && !c.initNeeds && !referenced(c);
    const code = (call, args, extra = {}) => (c.initNeeds ? undefined : { path: `res://${c.f.rel}`, ...(c.className ? { class: c.className } : {}), call, args, ...(call && !live ? { guessed_args: true } : {}), ...(dead ? { live: false } : {}), ...extra });
    const noArg = (fn, o, key, line) => r.unsure.push({ where: where(line), name: key, reason: `${fn.name}() needs an object argument (${o.unsafe}) there is no safe placeholder for; open it by hand` });
    if (!(c.screenLike || c.sceneKeys.length)) return;
    if (c.initNeeds) r.unsure.push({ where: where(c.initNeeds.start), name: c.key, reason: `_init(${c.initNeeds.params.filter((p) => !p.hasDefault).map((p) => p.name).join(", ")}) needs an argument, so the class cannot be made with new(); there is no opener, open it by hand` });
    const consumed = new Set(); // functions that are already openers of a dispatch
    const arms = []; // { key, label, fn (builder), line }
    let hasChildren = false;

    // ---- 2a. string dispatch: match <var>: with a builder per arm ---------------------------
    for (const fn of c.fns) {
      for (const mb of matchBlocks(c.lines, fn.start + 1, fn.end)) {
        const built = mb.arms.map((a) => ({ a, call: a.body.join("\n").match(BUILDER_CALL)?.[1] ?? null })).filter((x) => x.call && x.a.label);
        const strArms = built.filter((x) => /^&?"/.test(x.a.raw ?? ""));
        if (strArms.length < 2) continue;
        const v = mb.expr.replace(/^self\./, "");
        const vq = esc(v);
        const sets = (g, p) => new RegExp(`\\b${vq}\\s*=\\s*${esc(p.name)}\\b`).test(c.lines.slice(g.start + 1, g.end + 1).join("\n"));
        // The public function that sets the matched variable from its argument (or the argument itself).
        const setter = c.fns.find((g) => !g.name.startsWith("_") && g.params.some((p) => p.name === v || sets(g, p)));
        const pIdx = setter ? Math.max(0, setter.params.findIndex((p) => p.name === v || sets(setter, p))) : -1;
        const kind = /sheet/i.test(setter?.name ?? "") || /sheet/i.test(c.className ?? "") ? "sheet" : /modal|popup|dialog/i.test(setter?.name ?? "") ? "modal" : "screen";
        if (setter) consumed.add(setter.name);
        for (const { a, call } of strArms) {
          const key = fresh(`${c.key}_${screenKey(a.label)}`, where(a.line));
          const opener = setter ? argsFor(setter, { [pIdx]: gdStr(a.label) }) : null;
          const usable = Boolean(opener && !opener.unsafe);
          addScreen(r, {
            key,
            name: `${c.className ?? basename(c.f.rel)}: ${a.label}`,
            kind,
            where: where(a.line),
            sure: usable && live,
            why: `match arm "${a.label}" in ${fn.name}() builds it with ${call}()`,
            ...(usable ? { code: code(setter.name, opener.args, opener.guessed ? { guessed_args: true } : {}) } : {}),
          });
          if (!setter) r.unsure.push({ where: where(a.line), name: key, reason: `a match arm in ${fn.name}() builds this screen with ${call}() but no public function sets ${v}; read how the class is driven` });
          else if (!usable) noArg(setter, opener, key, a.line);
          arms.push({ key, label: a.label, builder: call });
          c.armOf.set(call, key);
          hasChildren = true;
          addEdge(r, { from: c.key, to: key, kind: kind === "sheet" ? "sheet" : "push", trigger: setter ? `${setter.name}("${a.label}")` : `match ${v}`, where: where(a.line) });
        }
        if (setter) reg(setter.name, { cls: c, argIndex: pIdx, labels: new Map(arms.map((x) => [x.label, x.key])) });
      }
    }

    // ---- 2b. enum of screens + a state variable ------------------------------------------
    for (const em of c.text.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
      const [, ename, body] = em;
      if (!ENUM_NAME.test(ename)) continue;
      let ord = 0;
      const vals = [];
      for (const part of splitTop(body)) {
        const m = part.trim().match(/^(\w+)\s*(?:=\s*(-?\d+))?$/);
        if (!m) continue;
        if (m[2] != null) ord = Number(m[2]);
        vals.push({ name: m[1], ord: ord++ });
      }
      const screeny = vals.filter((v) => SCREEN_WORD.test(v.name));
      if (screeny.length < 2) {
        if (ENUM_STRONG.test(ename) && vals.length >= 2) r.unsure.push({ where: where(lineAt(text, em.index) - 1), name: ename, reason: `enum ${ename} looks like a screen list but its values are not recognisable screen names; read it` });
        continue;
      }
      const stateVar = text.match(new RegExp(`^var\\s+(\\w+)\\s*(?::\\s*${ename}\\b\\s*)?:?=\\s*${ename}\\.\\w+`, "m"))?.[1] ?? text.match(new RegExp(`^var\\s+(\\w+)\\s*:\\s*${ename}\\b`, "m"))?.[1] ?? null;
      const setter = c.fns.find((g) => g.params.some((p) => p.type === ename)) ?? (stateVar ? c.fns.find((g) => new RegExp(`\\b${stateVar}\\s*=\\s*${g.params[0]?.name ?? "\u0000"}\\b`).test(c.lines.slice(g.start + 1, g.end + 1).join("\n"))) : null);
      const strong = ENUM_STRONG.test(ename) && screeny.length >= 3;
      const enumKeys = new Map();
      for (const v of screeny) {
        const line = lineAt(text, em.index) - 1;
        const key = fresh(`${c.key}_${screenKey(v.name)}`, where(line));
        enumKeys.set(v.name, key);
        const pIdx = setter ? Math.max(0, setter.params.findIndex((p) => p.type === ename)) : -1;
        const open = setter ? argsFor(setter, { [pIdx]: String(v.ord) }) : null;
        const usable = Boolean(open && !open.unsafe);
        const viaState = !usable && stateVar;
        addScreen(r, {
          key,
          name: `${c.className ?? basename(c.f.rel)}: ${v.name}`,
          kind: "screen",
          where: where(line),
          sure: strong && (usable || Boolean(viaState)) && live,
          why: `${ename}.${v.name} in enum ${ename}`,
          code: usable ? code(setter.name, open.args, open.guessed ? { guessed_args: true } : {}) : viaState ? code("", [], { set: stateVar, value: String(v.ord) }) : undefined,
        });
        if (setter && open.unsafe && !viaState) noArg(setter, open, key, line);
        hasChildren = true;
        addEdge(r, { from: c.key, to: key, kind: "push", trigger: `${ename}.${v.name}`, where: where(line) });
      }
      // Transitions: `state = Screen.SHOP` or `go_to(Screen.SHOP)`, from the match arm it sits in (else the class).
      for (const fn of c.fns)
        for (const b of matchBlocks(c.lines, fn.start + 1, fn.end))
          for (const a of b.arms) {
            const k = a.label && enumKeys.get(a.label.replace(/^\w+\./, ""));
            const call = k && a.body.join("\n").match(BUILDER_CALL)?.[1];
            if (call) c.armOf.set(call, k);
          }
      for (const fn of c.fns) {
        const blocks = matchBlocks(c.lines, fn.start + 1, fn.end);
        for (let i = fn.start + 1; i <= fn.end; i++) {
          const m = c.lines[i].match(new RegExp(`(?:\\b${stateVar ?? "\u0000"}\\s*=\\s*|\\w+\\(\\s*)${ename}\\.(\\w+)`));
          if (!m || !enumKeys.has(m[1])) continue;
          let from = c.armOf.get(fn.name) ?? c.key;
          for (const b of blocks)
            for (const a of b.arms) {
              const end = a.line + a.body.length - 1;
              if (a.label && i >= a.line && i <= end && enumKeys.has(a.label.replace(/^\w+\./, ""))) from = enumKeys.get(a.label.replace(/^\w+\./, ""));
            }
          addEdge(r, { from, to: enumKeys.get(m[1]), kind: "push", trigger: c.lines[i].trim().slice(0, 60), where: where(i) });
        }
      }
    }

    // ---- 3. show_* / open_* functions and _build_*_modal builders ---------------------------
    // Not for scripts attached to a scene: their start_/enter_/show_ functions are gameplay or scene changes, and the
    // scene is already a screen. Not for classes that are not UI nodes either, except one plain opener (a world's start_run()).
    const openerRx = c.uiBase ? OPENER_NAME : WORLD_OPENER;
    const publicOpeners = c.fns.filter((g) => openerRx.test(g.name) && !g.name.startsWith("_") && !consumed.has(g.name));
    const builders = c.fns.filter((g) => BUILD_SURFACE.test(g.name) && !arms.some((a) => a.builder === g.name));
    const surfaceLike = c.screenLike || hasChildren || (publicOpeners.length > 0 && c.uiBase && Boolean(c.className && UI_NAME.test(c.className)));
    if (surfaceLike && !c.sceneKeys.length) {
      const own = publicOpeners.filter((g) => !arms.some((a) => a.builder === g.name));
      const variants = c.uiBase && (hasChildren || own.length > 1 || (own.length >= 1 && builders.length));
      const usedBuilders = new Set();
      for (const g of own) {
        const tail = g.name.match(openerRx)[1];
        const pair = builders.find((b) => b.name.includes(`_${tail}_`) || tail.includes(b.name.match(BUILD_SURFACE)[1]));
        if (pair) usedBuilders.add(pair.name);
        const o = argsFor(g);
        if (!variants) {
          // One opener: it opens the class itself (a world is only opened this way when there is exactly one to pick from).
          if (!c.uiBase && own.length !== 1) continue;
          if (o.unsafe) {
            noArg(g, o, c.key, g.start);
            continue;
          }
          c.opener = code(g.name, o.args, o.guessed ? { guessed_args: true } : {});
          reg(g.name, { cls: c, argIndex: -1, key: c.key });
          continue;
        }
        const key = fresh(`${c.key}_${screenKey(tail)}`, where(g.start));
        const mod = pair ? BUILD_SURFACE.exec(pair.name)[2] : null;
        addScreen(r, {
          key,
          name: `${c.className ?? basename(c.f.rel)}: ${g.name}`,
          kind: mod === "sheet" ? "sheet" : mod === "modal" || mod === "popup" || mod === "dialog" || mod === "overlay" || OVERLAY_NAME.test(c.className ?? "") ? "modal" : "screen",
          where: where(g.start),
          sure: live && !o.unsafe && (!o.guessed || Boolean(pair)),
          why: `${g.name}() ${pair ? `shows what ${pair.name}() builds` : "opens a variant of this screen"}`,
          ...(o.unsafe ? {} : { code: code(g.name, o.args, o.guessed ? { guessed_args: true } : {}) }),
        });
        if (o.unsafe) noArg(g, o, key, g.start);
        addEdge(r, { from: c.key, to: key, kind: "sheet", trigger: `${g.name}()`, where: where(g.start) });
        reg(g.name, { cls: c, argIndex: -1, key });
        hasChildren = true;
      }
      for (const b of builders) {
        if (usedBuilders.has(b.name)) continue;
        const [, name, mod] = BUILD_SURFACE.exec(b.name);
        const key = fresh(`${c.key}_${screenKey(name)}`, where(b.start));
        const o = argsFor(b);
        addScreen(r, {
          key,
          name: `${c.className ?? basename(c.f.rel)}: ${name} ${mod}`,
          kind: mod === "screen" || mod === "page" || mod === "menu" ? "screen" : "modal",
          where: where(b.start),
          sure: false,
          why: `${b.name}() builds a ${mod} in code`,
          ...(o.unsafe ? {} : { code: code(b.name, o.args, { private: true, ...(o.guessed ? { guessed_args: true } : {}) }) }),
        });
        if (o.unsafe) noArg(b, o, key, b.start);
        addEdge(r, { from: c.key, to: key, kind: "sheet", trigger: `${b.name}()`, where: where(b.start) });
        hasChildren = true;
      }
    }

    // ---- 4. popups made with .new() in a function --------------------------------------------
    for (const fn of c.fns) {
      const body = c.lines.slice(fn.start + 1, fn.end + 1).join("\n");
      for (const m of body.matchAll(POPUP_NEW)) {
        const lineStart = body.lastIndexOf("\n", m.index) + 1;
        const varName = body.slice(lineStart, m.index).match(/\bvar\s+(\w+)/)?.[1];
        const o = argsFor(fn);
        const line = fn.start + 1 + body.slice(0, m.index).split("\n").length - 1;
        const key = fresh(`${c.key}_${screenKey(varName ?? fn.name.replace(/^_?(show|open|ask|confirm|popup)_?/, "") ?? fn.name)}`, where(line));
        addScreen(r, {
          key,
          name: `${m[1]} in ${fn.name}()`,
          kind: "modal",
          where: where(line),
          sure: live && !o.unsafe,
          why: `${m[1]}.new() in ${fn.name}()`,
          ...(o.unsafe ? {} : { code: code(fn.name, o.args, { ...(fn.name.startsWith("_") ? { private: true } : {}), ...(o.guessed ? { guessed_args: true } : {}) }) }),
        });
        if (o.unsafe) noArg(fn, o, key, line);
        addEdge(r, { from: c.key, to: key, kind: "sheet", trigger: `${m[1]}.new() in ${fn.name}()`, where: where(line) });
      }
    }

    // The class itself, as a screen, when it is one.
    if (c.screenLike) {
      const baseKind = hasChildren ? "container" : OVERLAY_NAME.test(c.className) ? "overlay" : c.uiBase ? "screen" : "scene";
      const made = c.makers.length > 0;
      // Sure needs a UI node that is made and added to the tree, plus a screen-level sign: an unambiguous name or children (a dispatch or openers).
      const sure = live && c.uiBase && (STRONG_NAME.test(c.className ?? "") || hasChildren);
      addScreen(r, {
        key: c.key,
        name: c.className,
        kind: baseKind,
        where: `${c.f.rel}:${lineAt(text, text.search(/^class_name\s/m) < 0 ? 0 : text.search(/^class_name\s/m))}`,
        sure,
        why: made ? `${c.base} script made with ${c.className}.new()${c.makers.some((x) => x.added) ? " and added to the tree" : ""}` : `${c.base} script named like a screen`,
        code: c.opener ?? code("", []),
      });
      if (!made) r.unsure.push({ where: `${c.f.rel}:1`, name: c.className, reason: "a script named like a screen, but nothing in code creates it; it may be unused or created from a scene" });
      for (const mk of c.makers) {
        for (const o of ctx.ownersOf(mk.file.f.rel)) addEdge(r, { from: o, to: c.key, kind: OVERLAY_NAME.test(c.className) ? "overlay" : "push", trigger: `${c.className}.new()${mk.added ? " + add_child" : ""}`, where: `${mk.file.f.rel}:${lineAt(mk.file.text, mk.idx)}` });
      }
    }
  }

  // ---- calls that open one code-built screen from another ---------------------------------
  const callRx = new Map([...registry.keys()].map((name) => [name, new RegExp(`(?:\\b(\\w+)\\.)?\\b${name}\\s*\\(\\s*("[^"]*"|&"[^"]*")?`, "g")]));
  for (const c of classes) {
    try {
      const fnAt = (i) => c.fns.find((g) => i >= g.start && i <= g.end);
      const owners = ctx.ownersOf(c.f.rel);
      for (const [name, entries] of registry) {
        const rx = callRx.get(name);
        c.lines.forEach((ln, i) => {
          if (!ln.includes(name) || /^\s*(static\s+)?func\s/.test(ln)) return;
          rx.lastIndex = 0;
          const m = rx.exec(ln);
          if (!m) return;
          const lit = entries.some((e) => e.labels) ? m[2]?.replace(/^&?"|"$/g, "") ?? null : null;
          // `_sheets.show_x()`: the receiver's class from `_sheets = Class.new()` or `var _sheets: Class`.
          const recvClass = m[1] ? c.text.match(new RegExp(`\\b${m[1]}\\s*=\\s*(\\w+)\\.new\\b`))?.[1] ?? c.text.match(new RegExp(`\\bvar\\s+${m[1]}\\s*:\\s*(\\w+)`))?.[1] ?? null : null;
          const pool = recvClass ? entries.filter((e) => e.cls.className === recvClass) : entries;
          const target = pool.map((e) => (e.labels ? (lit != null ? e.labels.get(lit) : null) : e.key)).filter(Boolean);
          if (target.length !== 1) return; // ambiguous: several classes share the function name
          const fn = fnAt(i);
          const fromArm = fn ? c.armOf.get(fn.name) : null;
          const fromList = fromArm ? [fromArm] : c.key !== target[0] && info.get(c.f.rel).className ? [c.key] : owners;
          for (const from of fromList) addEdge(r, { from, to: target[0], kind: "sheet", trigger: `${name}(${lit != null ? `"${lit}"` : ""})`, where: `${c.f.rel}:${i + 1}` });
        });
      }
    } catch (e) {
      skip(`${c.f.rel}:1`, c.className ?? basename(c.f.rel), e);
    }
  }
}
