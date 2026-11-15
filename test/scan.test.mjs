import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
