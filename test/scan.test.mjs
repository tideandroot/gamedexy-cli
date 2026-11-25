import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { captureInit } from "../src/capture.mjs";
import { scanGodotCode } from "../src/godot-code.mjs";
import { validateInventory } from "../src/map.mjs";
import { guessCategory, scan, scanRepo, screenKey, stripComments, toInventory } from "../src/scan.mjs";

const fx = (name) => join(dirname(fileURLToPath(import.meta.url)), "fixtures", "scan", name);
const keys = (r) => r.screens.map((s) => s.key).sort();
const edge = (r, from, to) => r.edges.find((e) => e.from === from && e.to === to);

test("screen keys and categories come from code names", () => {
  assert.equal(screenKey("ShopSheet"), "shop");
  assert.equal(screenKey("FakeAdView"), "fake_ad");
  assert.equal(screenKey("HUDView"), "hud");
  assert.equal(screenKey("main_menu.tscn"), "main_menu");
  assert.equal(screenKey("View"), "view");
  assert.equal(guessCategory("shop_wick"), "shop");
  assert.equal(guessCategory("login_reward_card"), "daily_reward");
  assert.equal(guessCategory("leaderboard"), "leaderboard");
  assert.equal(guessCategory("starter_offer"), "offer");
  assert.equal(guessCategory("result"), "results");
  assert.equal(guessCategory("menu"), "home");
});

test("comments are blanked, strings and line numbers kept", () => {
  const src = 'let a = "http://x" // ShopView()\n/* NavigationLink(\n */ b()';
  const out = stripComments(src);
  assert.ok(out.includes('"http://x"'));
  assert.ok(!out.includes("ShopView"));
  assert.equal(out.split("\n").length, 3);
});

test("Swift: sheets, pushes, alerts, overlays, tabs, products, notifications, review, dates", () => {
  const r = scanRepo(fx("swift"));
  assert.equal(r.engine, "swift");
  assert.deepEqual(keys(r).filter((k) => !k.startsWith("home_")), ["home", "level_map", "shop", "win"]);
  assert.equal(edge(r, "launch", "home").kind, "root");
  assert.equal(edge(r, "home", "shop").kind, "sheet");
  assert.equal(edge(r, "home", "shop").trigger, "showShop = true");
  assert.equal(edge(r, "home", "level_map").kind, "push");
  assert.equal(edge(r, "home", "win").kind, "overlay");
  assert.ok(r.screens.some((s) => s.kind === "alert" && s.name === "Out of lives"));
  assert.deepEqual(r.screens.find((s) => s.key === "shop").tabs, [{ state: "tab", type: "Tab", values: ["gems", "coins"] }]);
  assert.ok(r.checklist.some((c) => c.key === "shop_gems" && c.open === "screen=shop,tab=gems" && c.category === "shop"));
  assert.deepEqual(r.products.map((p) => p.id), ["com.pebble.gems100"]);
  assert.equal(r.notifications[0].title, "Your lives are full");
  assert.equal(r.review_prompts.length, 1);
  assert.equal(r.date_reads.length, 1);
  assert.deepEqual(r.currencies.map((c) => c.key).sort(), ["coins", "gems"]);
  assert.ok(r.unsure.some((u) => u.name === "OrphanScreen"));
  assert.ok(!r.edges.some((e) => e.where.includes(":10")), "a commented-out view opens nothing");
});

test("Kotlin: manifest launcher, NavHost routes, navigate, dialogs, billing, rewarded ad", () => {
  const r = scanRepo(fx("kotlin"));
  assert.equal(r.engine, "kotlin");
  assert.ok(keys(r).includes("home") && keys(r).includes("shop") && keys(r).includes("main"));
  assert.equal(edge(r, "launch", "main").kind, "root");
  assert.equal(edge(r, "launch", "home").trigger, "NavHost start");
  assert.equal(edge(r, "home", "shop").trigger, 'navigate("shop")');
  assert.ok(r.edges.some((e) => e.from === "home" && e.kind === "sheet" && e.trigger === "showOffer"));
  assert.deepEqual(r.products.map((p) => p.id), ["gems_100"]);
  assert.equal(r.ads[0].format, "rewarded");
  assert.deepEqual(r.currencies.map((c) => c.key), ["coins"]);
});

