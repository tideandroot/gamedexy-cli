// Reusing an existing Game Map game (map_list_games) before creating one, and the per-picture upload report.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { codexRender, codexScan, codexSend, scanCodex } from "../src/codex.mjs";
import { AmbiguousGame, listGames, pickGame, resolveGame, slugify } from "../src/games.mjs";
import { startSignedIn } from "../src/map.mjs";

const G = (n, name, slug = slugify(name)) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, slug, name, platform: "ios", engine: "godot", project: null, run_count: 1, latest_run_at: null, has_codex: false, map_url: `https://x/my-games/map/${slug}` });

/** A fake MCP: map_list_games over `games` in pages, map_create_game recorded. */
function fakeMcp(games, extra = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === "map_list_games") {
      const start = Number(args.cursor ?? 0);
      const limit = args.limit ?? 25;
      const next = start + limit < games.length ? String(start + limit) : undefined;
      return { total: games.length, games: games.slice(start, start + limit), ...(next ? { next_cursor: next } : {}) };
    }
    if (name === "map_create_game") return { game_id: "new-id", slug: slugify(args.name), created: true, map_url: "https://x/new" };
    if (extra[name]) return extra[name](args, calls);
    return {};
  };
  return { call, calls };
}
const created = (calls) => calls.filter((c) => c.name === "map_create_game");

test("slugify matches the server", () => {
  assert.equal(slugify("Rattlepop"), "rattlepop");
  assert.equal(slugify("Tether: Gravity Runner"), "tether-gravity-runner");
  assert.equal(slugify("  "), "game");
});

test("listGames follows every page", async () => {
  const many = Array.from({ length: 120 }, (_, i) => G(i + 1, `Game ${i + 1}`));
  const { call, calls } = fakeMcp(many);
  const all = await listGames(call);
  assert.equal(all.length, 120);
  assert.equal(calls.filter((c) => c.name === "map_list_games").length, 3);
});

test("pickGame: id, then slug, then case-insensitive name; nothing found means create", () => {
  const games = [G(1, "Rattlepop"), G(2, "Tether", "tether-run")];
  assert.equal(pickGame(games, games[0].id).game.slug, "rattlepop");
  assert.equal(pickGame(games, "tether-run").game.name, "Tether");
  assert.equal(pickGame(games, "RATTLEPOP").game.id, games[0].id);
  assert.equal(pickGame(games, "tether").game.slug, "tether-run"); // by name
  assert.deepEqual(pickGame(games, "Brand New"), { create: true });
  assert.throws(() => pickGame(games, "00000000-0000-4000-8000-0000000000ff"), /No game with id/);
});

test("pickGame: several games with that name stop and list them, create-new overrides", () => {
  const games = [G(1, "Pop", "pop-a"), G(2, "pop", "pop-b")];
  assert.throws(
    () => pickGame(games, "POP"),
    (e) => e instanceof AmbiguousGame && /pop-a/.test(e.message) && /pop-b/.test(e.message) && /Nothing was created/.test(e.message) && e.matches.length === 2,
  );
  assert.deepEqual(pickGame(games, "POP", { createNew: true }), { create: true });
  // The slug is unique, so an explicit slug always settles it.
  assert.equal(pickGame(games, "pop-b").game.id, games[1].id);
});

test("--create-new never silently reuses a game: a slug that is taken stops with a clear message", async () => {
  const games = [G(1, "Rattlepop")];
  assert.throws(() => pickGame(games, "Rattlepop", { createNew: true }), /--create-new cannot make "Rattlepop".*slug "rattlepop".*different name/);
  assert.throws(() => pickGame(games, "RATTLEPOP!", { createNew: true }), /slug "rattlepop"/);
  // A new name with a free slug is created, even when another game has the same display name under another slug.
  assert.deepEqual(pickGame([G(1, "Pop", "pop-a")], "Pop", { createNew: true }), { create: true });
  // And if the server still answers with an existing game (made a moment ago), it is not passed off as new.
  const call = async (name) => (name === "map_list_games" ? { games: [] } : { game_id: "x", slug: "pop", created: false });
  await assert.rejects(resolveGame(call, { game: "Pop", createNew: true }), /asked for a new game.*existing game pop/);
});

test("pickGame: a lookalike name (spaces or punctuation differ) is listed, never reused or created silently", () => {
  const games = [G(1, "Rattlepop")];
  assert.throws(() => pickGame(games, "Rattle Pop"), /look alike to "Rattle Pop".*rattlepop/);
});

test("resolveGame reuses a found game and calls map_create_game only when nothing matches", async () => {
  const { call, calls } = fakeMcp([G(1, "Rattlepop")]);
  const r = await resolveGame(call, { game: "rattlepop", platform: "ios" });
  assert.deepEqual([r.game_id, r.created, r.reused], [G(1, "x").id, false, true]);
  assert.equal(created(calls).length, 0);
  const n = await resolveGame(call, { game: "Other Game", platform: "android", engine: "godot" });
  assert.equal(n.created, true);
  assert.deepEqual(created(calls).map((c) => c.args), [{ name: "Other Game", platform: "android", engine: "godot" }]);
});

