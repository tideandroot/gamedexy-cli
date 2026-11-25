// `gamedexy check-export <path>`: look inside an exported build and fail when anything of Gamedexy's
// dev folder is in it. A ship script can run it and refuse the build.
//
// Reads (no Godot binary, no unzip, no extraction to disk):
//   .pck               Godot 4 pack: the file table (formats 1 to 4; a pack appended to an executable too)
//   .zip .apk .aab .ipa .jar   the zip directory; every .pck inside is read the same way
//   a Godot export folder (.app, an iOS project folder): every file below it that is one of the above
//
// It checks PATHS only, not script contents: debug-gated code that lives outside gamedexy/ is not found here.
//
// What counts as "in the build": any path with a `gamedexy/` folder in it (res://gamedexy/capture.gd,
// assets/gamedexy/...), a capture or codex script by name (gamedexy_capture.gd, gamedexy_codex.gd,
// GamedexyCapture.swift/.kt/.cs). The tiny stub autoload gamedexy_stub.gd is allowed: it ships on purpose
// and does nothing in a release build.
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const FOLDER = /(^|\/)gamedexy(\/|$)/i;
const SCRIPT = /(^|\/)(gamedexy_(capture|codex)\.[\w.]+|GamedexyCapture\.[\w.]+)$/;
const ZIPS = new Set([".zip", ".apk", ".aab", ".ipa", ".jar"]);
const PATHS_ONLY = "this does not look inside scripts. A debug-gated reader that lives outside gamedexy/ (a game file that reads -gdxState, a seed or log helper) can still ship; find those with `gamedexy capture init --dry-run` (already_reads_gdxState) and check a Release build with `gamedexy doctor --release-app`.";
const MAX_INFLATE = 600 * 1024 * 1024;
const MAX_ENTRIES = 2_000_000;

/** Is this path (inside a build) one of Gamedexy's dev files? */
export function isDevPath(p) {
  const path = String(p).replace(/\\/g, "/").replace(/^res:\/\//, "").replace(/^\/+/, "");
  return FOLDER.test(path) || SCRIPT.test(path);
}

class Unreadable extends Error {}

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, pos + off);
    if (n <= 0) break;
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
}

// ---- PCK -------------------------------------------------------------------------------------------------------

const PCK_MAGIC = 0x43504447; // "GDPC"

/**
 * The file table of a pack that starts at `base`, read at one candidate offset. Table: u32 count, per file: u32 path
 * length, path (padded to 4), u64 offset, u64 size, 16 bytes md5 and, from format 2, a u32 flags field.
 */
function readTable(read, dir, end, withFlags, version) {
  if (dir <= 0 || dir + 4 > end) throw new Unreadable(`the pack's file table is outside the file (format ${version})`);
  const count = read(dir, 4).readUInt32LE(0);
  if (count > MAX_ENTRIES) throw new Unreadable(`the pack claims ${count} files (format ${version})`);
  const paths = [];
  let pos = dir + 4;
  for (let i = 0; i < count; i++) {
    const lenBuf = read(pos, 4);
    if (lenBuf.length < 4) throw new Unreadable("the pack's file table ends early");
    const len = lenBuf.readUInt32LE(0);
    if (len > 4096 || pos + 4 + len > end) throw new Unreadable(`the pack's file table is not readable (format ${version})`);
    const name = read(pos + 4, len).toString("utf8").replace(/\0+$/, "");
    if (i === 0 && !/^(res:\/\/|user:\/\/|[\w.-]+\/|[\w.-]+$)/.test(name)) throw new Unreadable(`the pack's file table is not readable (format ${version})`);
    paths.push(name);
    pos += 4 + len + 8 + 8 + 16 + (withFlags ? 4 : 0);
  }
  return paths;
}

/**
 * File paths in a Godot pack that starts at `base` in the file. Header: magic, format version, engine version
 * (3 x u32), then by format:
 *   1 (Godot 3):    16 reserved u32, the table follows at 84
 *   2 (Godot 4.0+): flags (u32), file_base (u64), 16 reserved u32, the table follows at 96
 *   3 and later:    flags, file_base, directory offset (u64 at 32), reserved: the table is at that offset
 * Formats 3 and later are checked against real Godot 4.7.2 packs (format 4); if the offset reading does not
 * parse, the 96-byte layout is tried, and a pack that parses neither way is "unreadable", never a pass.
 */