test("Godot: scenes, main scene, scene change, popup and hidden panel", () => {
  const r = scanRepo(fx("godot"));
  assert.equal(r.engine, "godot");
  assert.deepEqual(keys(r), ["level", "main_menu", "main_menu_settings", "main_menu_shop"]);
  assert.equal(edge(r, "launch", "main_menu").kind, "root");
  assert.equal(edge(r, "main_menu", "level").kind, "scene");
  assert.equal(edge(r, "main_menu", "main_menu_shop").trigger, "$ShopPopup.popup_centered()");
  assert.ok(r.screens.find((s) => s.key === "main_menu_settings").kind === "modal");
  assert.equal(r.date_reads.length, 1);
  assert.deepEqual(r.currencies.map((c) => c.key), ["coins"]);
});

test("Unity: build scenes, LoadScene from the scene that uses the script, panels, IAP, ads", () => {
  const r = scanRepo(fx("unity"));
  assert.equal(r.engine, "unity");
  assert.ok(["game", "menu", "shop"].every((k) => keys(r).includes(k)), keys(r).join(","));
  assert.equal(edge(r, "launch", "menu").kind, "root");
  assert.equal(edge(r, "menu", "game").trigger, 'LoadScene("Game")');
  assert.equal(edge(r, "menu", "shop").trigger, "shopPanel.SetActive(true)");
  assert.deepEqual(r.products.map((p) => [p.id, p.type]), [["gems_500", "consumable"]]);
  assert.equal(r.ads[0].format, "rewarded");
  assert.deepEqual(r.currencies.map((c) => c.key), ["gems"]);
});

test("the draft inventory is one map start accepts, and scan writes both files", () => {
  for (const e of ["swift", "kotlin", "godot", "unity"]) assert.deepEqual(validateInventory(toInventory(scanRepo(fx(e)))), [], e);
  const out = mkdtempSync(join(tmpdir(), "gdx-scan-"));
  const res = scan({ src: fx("swift"), out });
  assert.equal(res.ok, true);
  const inv = JSON.parse(readFileSync(res.inventory, "utf8"));
  assert.deepEqual(inv.screens.find((s) => s.key === "ShopView").screen_keys, ["shop_gems", "shop_coins"]);
  const text = readFileSync(res.scan, "utf8");
  assert.ok(!text.includes("Product.products(for"), "no code in scan.json, only names and places");
  assert.throws(() => scanRepo(join(out, "missing")), /--src/);
});

test("levels: a list literal with names and unlock values, an enum, and level files", () => {
  const sw = scanRepo(fx("swift"));
  assert.equal(sw.levels.length, 1);
  assert.deepEqual(
    { type: sw.levels[0].type, count: sw.levels[0].count, unlock_rule: sw.levels[0].unlock_rule, param: sw.levels[0].param },
    { type: "World", count: 3, unlock_rule: "starsToUnlock", param: "world" },
  );
  assert.deepEqual(sw.levels[0].items.map((i) => [i.key, i.id, i.unlock.value]), [["pebble_beach", 0, 0], ["moss_cave", 1, 12], ["sky_garden", 2, 30]]);
  assert.ok(sw.checklist.some((c) => c.key === "world_moss_cave" && c.level === "moss_cave" && /,world=1$/.test(c.open)));
  assert.deepEqual(toInventory(sw).levels.items.map((i) => i.name), ["Pebble Beach", "Moss Cave", "Sky Garden"]);
  const kt = scanRepo(fx("kotlin"));
  assert.deepEqual(kt.levels[0].items.map((i) => i.name), ["FOREST", "RIVER", "PEAK"], "LevelUp is not a level");
  assert.ok(kt.unsure.some((u) => u.name === "Chapter" && /unlock/.test(u.reason)));
  const gd = scanRepo(fx("godot"));
  assert.deepEqual([gd.levels[0].kind, gd.levels[0].count, gd.levels[0].items[2].name], ["files", 3, "level_3"]);
  assert.deepEqual(keys(gd), ["level", "main_menu", "main_menu_settings", "main_menu_shop"], "level data files are not screens");
  assert.equal(scanRepo(fx("unity")).levels[0].count, 2);
  for (const e of ["swift", "kotlin", "godot", "unity"]) assert.deepEqual(validateInventory(toInventory(scanRepo(fx(e)))), [], e);
});