test("an older server without map_list_games falls back to create-by-name and says so", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push(name);
    if (name === "map_list_games") throw new Error("map_list_games: Unknown tool: map_list_games");
    return { game_id: "g", slug: "pop", created: true, map_url: "u" };
  };
  const r = await resolveGame(call, { game: "Pop", platform: "ios" });
  assert.equal(r.created, true);
  assert.match(r.lookup, /skipped/);
  assert.deepEqual(calls, ["map_list_games", "map_create_game"]);
  // Any other failure is not swallowed: a network error must not turn into a second game.
  await assert.rejects(resolveGame(async () => { throw new Error("map_list_games: Game Map needs a Gamedexy Pro account."); }, { game: "Pop" }), /Pro account/);
});

// ---- codex send ----------------------------------------------------------------------------------------

function codexFile(name = "Pop") {
  const src = mkdtempSync(join(tmpdir(), "games-src-"));
  writeFileSync(join(src, "project.godot"), "[application]\n");
  writeFileSync(join(src, "items.gd"), `const ITEM_DEFS := [\n\t{"id": "a", "name": "Apple", "desc": "Food", "heal": 5},\n\t{"id": "b", "name": "Bread", "desc": "Food", "heal": 9},\n\t{"id": "c", "name": "Cheese", "desc": "Food", "heal": 7},\n]\n`);
  const out = mkdtempSync(join(tmpdir(), "games-out-"));
  codexScan({ src, out, game: name });
  return { file: join(out, "codex.json"), out };
}

test("codex send reuses an existing game found by slug and never calls map_create_game", async () => {
  const { file } = codexFile("Rattlepop");
  const { call, calls } = fakeMcp([G(7, "Rattlepop")], { map_set_codex: () => ({ version: 2, entries: 2, uploads: [] }) });
  const r = await codexSend({ codex: file }, { callTool: call });
  assert.equal(created(calls).length, 0);
  assert.equal(calls.find((c) => c.name === "map_set_codex").args.game, G(7, "x").id);
  assert.equal(r.game.created, false);
  assert.equal(r.game.reused, true);
  assert.equal(r.note, undefined);
});

test("codex send --game <slug|id> picks one explicitly", async () => {
  const { file } = codexFile("Rattlepop");
  const games = [G(1, "Pop", "pop-a"), G(2, "Pop", "pop-b")];
  const { call, calls } = fakeMcp(games, { map_set_codex: () => ({ version: 1, entries: 2, uploads: [] }) });
  await codexSend({ codex: file, game: "pop-b" }, { callTool: call });
  assert.equal(calls.find((c) => c.name === "map_set_codex").args.game, games[1].id);
  const again = fakeMcp(games, { map_set_codex: () => ({ version: 1, entries: 2, uploads: [] }) });
  await codexSend({ codex: file, game: games[0].id }, { callTool: again.call });
  assert.equal(again.calls.find((c) => c.name === "map_set_codex").args.game, games[0].id);
});

test("codex send with several possible matches stops, lists them and sends nothing", async () => {
  const { file } = codexFile("Pop");
  const { call, calls } = fakeMcp([G(1, "Pop", "pop-a"), G(2, "POP", "pop-b")]);
  await assert.rejects(codexSend({ codex: file }, { callTool: call }), (e) => /Several games are named "Pop"/.test(e.message) && /pop-a/.test(e.message) && /pop-b/.test(e.message));
  assert.deepEqual(calls.map((c) => c.name), ["map_list_games"]);
});

test("codex send says when no game matched and one was created", async () => {
  const { file } = codexFile("Brand New");
  const { call, calls } = fakeMcp([G(1, "Rattlepop")], { map_set_codex: () => ({ version: 1, entries: 2, uploads: [] }) });
  const r = await codexSend({ codex: file }, { callTool: call });
  assert.equal(created(calls).length, 1);
  assert.equal(r.game.created, true);
  assert.match(r.note, /--game <slug\|id>/);
});

// ---- map start ----------------------------------------------------------------------------------------

test("map start --game reuses an existing game; several matches stop before a run folder is made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "games-start-"));
  const { call, calls } = fakeMcp([G(1, "Rattlepop")], { map_start_run: () => ({ run_id: "r1" }) });
  const out = await startSignedIn({ dir, platform: "ios", device: "x", appId: "a", game: "Rattlepop", callTool: call, startFn: () => (writeFileSync(join(dir, "run.json"), JSON.stringify({ platform: "ios" })), { for_map_start_run: {} }) });
  assert.equal(created(calls).length, 0);
  assert.equal(out.game.created, false);
  assert.equal(out.game.slug, "rattlepop");

  const dir2 = join(mkdtempSync(join(tmpdir(), "games-start2-")), "run");
  const two = fakeMcp([G(1, "Pop", "pop-a"), G(2, "Pop", "pop-b")]);
  await assert.rejects(startSignedIn({ dir: dir2, platform: "ios", device: "x", appId: "a", game: "Pop", callTool: two.call }), /Several games are named/);
  assert.deepEqual(two.calls.map((c) => c.name), ["map_list_games"]);
  assert.throws(() => readFileSync(join(dir2, "run.json")), /ENOENT/);
});