export function readPckPaths(read, base, end) {
  const head = read(base, 40);
  if (head.length < 40 || head.readUInt32LE(0) !== PCK_MAGIC) throw new Unreadable("not a Godot pack");
  const version = head.readUInt32LE(4);
  if (version < 1 || version > 8) throw new Unreadable(`Godot pack format ${version} is not one this check knows`);
  if (version >= 2 && head.readUInt32LE(20) & 1) throw new Unreadable("the pack's file table is encrypted, so it cannot be read here");
  const candidates = version === 1 ? [[base + 84, false]] : version === 2 ? [[base + 96, true]] : [[base + Number(head.readBigUInt64LE(32)), true], [base + 96, true]];
  let last = null;
  for (const [dir, withFlags] of candidates) {
    try {
      return readTable(read, dir, end, withFlags, version);
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      last = e;
    }
  }
  throw last;
}

/** A .pck, or a pack appended to an executable (the last 12 bytes say how big it is). */
function pckPathsOfFile(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (p, l) => readAt(fd, p, l);
    const head = read(0, 4);
    if (head.length === 4 && head.readUInt32LE(0) === PCK_MAGIC) return readPckPaths(read, 0, size);
    const tail = size >= 12 ? read(size - 12, 12) : Buffer.alloc(0);
    if (tail.length === 12 && tail.readUInt32LE(8) === PCK_MAGIC) {
      const packSize = Number(tail.readBigUInt64LE(0));
      const start = size - 12 - packSize;
      if (start >= 0) return readPckPaths(read, start, size - 12);
    }
    throw new Unreadable("no Godot pack in this file");
  } finally {
    closeSync(fd);
  }
}

// ---- zip -------------------------------------------------------------------------------------------------------

/** Entries of a zip (name, method, compressed size, local header offset), from its central directory. */
export function readZipEntries(fd) {
  const size = fstatSync(fd).size;
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Unreadable("not a zip file");
  let total = tail.readUInt16LE(e + 10);
  let cdSize = tail.readUInt32LE(e + 12);
  let cdOffset = tail.readUInt32LE(e + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: the locator sits just before the end record
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), e);
    if (loc < 0) throw new Unreadable("zip64 directory not found");
    const rec = Number(tail.readBigUInt64LE(loc + 8));
    const z = readAt(fd, rec, 56);
    total = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOffset = Number(z.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > size) throw new Unreadable("the zip directory is outside the file");
  const cd = readAt(fd, cdOffset, cdSize);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50 && entries.length < MAX_ENTRIES) {
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let lho = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? "utf8" : "latin1");
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {
      const x = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
      for (let q = 0; q + 4 <= x.length; ) {
        const id = x.readUInt16LE(q);
        const len = x.readUInt16LE(q + 2);
        if (id === 1) {
          let r = q + 4;
          if (usize === 0xffffffff) (usize = Number(x.readBigUInt64LE(r))), (r += 8);
          if (csize === 0xffffffff) (csize = Number(x.readBigUInt64LE(r))), (r += 8);
          if (lho === 0xffffffff) lho = Number(x.readBigUInt64LE(r));
        }
        q += 4 + len;
      }
    }
    entries.push({ name, method, csize, usize, lho });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

/** The bytes of a zip entry (stored or deflated), for a .pck inside an apk or ipa. */
function entryBytes(fd, en) {
  const lh = readAt(fd, en.lho, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Unreadable(`${en.name}: bad zip entry`);
  const start = en.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (en.method === 0) return { stored: true, start, size: en.csize };
  if (en.method === 8) {
    if (en.usize > MAX_INFLATE) throw new Unreadable(`${en.name} is too big to open here (${Math.round(en.usize / 1048576)} MB compressed inside the archive); extract it and check the .pck itself`);
    return { stored: false, data: inflateRawSync(readAt(fd, start, en.csize)) };
  }
  throw new Unreadable(`${en.name}: zip method ${en.method} is not supported`);
}

function pckPathsInZipEntry(fd, en) {
  const b = entryBytes(fd, en);
  if (b.stored) return readPckPaths((p, l) => readAt(fd, p, l), b.start, b.start + b.size);
  // Deflated: the pack is in memory.
  return readPckPaths((p, l) => b.data.subarray(p, p + l), 0, b.data.length);
}

// ---- the check -------------------------------------------------------------------------------------------------

function* filesUnder(dir, root = dir, depth = 0) {
  if (depth > 12) return;
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of names) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* filesUnder(p, root, depth + 1);
    else yield p;
  }
}