test("Godot code-built screens: UI scripts made with .new(), string and enum dispatch, show_* variants, popups", () => {
  const r = scanRepo(fx("godot_code"));
  const s = (k) => r.screens.find((x) => x.key === k);
  const call = (k) => `${s(k).code.call}(${s(k).code.args.join(",")})`;
  // Scripts that extend a UI node, are made with .new() and added to the tree (the CoinIcon widget and the test-only script are not screens).
  assert.equal(s("shop_sheets").sure, true);
  assert.equal(s("pause").sure, true);
  assert.ok(!keys(r).includes("coin_icon") && !keys(r).some((k) => /test_only/.test(k)));
  assert.equal(edge(r, "boot", "shop_sheets").trigger, "ShopSheets.new() + add_child");
  assert.equal(edge(r, "boot", "pause").kind, "overlay");
  // A Node2D named like a world is a guess, and its start function is the way in.
  assert.equal(s("world").sure, false);
  assert.equal(call("world"), "start_run()");
  // `match _active_sheet:` with a builder per arm: one sheet per arm, opened by the function that sets the variable.
  assert.deepEqual(["upgrades", "shop", "map"].map((a) => call(`shop_sheets_${a}`)), ['open_sheet("upgrades")', 'open_sheet("shop")', 'open_sheet("map")']);
  assert.equal(s("shop_sheets_map").kind, "sheet");
  assert.equal(s("shop_sheets").kind, "container");
  assert.equal(edge(r, "shop_sheets_upgrades", "shop_sheets_shop").trigger, 'open_sheet("shop")'); // button inside the upgrades builder
  // show_* paired with _build_*_overlay is a variant; two show_* functions make two variants with placeholder arguments.
  assert.equal(call("shop_sheets_celebration"), 'show_celebration("","")');
  assert.equal(edge(r, "boot", "shop_sheets_celebration").trigger, "show_celebration()"); // receiver typed `ShopSheets`
  assert.equal(call("pause_pause"), "show_pause(0,0)");
  assert.equal(call("pause_result"), "show_result(false,0)");
  assert.equal(s("pause_result").sure, false);
  assert.equal(s("pause_result").code.guessed_args, true);
  // A popup made in code.
  assert.equal(s("pause_dlg").kind, "modal");
  assert.equal(s("pause_dlg").sure, true);
  assert.equal(s("pause_dlg").code.private, true);
  assert.equal(edge(r, "pause", "pause_dlg").trigger, "ConfirmationDialog.new() in _ask_quit()");
  // An enum of screens: one screen per value, opened through the function that takes the enum, transitions as edges.
  assert.deepEqual(["home", "shop", "settings"].map((v) => call(`flow_root_${v}`)), ["go_to(0)", "go_to(1)", "go_to(2)"]);
  assert.equal(s("flow_root_shop").why, "Screen.SHOP in enum Screen");
  assert.equal(edge(r, "flow_root_home", "flow_root_shop").kind, "push");
  assert.equal(edge(r, "flow_root_shop", "flow_root_home").trigger.includes("Screen.HOME"), true);
  // A screen-named script nothing creates is listed, as a guess, and flagged unsure.
  assert.equal(s("reward").sure, false);
  assert.ok(r.unsure.some((u) => u.name === "RewardScreen" && /nothing in code creates it/.test(u.reason)));
  // Containers are not captured; every captured code-built screen carries how to open it.
  assert.ok(!r.checklist.some((c) => c.key === "shop_sheets" || c.key === "flow_root"));
  assert.ok(r.checklist.filter((c) => c.key.startsWith("shop_sheets_")).every((c) => c.code?.path === "res://src/ui/shop_sheets.gd"));
  assert.deepEqual(validateInventory(toInventory(r)), []);
});