// ---- codex send: pictures --------------------------------------------------------------------------------

function pictureCodex() {
  const { file, out } = codexFile("Pop");
  mkdirSync(join(out, "images"));
  const codex = JSON.parse(readFileSync(file, "utf8"));
  const ids = codex.entries.map((e) => e.id).slice(0, 2);
  const imgs = ids.map((id, i) => {
    writeFileSync(join(out, "images", `p${i}.png`), Buffer.from([i + 1, 2, 3]));
    return { id, file: `p${i}.png`, w: 128, h: 128 };
  });
  writeFileSync(join(out, "images", "images.json"), JSON.stringify({ images: imgs }));
  codexRender({ codex: file, noRun: true });
  return { file, out, codex: JSON.parse(readFileSync(file, "utf8")) };
}

test("codex send: a failed picture does not stop the others; failures are listed and ok is false", async () => {
  const { file, out, codex } = pictureCodex();
  const withImg = codex.entries.filter((e) => e.image);
  assert.equal(withImg.length, 2);
  const uploads = withImg.map((e) => ({ sha256: e.image.sha256, url: `https://r2/${e.id}` }));
  // First picture: the file is gone. Second: the PUT is refused. Third would be fine, so add a good one.
  const good = codex.entries.find((e) => !e.image);
  writeFileSync(join(out, "images", "good.png"), Buffer.from([9, 9, 9]));
  good.image = { file: "images/good.png", w: 128, h: 128, sha256: "9".repeat(64), bytes: 3 };
  writeFileSync(file, JSON.stringify(codex));
  uploads.push({ sha256: "9".repeat(64), url: "https://r2/good" });
  rmFile(join(out, withImg[0].image.file));
  const puts = [];
  const { call } = fakeMcp([], { map_set_codex: (_a, calls) => ({ version: 1, entries: 5, uploads: calls.filter((c) => c.name === "map_set_codex").length === 1 ? uploads : [] }) });
  const r = await codexSend(
    { codex: file, game: "Pop" },
    {
      callTool: call,
      fetch: async (url) => {
        puts.push(url);
        return url.includes(withImg[1].id) ? { ok: false, status: 403 } : { ok: true, status: 200 };
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.images.uploaded, 1, "the good one still went up");
  assert.equal(r.images.failed.length, 2);
  assert.deepEqual(r.images.failed.map((f) => f.id).sort(), [withImg[0].id, withImg[1].id].sort());
  assert.ok(r.images.failed.some((f) => f.status === 403));
  assert.ok(r.images.failed.some((f) => /ENOENT/.test(f.error)));
  assert.equal(r.failed_uploads, 2);
  assert.ok(puts.some((u) => u.endsWith("/good")), "the picture after the failures was still tried");
});

test("the CLI exits non-zero when codex send reports failed pictures", async () => {
  const { spawnSync } = await import("node:child_process");
  const { file, codex } = pictureCodex();
  // No sign-in file here, so the command fails before it sends; point HOME at an empty folder and check the exit code is 1.
  const home = mkdtempSync(join(tmpdir(), "games-home-"));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/gamedexy.mjs", import.meta.url)), "codex", "send", "--codex", file, "--game", "Pop"], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not signed in/);
  assert.ok(codex);
});

import { rmSync } from "node:fs";
const rmFile = (p) => rmSync(p, { force: true });

// ---- codex scan: triple-quoted tables -----------------------------------------------------------------------

test("scan reports a table it cannot read (a triple-quoted string inside it) as skipped, with the reason", () => {
  const src = mkdtempSync(join(tmpdir(), "games-tq-"));
  writeFileSync(join(src, "project.godot"), "[application]\n");
  writeFileSync(
    join(src, "lore.gd"),
    `const LORE_DEFS := [
	{"id": "a", "name": "Old tale", "desc": """A long
story [with brackets and { braces
over lines"""},
	{"id": "b", "name": "New tale", "desc": "Short"},
]
const ITEM_DEFS := [
	{"id": "a", "name": "Apple", "desc": "Food", "heal": 5},
	{"id": "b", "name": "Bread", "desc": "Food", "heal": 9},
]
`,
  );
  const codex = scanCodex(src, { game: "G" });
  const sk = codex.skipped_tables.find((s) => s.table === "LORE_DEFS");
  assert.ok(sk, "the table is listed, not dropped");
  assert.match(sk.why, /"""/);
  assert.match(sk.where, /^lore\.gd:1$/);
  assert.equal(codex.entries.filter((e) => e.table === "ITEM_DEFS").length, 2, "other tables are unaffected");
});
