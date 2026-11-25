import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { carryOver, checkGodotBin, codexPayload, gitFiles, hookResPath, looksLikeSecret, relativeTo, scrubEntry, sensitiveKey, codexRender, codexScan, codexSend, diffCodex, diffSummary, guessCategory, mergeImages, parseValue, plain, scanCodex, tokenize } from "../src/codex.mjs";

// A small made-up Godot game: suits keyed by an enum, dice made by a constructor, enemies in a
// match block, zones with an embedded boss, upgrades, a JSON data file and a table with no names.
function game(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-cli-"));
  const put = (rel, text) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("project.godot", "[application]\n");
  put(
    "src/core/pieces.gd",
    `class_name Pieces
extends RefCounted

enum Suit { FLAME = 0, WAVE = 1, GEAR = 2 }

const SUIT_META := {
	Suit.FLAME: {"id": "flame", "name": "Flame", "color": Color(0.9, 0.2, 0.1, 1.0), "desc": "Burns the nearest foe"},
	Suit.WAVE: {"id": "wave", "name": "Wave", "color": Color(0.1, 0.4, 0.9, 1.0), "desc": "Pushes foes away"},
	Suit.GEAR: {"id": "gear", "name": "Turbo", "color": Color(0.1, 0.8, 0.3, 1.0), "desc": "Speeds you up"},
}

static func make_face(suit: int, pips: int, upgraded: bool = false) -> Dictionary:
	return {"suit": suit, "pips": pips, "upgraded": upgraded}

static func make_die(name: String, faces: Array, body_color: Color, weighted_suit: int = -1) -> Dictionary:
	return {"name": name, "faces": faces}

static func starter() -> Array:
	var a := make_die("Ember Die", [
		make_face(Suit.FLAME, 2),
		make_face(Suit.GEAR, 6, true),
	], Color(0.9, 0.3, 0.3, 1.0))
	return [a]
`,
  );
  put(
    "src/core/progress.gd",
    `class_name Progress
# Workshop upgrades
const UPGRADE_DEFS := [
	{"id": "power", "name": "Sharp Edges", "desc": "Hit harder", "max_level": 10, "base_cost": 20, "suit": Pieces.Suit.GEAR, "pos": Vector2(1, 2)},
	{"id": "speed", "name": "Quick Feet", "desc": "Move faster", "max_level": 8, "base_cost": 30, "suit": Pieces.Suit.WAVE},
]
const POINT_TRACK := [
	{"pts": 20, "coins": 60},
	{"pts": 40, "coins": 90},
]
const ZONES := [
	{"id": 1, "name": "Mossy Glade", "subtitle": "Slimes", "boss_kind": "moss_king", "boss_name": "MOSS KING", "boss_hp": 700.0, "boss_lvl": 5, "weights": {"slime": 3, "bat": 1}},
	{"id": 2, "name": "Ash Hills", "subtitle": "Bats", "boss_kind": "ash_wyrm", "boss_name": "ASH WYRM", "boss_hp": 4000.0, "boss_lvl": 10},
]
`,
  );
  put(
    "src/gameplay/world.gd",
    `extends Node2D
func _spawn_enemy(kind: String) -> void:
	var hp := 10.0
	match kind:
		"slime": hp = 30.0 * hp_m; speed = 100.0; xp = 3
		"bat": hp = 20.0 * hp_m; speed = 160.0; xp = 4
		"golem": hp = 200.0 * hp_m; speed = 60.0; xp = 12
`,
  );
  put("data/pets.json", JSON.stringify({ pets: [{ id: "owl", name: "Owl", description: "Spots hidden chests", cost: 50 }, { id: "cat", name: "Cat", cost: 70 }] }, null, 1));
  put("tests/test_fake.gd", 'const SKIN_DEFS := [{"id": "x", "name": "Test only"}, {"id": "y", "name": "Test only 2"}]\n');
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  return dir;
}

const byId = (c) => new Map(c.entries.map((e) => [e.id, e]));

test("the literal reader handles GDScript dictionaries, calls, refs and expressions", () => {
  const src = '{"a": 1, b = "two", "c": [1, 2.5, -3], "d": Color(1, 0, 0), "e": Suit.FLAME, "f": 36.0 * hp_m, "g": true}';
  const [v] = parseValue(tokenize(src), 0, src);
  assert.deepEqual(plain(v), { a: 1, b: "two", c: [1, 2.5, -3], d: { call: "Color", args: [1, 0, 0] }, e: { ref: "Suit.FLAME" }, f: { expr: "36.0 * hp_m" }, g: true });
});