test("Godot code-built scan leaves scene games alone", () => {
  const r = scanRepo(fx("godot"));
  assert.ok(r.screens.every((s) => !s.code));
});

test("Godot code-built scan: no false screens from widgets, scene scripts, data classes, dead classes or odd code", () => {
  const r = scanRepo(fx("godot_code_negative"));
  const ks = keys(r);
  const s = (k) => r.screens.find((x) => x.key === k);
  // Helper widgets that only contain a screen word in the middle of the name.
  for (const w of ["shop_item_card", "settings_toggle", "result_row", "menu_button_big", "page_dots"]) assert.ok(!ks.includes(w), w);
  // Gameplay and scene-change functions on scene scripts are not screens, and no scene gets an opener (the main scene least of all).
  assert.ok(!ks.some((k) => /^(level|main)/.test(k) && !["level", "main_menu", "main"].includes(k)), ks.join());
  assert.ok(["level", "main_menu", "main"].every((k) => s(k) && !s(k).code));
  assert.ok(r.checklist.every((c) => !["level", "main_menu", "main"].includes(c.key) || !c.code));
  // Resource data classes are not screens, whatever they are called.
  assert.ok(!r.screens.some((x) => x.name === "Level" && x.code) && !ks.includes("cut"));
  // A class nothing creates: its children are guesses too, and carry guessed arguments.
  assert.equal(s("dead_hub").sure, false);
  for (const k of ["dead_hub_play", "dead_hub_shop", "dead_hub_celebration"]) assert.equal(s(k).sure, false, k);
  assert.equal(s("dead_hub_play").code.guessed_args, true);
  assert.equal(s("arena").sure, false);
  assert.equal(s("arena").code.guessed_args, true, "all defaults, class never made, is still a guess");
  // A required object argument has no safe placeholder: no opener, and it says so.
  assert.ok(s("summary") && !s("summary").code?.call);
  assert.ok(r.unsure.some((u) => u.name === "summary" && /object argument \(stats\)/.test(u.reason)));
  // A match expression that is not a plain variable does not stop the scan (and does not become a regex).
  assert.ok(s("odd"));
  assert.ok(!r.unsure.some((u) => /could not read this script/.test(u.reason)));
  assert.deepEqual(validateInventory(toInventory(r)), []);
});

test("Godot code scan: one unreadable script never aborts the scan", () => {
  const files = [{ rel: "a.gd", name: "a.gd", ext: ".gd", get text() { throw new Error("boom"); } }, { rel: "b.gd", name: "b.gd", ext: ".gd", text: "class_name ShopScreen\nextends Control\n" }];
  const out = { screens: [], edges: [], unsure: [] };
  const ctx = { addScreen: (x, s) => x.screens.push(s), addEdge: () => {}, lineAt: () => 1, screenKey: (n) => n.toLowerCase(), isTest: () => false, scriptScenes: new Map(), ownersOf: () => [] };
  scanGodotCode(out, files, ctx);
  assert.ok(out.unsure.some((u) => u.where === "a.gd:1" && /could not read/.test(u.reason)));
  assert.ok(out.screens.some((x) => x.key === "shopscreen"));
});