function checkOne(file, shown, out) {
  const ext = extname(file).toLowerCase();
  const note = (path) => out.found.push({ path, in: shown });
  const unread = (why) => out.unreadable.push({ file: shown, why });
  try {
    if (ZIPS.has(ext)) {
      const fd = openSync(file, "r");
      try {
        const entries = readZipEntries(fd);
        out.checked.archives++;
        for (const en of entries) {
          out.checked.entries++;
          if (isDevPath(en.name)) note(en.name);
          else if (/\.pck$/i.test(en.name)) {
            try {
              const paths = pckPathsInZipEntry(fd, en);
              out.checked.packs++;
              out.checked.entries += paths.length;
              for (const p of paths) if (isDevPath(p)) note(`${en.name}: ${p}`);
            } catch (e) {
              if (!(e instanceof Unreadable)) throw e;
              unread(`${en.name}: ${e.message}`);
            }
          }
        }
      } finally {
        closeSync(fd);
      }
      return;
    }
    const paths = pckPathsOfFile(file);
    out.checked.packs++;
    out.checked.entries += paths.length;
    for (const p of paths) if (isDevPath(p)) note(p);
  } catch (e) {
    if (e instanceof Unreadable) {
      // A loose file in an export folder that is not an archive is not an error: only name it.
      if (!out.folder) unread(e.message);
      else if (ZIPS.has(ext) || ext === ".pck") unread(e.message);
      return;
    }
    throw e;
  }
}

/**
 * Check one build: a .pck, a zip-like archive (.apk .aab .ipa .zip .jar), an executable with an embedded pack,
 * or a folder (an unzipped .app or an exported project folder). ok is false when anything of Gamedexy's dev folder
 * is inside, and also when a pack could not be read: a build that cannot be checked is not a pass.
 */
export function checkExport(target) {
  const abs = resolve(String(target ?? ""));
  if (!target || target === true) throw new Error("Use: gamedexy check-export <build.pck | game.apk | game.ipa | game.zip | exported folder>");
  if (!existsSync(abs)) throw new Error(`${abs} does not exist.`);
  const folder = statSync(abs).isDirectory();
  const out = { found: [], unreadable: [], checked: { archives: 0, packs: 0, entries: 0, files: 0 }, folder };
  if (folder) {
    for (const f of filesUnder(abs)) {
      const rel = relative(abs, f).split(/[\\/]/).join("/");
      out.checked.files++;
      if (isDevPath(rel)) out.found.push({ path: rel, in: basename(abs) });
      const ext = extname(f).toLowerCase();
      if (ZIPS.has(ext) || ext === ".pck" || ext === "" || ext === ".exe" || ext === ".x86_64") {
        if (ext === "" && statSync(f).size < 12) continue;
        checkOne(f, rel, out);
      }
    }
    if (!out.checked.packs && !out.checked.archives && !out.unreadable.length) out.unreadable.push({ file: basename(abs), why: "no .pck, archive or Godot executable found inside this folder, so nothing could be checked" });
  } else {
    out.checked.files = 1;
    checkOne(abs, basename(abs), out);
  }
  const { folder: _f, ...rest } = out;
  const ok = !out.found.length && !out.unreadable.length;
  return {
    ok,
    scope: "paths only",
    file: abs,
    ...rest,
    ...(ok
      ? { verdict: `Clean: no gamedexy/ path or capture script in ${basename(abs)} (${out.checked.entries} paths read). Paths only: ${PATHS_ONLY}` }
      : {
          verdict: out.found.length
            ? `Do not ship this build: ${out.found.length} Gamedexy dev file${out.found.length === 1 ? "" : "s"} inside.`
            : "This build could not be checked, so it is not a pass.",
          next: out.found.length
            ? "Export from the original preset (not the \"(Gamedexy capture)\" copy). `gamedexy capture init` adds gamedexy/* to each preset's exclude filter; re-run it, then export again."
            : "Check the file by hand, or point at the .pck itself.",
        }),
  };
}