test("categories come from table, function and field names", () => {
  assert.equal(guessCategory("SUIT_META"), "dice_faces");
  assert.equal(guessCategory("make_die"), "dice");
  assert.equal(guessCategory("_spawn_enemy_in_zone"), "enemies");
  assert.equal(guessCategory("boss"), "bosses");
  assert.equal(guessCategory("UPGRADE_DEFS"), "upgrades");
  assert.equal(guessCategory("LEVEL_PERKS"), "perks");
  assert.equal(guessCategory("BUDDY_DEFS"), "companions");
  assert.equal(guessCategory("OPENERS"), null);
});

test("scan reads const tables, constructors, match blocks, embedded bosses and JSON", () => {
  const c = scanCodex(game(), { game: "Pop" });
  const m = byId(c);
  assert.equal(c.schema, "gamedexy.codex/1");
  // Enum-keyed table: the id field, the description, the color.
  assert.deepEqual([m.get("dice_faces/flame").name, m.get("dice_faces/flame").what, m.get("dice_faces/flame").color], ["Flame", "Burns the nearest foe", "#e6331a"]);
  assert.deepEqual(m.get("dice_faces/flame").defined_at, { file: "src/core/pieces.gd", line: 7 });
  // Constructor: faces read with the project's own names (GEAR is "Turbo"), the true flag by its parameter name.
  const ember = m.get("dice/ember-die");
  assert.equal(ember.found_by, "gd-ctor");
  assert.deepEqual(ember.facts.find((f) => f.label === "Faces"), { label: "Faces", value: "Flame 2 · Turbo 6 upgraded" });
  assert.equal(ember.facts.find((f) => f.label === "Made in").value, "starter()");
  assert.equal(ember.needs_description, true);
  // Array table: layout fields (pos) left out, references resolved.
  const power = m.get("upgrades/power");
  assert.deepEqual(power.numbers, [{ label: "Max level", value: 10 }, { label: "Base cost", value: 20 }]);
  assert.deepEqual(power.facts, [{ label: "Suit", value: "Turbo" }]);
  // Numeric ids are scoped by their table; the boss becomes its own entry.
  assert.equal(m.get("areas/zones-1").name, "Mossy Glade");
  assert.deepEqual(m.get("areas/zones-1").facts.map((f) => f.label), ["Weights", "Boss"]);
  const boss = m.get("bosses/moss-king");
  assert.equal(boss.name, "MOSS KING");
  assert.deepEqual(boss.numbers, [{ label: "Hp", value: 700 }, { label: "Lvl", value: 5 }]);
  // Match arms.
  const golem = m.get("enemies/golem");
  assert.deepEqual(golem.numbers, [{ label: "Hp", value: 200, raw: "200.0 * hp_m" }, { label: "Speed", value: 60 }, { label: "Xp", value: 12 }]);
  // JSON data file.
  assert.equal(m.get("companions/owl").what, "Spots hidden chests");
  // Left out: rows with no name, test folders.
  assert.ok(c.skipped_tables.some((s) => s.table === "POINT_TRACK"));
  assert.ok(!c.entries.some((e) => e.name.startsWith("Test only")));
  assert.deepEqual(c.categories.map((x) => x.key), ["dice", "dice_faces", "enemies", "bosses", "companions", "upgrades", "areas"]);
});

test("diff names removals, additions, renames and changed numbers", () => {
  const before = scanCodex(game(), { game: "Pop" });
  const dir = game({
    "src/core/pieces.gd": readFileSync(join(game(), "src/core/pieces.gd"), "utf8")
      .replace('Suit.WAVE: {"id": "wave", "name": "Wave"', 'Suit.WAVE: {"id": "buddies", "name": "Buddies"')
      .replace('"name": "Turbo"', '"name": "Overdrive"'),
    "src/gameplay/world.gd": readFileSync(join(game(), "src/gameplay/world.gd"), "utf8").replace("200.0 * hp_m", "240.0 * hp_m"),
  });
  const after = scanCodex(dir, { game: "Pop" });
  const s = diffSummary(diffCodex(before, after));
  assert.ok(s.lines.includes("Dice faces: Wave removed; Buddies added; Turbo renamed Overdrive"), s.lines.join("\n"));
  assert.ok(s.lines.some((l) => l.startsWith("Enemies: Golem changed (Hp")));
  assert.deepEqual(diffSummary(diffCodex(after, after)).lines, []);
});