test("Godot code scan: a code-built key that matches a scene key never takes over the scene's screen", () => {
  const r = scanRepo(fx("godot_code_collision"));
  const s = (k) => r.screens.find((x) => x.key === k);
  assert.equal(s("main_menu").why, "Godot scene");
  assert.equal(s("main_menu").sure, true);
  assert.ok(!s("main_menu").code, "the scene screen carries no code");
  assert.ok(s("main_menu_code") && s("main_menu_code").code, "the enum child is kept under a distinct key");
  assert.ok(r.unsure.some((u) => u.name === "main_menu_code" && /already a screen from a scene/.test(u.reason)));
  assert.ok(r.checklist.every((c) => c.key !== "main_menu" || !c.code));
  assert.deepEqual(validateInventory(toInventory(r)), []);
  const c = captureInit({ src: fx("godot_code_collision"), dryRun: true }).content;
  assert.ok(!c.includes('"main_menu":'), "no OPENERS entry for the scene key");
  assert.ok(c.includes('"main_menu_code":'));
});

test("Godot code scan: one-line class_name + extends, required _init, and classes nothing creates", () => {
  const r = scanRepo(fx("godot_code_edge"));
  const s = (k) => r.screens.find((x) => x.key === k);
  // `class_name X extends Control` on one line is a UI script like the two-line form.
  assert.ok(s("one_line") && s("one_line").sure, "one-line class_name + extends");
  assert.ok(s("one_line_rewards") && s("one_line_offers"));
  // A required _init parameter: no opener, never sure, listed as unsure (like an object argument).
  assert.ok(s("needs_arg") && !s("needs_arg").sure && !s("needs_arg").code);
  assert.ok(!r.screens.some((x) => x.key.startsWith("needs_arg") && x.code));
  assert.ok(r.unsure.some((u) => u.name === "needs_arg" && /_init\(count\) needs an argument/.test(u.reason)));
  // A class nothing creates: code marked live: false, and no OPENERS line.
  assert.equal(s("dead").code.live, false);
  const c = captureInit({ src: fx("godot_code_edge"), dryRun: true }).content;
  const lines = c.split("\n").filter((l) => l.startsWith("\t\"") && l.includes('"path"'));
  assert.ok(!lines.some((l) => /^\t"(dead|needs_arg)/.test(l)), lines.join("\n"));
  assert.ok(c.includes('"one_line_rewards": {"path": "res://src/ui/one_line_screen.gd"'));
  assert.ok(c.includes("_needs_init_args(script)") && c.includes("get_script_method_list()"));
  // The autoload refuses these with a warning (could not be loaded or made).
  assert.ok(c.includes("could not be loaded or made") && !c.includes("is not a Node script"));
  // guessed arguments are never sure.
  const g = scanRepo(fx("godot_code")).screens.find((x) => x.key === "shop_sheets_celebration");
  assert.equal(g.code.guessed_args, true);
  assert.equal(g.sure, false);
});

test("Godot capture file: the seed only applies to a launch with -gdxState", () => {
  const c = captureInit({ src: fx("godot_code"), dryRun: true, seed: 7 }).content;
  assert.match(c, /func seed_value\(\) -> int:\n\tif not OS\.is_debug_build\(\) or not _launched:\n\t\treturn -1/);
  assert.ok(c.indexOf("_launched = true") > c.indexOf('args.find("-gdxState")'));
});

test("Godot capture list: classes nothing creates (arena, dead_hub) are left off by default and never get an OPENERS line", () => {
  const opener = (c, k) => c.split("\n").some((l) => l.startsWith(`\t"${k}":`));
  const d = captureInit({ src: fx("godot_code_negative"), dryRun: true });
  assert.ok(!d.content.includes('"arena"') && !d.content.includes('"dead_hub_play"'), "left off the checklist");
  assert.equal(d.left_out, 4);
  assert.deepEqual(d.left_out_keys.sort(), ["arena", "dead_hub_celebration", "dead_hub_play", "dead_hub_shop"]);
  const all = captureInit({ src: fx("godot_code_negative"), dryRun: true, includeDead: true });
  assert.ok(all.content.includes('"arena"'), "--include-dead lists them in SCREENS");
  assert.ok(!opener(all.content, "arena") && !opener(all.content, "dead_hub") && !opener(all.content, "dead_hub_play"), "but still no opener");
  assert.equal(all.left_out, undefined);
});