test("codex scan keeps the last file and carries written descriptions and pictures", () => {
  const src = game();
  const out = mkdtempSync(join(tmpdir(), "codex-out-"));
  codexScan({ src, out });
  const file = join(out, "codex.json");
  const c = JSON.parse(readFileSync(file, "utf8"));
  const golem = c.entries.find((e) => e.id === "enemies/golem");
  golem.what = "Slow, very tough; hits for two";
  mkdirSync(join(out, "images"));
  writeFileSync(join(out, "images", "x.png"), "png");
  golem.image = { file: "images/x.png", sha256: "a".repeat(64), w: 128, h: 128, bytes: 3 };
  writeFileSync(file, JSON.stringify(c));
  const r = codexScan({ src, out });
  assert.ok(readFileSync(join(out, "codex.prev.json"), "utf8").includes("Slow, very tough"));
  const again = JSON.parse(readFileSync(file, "utf8")).entries.find((e) => e.id === "enemies/golem");
  assert.deepEqual([again.what, again.what_from, again.needs_description, again.recheck, again.image.file], ["Slow, very tough; hits for two", "written", false, undefined, "images/x.png"]);
  // The written description came back, so nothing changed since the last scan.
  assert.deepEqual(r.since_last_scan.lines, []);
  // A written description whose numbers move is marked to recheck.
  const prev = { entries: [{ ...again, numbers: [{ label: "Hp", value: 1 }] }] };
  const next = { entries: [{ ...again, what: null, needs_description: true, what_from: undefined }] };
  carryOver(prev, next, out);
  assert.equal(next.entries[0].recheck, true);
});

test("render refuses without a hook and merges a hook's images.json", () => {
  const src = game();
  const out = mkdtempSync(join(tmpdir(), "codex-img-"));
  codexScan({ src, out });
  const file = join(out, "codex.json");
  assert.match(codexRender({ src, codex: file }).refused, /No render hook/);
  mkdirSync(join(out, "images"), { recursive: true });
  writeFileSync(join(out, "images", "dice_faces__flame.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(
    join(out, "images", "images.json"),
    JSON.stringify({ schema: "gamedexy.codex-images/1", images: [{ id: "dice_faces/flame", file: "dice_faces__flame.png", w: 128, h: 128 }, { id: "nope/x", file: "x.png" }], skipped: [{ id: "areas/zones-1", why: "no drawing" }] }),
  );
  const r = codexRender({ codex: file, noRun: true });
  assert.equal(r.attached, 1);
  assert.deepEqual(r.problems, [{ id: "nope/x", why: "no such entry in codex.json" }]);
  const flame = JSON.parse(readFileSync(file, "utf8")).entries.find((e) => e.id === "dice_faces/flame");
  assert.equal(flame.image.file, "images/dice_faces__flame.png");
  assert.match(flame.image.sha256, /^[0-9a-f]{64}$/);
  // The payload sends the hash, never the local path.
  const p = codexPayload(JSON.parse(readFileSync(file, "utf8")));
  assert.deepEqual(Object.keys(p.entries.find((e) => e.id === "dice_faces/flame").image), ["sha256", "w", "h", "bytes"]);
  // mergeImages alone, for a hook that wrote somewhere else.
  assert.equal(mergeImages(JSON.parse(readFileSync(file, "utf8")), out, join(out, "images")).attached, 1);
});

test("send creates or finds the game, stores the version and uploads only the pictures asked for", async () => {
  const src = game();
  const out = mkdtempSync(join(tmpdir(), "codex-send-"));
  codexScan({ src, out, game: "Pop" });
  const file = join(out, "codex.json");
  mkdirSync(join(out, "images"));
  writeFileSync(join(out, "images", "a.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(out, "images", "images.json"), JSON.stringify({ images: [{ id: "dice_faces/flame", file: "a.png", w: 128, h: 128 }] }));
  codexRender({ codex: file, noRun: true });
  const sha = JSON.parse(readFileSync(file, "utf8")).entries.find((e) => e.id === "dice_faces/flame").image.sha256;
  const calls = [];
  const puts = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "map_list_games") return { games: [] };
    if (name === "map_create_game") return { game_id: "g1", slug: "pop", created: false, map_url: "https://x/my-games/map/pop" };
    // First send asks for the picture; the confirming send finds it stored.
    const first = calls.filter((c) => c.name === "map_set_codex").length === 1;
    return { version: 3, entries: args.codex.entries.length, changes: { added: 1, removed: 0, changed: 0, lines: ["Dice: Ember Die added"] }, uploads: first ? [{ sha256: sha, url: "https://r2.example/put" }] : [], images_already_stored: first ? 0 : 1, codex_url: "https://x/my-games/map/pop?view=codex" };
  };
  const fetchFn = async (url, init) => {
    puts.push({ url, type: init.headers["content-type"], bytes: init.body.length });
    return { ok: true, status: 200 };
  };
  const r = await codexSend({ codex: file, game: "Pop" }, { callTool, fetch: fetchFn });
  // The account's games are looked up first; no match, so the game is created.
  assert.equal(calls[0].name, "map_list_games");
  assert.equal(calls[1].name, "map_create_game");
  assert.deepEqual(calls[1].args, { name: "Pop", platform: "ios", engine: "godot" });
  assert.equal(calls[2].name, "map_set_codex");
  assert.equal(calls[2].args.codex.schema, "gamedexy.codex/1");
  assert.ok(!JSON.stringify(calls[2].args).includes(out), "no local paths leave the machine");
  assert.deepEqual(puts, [{ url: "https://r2.example/put", type: "image/png", bytes: 3 }]);
  assert.equal(r.version, 3);
  assert.equal(r.images.uploaded, 1);
  // A second set_codex confirms the pictures; nothing is left missing.
  assert.equal(calls.filter((c) => c.name === "map_set_codex").length, 2);
  assert.equal(r.images.missing, undefined);
  assert.equal(r.game.created, false);
  assert.equal(r.note, undefined);
});

test("send says when it created a new game, and reports pictures that are still missing", async () => {
  const src = game();
  const out = mkdtempSync(join(tmpdir(), "codex-send2-"));
  codexScan({ src, out, game: "Pop" });
  const file = join(out, "codex.json");
  mkdirSync(join(out, "images"));
  writeFileSync(join(out, "images", "a.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(out, "images", "images.json"), JSON.stringify({ images: [{ id: "dice_faces/flame", file: "a.png", w: 128, h: 128 }] }));
  codexRender({ codex: file, noRun: true });
  const sha = JSON.parse(readFileSync(file, "utf8")).entries.find((e) => e.id === "dice_faces/flame").image.sha256;
  const callTool = async (name, args) =>
    name === "map_list_games"
      ? { games: [] }
      : name === "map_create_game"
      ? { game_id: "g1", slug: "pop", created: true, map_url: "https://x/m" }
      : { version: 1, entries: args.codex.entries.length, uploads: [{ sha256: sha, url: "https://r2.example/put" }], images_already_stored: 0 };
  const r = await codexSend({ codex: file, game: "Pop" }, { callTool, fetch: async () => ({ ok: false, status: 403 }) });
  assert.match(r.note, /created a new Game Map game/);
  assert.deepEqual(r.images.failed, [{ id: "dice_faces/flame", status: 403 }]);
  assert.equal(r.images.missing, 1);
});

// ---- secrets, ignored files, paths --------------------------------------------------------------------

const KEY = "sk_live_" + "51Nabc123DEF456ghi789JKLmno";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123";

test("scan: the reviewer's fake repo leaks no key, token or e-mail into the codex", () => {
  const src = mkdtempSync(join(tmpdir(), "codex-secret-"));
  mkdirSync(join(src, "config"));
  writeFileSync(join(src, "project.godot"), "[application]\n");
  writeFileSync(
    join(src, "rewards.gd"),
    `const REWARD_DEFS := [
	{"id": "daily", "name": "Daily chest", "gems": 5, "api_key": "${KEY}", "note": "${KEY}", "owner": "dev@example.com", "bearerToken": "x", "tip": "Opens daily"},
	{"id": "weekly", "name": "Weekly chest", "gems": 20, "tip": "Opens weekly"},
]
`,
  );
  writeFileSync(
    join(src, "config", "local_levels.json"),
    JSON.stringify([
      { id: "l1", name: "Level one", moves: 20, server_token: JWT, label: JWT, contact: "me@example.com" },
      { id: "l2", name: "Level two", moves: 25 },
    ]),
  );
  const codex = scanCodex(src, { game: "Leaky" });
  const text = JSON.stringify(codex);
  for (const bad of [KEY, JWT, "dev@example.com", "me@example.com", "Api key", "Server token", "Bearer"]) assert.ok(!text.includes(bad), `leaked: ${bad}`);
  const daily = codex.entries.find((e) => e.name === "Daily chest");
  assert.ok(daily, "the entry itself stays");
  assert.ok(daily.numbers.some((n) => n.label === "Gems"));
  assert.ok(daily.facts.some((f) => f.value === "Opens daily"));
});

test("scan: gitignored and dot files are never read", () => {
  const src = mkdtempSync(join(tmpdir(), "codex-ignore-"));
  const git = (...a) => execFileSync("git", ["-C", src, ...a], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(src, "project.godot"), "[application]\n");
  writeFileSync(join(src, ".gitignore"), "local/\nsecrets.gd\n");
  mkdirSync(join(src, "local"));
  writeFileSync(join(src, "local", "levels.json"), JSON.stringify([{ id: "hidden", name: "Hidden level", moves: 1 }]));
  writeFileSync(join(src, "secrets.gd"), 'const SECRET_DEFS := [{"id": "x", "name": "Ignored thing", "n": 1}]\n');
  writeFileSync(join(src, ".dev.json"), JSON.stringify([{ id: "dot", name: "Dot file thing", moves: 1 }]));
  writeFileSync(join(src, "levels.json"), JSON.stringify([{ id: "shown", name: "Shown level", moves: 3 }, { id: "shown2", name: "Another level", moves: 4 }]));
  assert.ok(gitFiles(src).has("levels.json"));
  assert.ok(!gitFiles(src).has("local/levels.json"));
  const names = scanCodex(src, { game: "G" }).entries.map((e) => e.name);
  assert.ok(names.includes("Shown level"));
  for (const n of ["Hidden level", "Ignored thing", "Dot file thing"]) assert.ok(!names.includes(n), n);
});

test("secret filters: names, values, numbers and whole entries", () => {
  for (const k of ["api_key", "apiKey", "API-KEY", "server_token", "Auth header", "password", "client_secret", "private_key", "email", "webhook_url", "credentials"]) assert.ok(sensitiveKey(k), k);
  for (const k of ["author", "damage", "gems", "Tokens", "auth_level"]) assert.ok(!sensitiveKey(k, true), k);
  for (const v of [KEY, JWT, "-----BEGIN PRIVATE KEY-----", "AKIAIOSFODNN7EXAMPLE", "ghp_" + "a".repeat(30), "https://user:pw@host.example/x", "a".repeat(40), "Zm9vYmFyQmF6MTIzNDU2Nzg5MEFiQ2RFZkdoSWo=", "me@example.com"]) assert.ok(looksLikeSecret(v), v);
  for (const v of ["Opens the daily chest", "Burns the nearest foe", "res://src/core/pieces.gd", "Summons two helpers"]) assert.ok(!looksLikeSecret(v), v);
  const r = scrubEntry({ id: "a/b", key: "b", name: "Thing", what: KEY, numbers: [{ label: "Hp", value: 5 }, { label: "Api key", value: 123456 }], facts: [{ label: "Note", value: JWT }, { label: "Kind", value: "Fire" }] });
  assert.deepEqual(r.entry.numbers, [{ label: "Hp", value: 5 }]);
  assert.deepEqual(r.entry.facts, [{ label: "Kind", value: "Fire" }]);
  assert.equal(r.entry.what, null);
  assert.equal(r.entry.needs_description, true);
  assert.equal(scrubEntry({ id: "a/b", key: "b", name: KEY, numbers: [], facts: [] }).entry, null);
});

test("secret filters: pass, pw, passphrase, session/license keys, salts, phone numbers, split keys", () => {
  for (const k of ["pass", "pw", "passphrase", "Passphrase", "session_key", "sessionKey", "license_key", "licenseKey", "hmac_salt", "signing_key", "master_key", "db_pass", "phone", "phone_number", "userPhone"]) assert.ok(sensitiveKey(k), k);
  for (const k of ["battle_pass", "battle_pass_cost", "phone_booth", "key", "keys", "monkey", "salty", "pinned"]) assert.ok(!sensitiveKey(k), k);
  for (const k of ["pw", "passcode", "hmac_salt", "phone", "session_key"]) assert.ok(sensitiveKey(k, true), k);
  for (const k of ["battle_pass", "master_key_cost", "key_count", "salt", "gems"]) assert.ok(!sensitiveKey(k, true), k);
  for (const v of ["+1 (555) 123-4567", "555-123-4567", "+15551234567", "sk_live_51Hx · AbCdEf12", '"sk_live_" + "51HxAbCdEf12"']) assert.ok(looksLikeSecret(v), v);
  const lore = "In the cold hills above Ashford the old bell-ringers kept a ledger of every storm that crossed the valley, Ada, Bea and Cyrus 2 1 0 3 4 5 6 7 8 9, and none were forgotten.";
  for (const v of [lore, "#3B2216", "Season 1", "100 / 200 / 3000", "Level 10 20 30 40", "Color(\"#3B2216\")"]) assert.ok(!looksLikeSecret(v), v);
  const r = scrubEntry({ id: "a/b", key: "b", name: "Thing", what: lore, numbers: [{ label: "pw", value: 1234 }, { label: "Hp", value: 5 }], facts: [{ label: "pass", value: "x" }, { label: "Support", value: "+1 555 123 4567" }, { label: "Split", value: "sk_live_51Hx · AbCdEf12" }, { label: "Colour", value: "#3B2216" }] });
  assert.deepEqual(r.entry.numbers, [{ label: "Hp", value: 5 }]);
  assert.deepEqual(r.entry.facts, [{ label: "Colour", value: "#3B2216" }]);
  assert.equal(r.entry.what, lore);
});

test("payload filters again: an old or hand-edited codex.json cannot send a secret", () => {
  const p = codexPayload({
    schema: "gamedexy.codex/1",
    source: {},
    entries: [{ id: "a/b", key: "b", name: "Thing", category: "a", what: null, needs_description: true, numbers: [], facts: [{ label: "Api key", value: KEY }, { label: "Kind", value: "Fire" }], defined_at: { file: "x.gd", line: 1 }, found_by: "table" }],
  });
  assert.deepEqual(p.entries[0].facts, [{ label: "Kind", value: "Fire" }]);
});

test("relativeTo is a real path check: a sibling folder with the same prefix is not inside", () => {
  assert.equal(relativeTo("/x/codex", "/x/codex/images/a.png"), join("images", "a.png"));
  assert.equal(relativeTo("/x/codex", "/x/codex"), ".");
  assert.equal(relativeTo("/x/codex", "/x/codex-images/a.png"), resolve("/x/codex-images/a.png"));
  assert.equal(relativeTo("/x/codex", "/y/a.png"), resolve("/y/a.png"));
});

test("hook path becomes a res:// path with forward slashes", () => {
  assert.equal(hookResPath("gamedexy_codex.gd"), "res://gamedexy_codex.gd");
  assert.equal(hookResPath("gamedexy\\codex.gd"), "res://gamedexy/codex.gd");
  assert.equal(hookResPath("./gamedexy/codex.gd"), "res://gamedexy/codex.gd");
  assert.equal(hookResPath("res://gamedexy/codex.gd"), "res://gamedexy/codex.gd");
});

test("a Godot .cmd shim on Windows is refused with a plain message", () => {
  assert.throws(() => checkGodotBin("C:\\tools\\godot.cmd", "win32"), /\.exe itself/);
  assert.equal(checkGodotBin("C:\\tools\\Godot.exe", "win32"), "C:\\tools\\Godot.exe");
  assert.equal(checkGodotBin("/usr/bin/godot.cmd", "darwin"), "/usr/bin/godot.cmd");
});

test("scan skips a gamedexy/ folder (hooks and codex output kept there)", () => {
  const src = game({});
  mkdirSync(join(src, "gamedexy"), { recursive: true });
  writeFileSync(join(src, "gamedexy", "stuff.json"), JSON.stringify([{ id: "z1", name: "Zed one", hp: 1 }, { id: "z2", name: "Zed two", hp: 2 }]));
  const names = scanCodex(src, { game: "G" }).entries.map((e) => e.name);
  assert.ok(!names.includes("Zed one"));
});
