---
name: gamedexy-game-map
description: Map the user's own mobile game with Gamedexy Game Map. Scan the code, open and screenshot every screen and level straight from the code (capture first), optionally play the first session, label each screen with the Gamedexy taxonomy, and upload a private map compared with real top games. Use when the user asks to "map my game", "run Game Map", or wants their game's screens, flows, monetization or bugs captured.
---

# Gamedexy Game Map

You map the developer's OWN game: a build they make from the project open in front of you. Game Map
is **capture first**: the CLI reads the code, then opens every screen and level directly and
screenshots it, so the map does not depend on how well you play. The result is a private map on
gamedexy.com: every screen, how they connect, money and ads, bugs, Before you submit checks and a
comparison with library games, kept across builds (fixed, still open, came back).

Tools: the `gamedexy` CLI (`npx gamedexy`, JSON out; after `gamedexy login` it makes every Gamedexy
call) and optionally the Gamedexy MCP (`map_*`). Also here: `DEEP.md` (deep runs), `ENGINES.md`.

## Hard rules

1. **Never complete a purchase, subscription or payment.** Tap only with `gamedexy map tap`. It
   refuses prices, buy words, ads and sign-in, and stops when a purchase sheet is open. Do not work
   around a refusal. Never use another tap tool while mapping.
2. **Own builds only.** Never map an App Store or Play Store download, or someone else's game.
3. **Screens and labels only.** Never send source code, builds, keys or account details to
   Gamedexy. The inventory is names and file locations.
4. **Ask before changing code.** The capture list, a fix or any debug state is a change to the
   developer's repo: show it and get their yes first. It goes on its own branch (for example
   `gamedexy/capture`), never their main branch, in debug builds only, and
   `gamedexy doctor --release-app` must prove it is out of Release.
5. **Only the game.** Taps are refused while another app is in front. Relaunch with
   `gamedexy map launch` and carry on.
6. **Never wipe what you did not create.** Only `gamedexy map start --fresh` resets anything. Never
   run `simctl erase`, `simctl keychain reset` or `pm clear` yourself.
7. **Ask before every run, every fix and every re-run.** Runs use the developer's own AI plan.

## Steps

0. **Ask which run.** Show this and let the developer choose; suggest the capture run.

   | | Capture run (suggested) | + First session | Deep run |
   |---|---|---|---|
   | Covers | Every screen and level from the code, how they connect, money, bugs, checks | Also the real order a new player sees, played | Also days 1 to 7, notifications, big text, languages, offline |
   | Time | About 10 minutes after the one-time capture list | +10 to 20 minutes | About 45 minutes |
   | Your AI plan | Light (no playing) | Medium | Heavy |

   Quick run (suggested) is the capture run: never start by playing.

1. **Check the setup.** `gamedexy login` once (Game Map needs Pro). Then `gamedexy doctor --platform
   ios|android --device <id> --app-id <bundle> [--app <.app>]`; fix every failed check. iOS: build
   ad hoc signed (`CODE_SIGN_IDENTITY=-`). Godot or Unity: read `ENGINES.md`. Windows runs Android only.

2. **Scan, then read only what is unsure.** `gamedexy scan --src <repo> --out <run folder>` (no AI,
   nothing uploaded) writes `scan.json` (screens, navigation, tabs, levels, products, ads,
   notifications, the capture checklist) and a draft `inventory.json`. Read only the files under
   `unsure`, then complete products (type, price), currencies and events. Shape (no code):

   ```json
   {"screens": [{"key": "HomeView", "where": "Home/HomeView.swift:12", "screen_keys": ["home"]}],
    "products": [{"id": "com.studio.gems100", "type": "consumable", "price": "$0.99", "grants": "100 gems"}],
    "ads": [{"key": "rewarded_double", "format": "rewarded", "where": "Ads.swift:40"}],
    "currencies": [{"key": "gems", "kind": "premium"}], "events": [{"key": "winter", "name": "Winter Fest", "ends": "2026-12-31"}],
    "review_prompts": [{"file": "Review.swift:8", "trigger": "after the third win"}]}
   ```
   Every item needs `key` (`id` for products). `screen_keys` are the map keys for each code screen.

3. **The capture list (once per game, with their yes).** On a branch (`git switch -c
   gamedexy/capture`): `gamedexy capture init --src <repo> --scan <run folder>/scan.json` writes a
   debug-only `GamedexyCapture` file that reads `-gdxState`. Wire each key where the scan says that
   screen opens, the level parameter where a run starts, and `clock=Nd` (the game's day N days on)
   for a deep run. Show the diff, build Debug, and run `gamedexy doctor --release-app <Release build>`.

4. **Start.** `gamedexy map start --dir <run folder> --platform ios|android --device <id> --app-id
   <bundle> --app <path> --game "<name>" --engine <engine> --genre <genre> --depth quick|deep
   --inventory inventory.json --src <repo>`. It opens the run and writes `run-rules.json`.

5. **Capture every screen.** `gamedexy map capture --dir <dir> --scan <run folder>/scan.json --all`.
   It launches each key, waits for the screen to settle, screenshots it and writes `labels.json`
   from the keys and the code's navigation. It never taps. Keys under `failed` (the start screen
   again, a duplicate, a purchase sheet) are not labelled: fix their wiring with the developer's
   yes, rebuild, and run `--only key1,key2` into the same run. Retakes never cost another run:
   only the newest good shot of each screen is sent.

6. **Optional: play the first session** when the developer asked for it: `gamedexy map launch`,
   then after every move `gamedexy map shot --dir <dir> --action "<what you did>"` (look at the
   thumbnail only when `new: true`), `map find --text SHOP`, `map tap --x --y --label SHOP`.
   A refusal is final. Do not grind: what you cannot reach was already captured in step 5.
   Deep run: now follow `DEEP.md` (days with `gamedexy map days --days 1-7`, variants).

7. **Label and send.** Check `labels.json`: titles in plain words, a category from
   `run-rules.json` for every screen (`needs_category` lists the missing ones), tags and
   `proposed_tags`. Label any played steps too:
   `{"screens": {"<key>": {"title", "category", "tags", "proposed_tags", "confidence"}}, "steps": {"<n>": ["<key>", "<note>"]}}`.
   Then `gamedexy map send --dir <dir> --labels <dir>/labels.json`. If the reply lists
   `personal_data`, tell the developer which steps may show real people's data.

8. **Finish.** `gamedexy map stats --dir <dir>` lists issue hints. Check each against its screenshot
   and save the real ones as `issues.json` (`[{"step", "kind", "detail"}]`; kinds: crash, dead_tap,
   stuck, error_text, not_loading, clipped_text, stale_content, unreachable, other), quoting the
   exact text on screen. Then `gamedexy map finish --dir <dir> --issues issues.json`
   (`--compare "Royal Match,Block Blast"` if the developer named games).

9. **Report.** Give the map link and walk the developer through Summary: every screen, how they
   connect, the levels, then the fixes in order, Findings, Economy and Benchmarks.

10. **Fix and map again, only with their yes.** For each fix: say what you would change, wait for
   their yes, change it, show the diff. On the next build, a capture run is cheap: start a new run
   folder and run step 5 again (no playing). A played route replays with `gamedexy map route` and
   `gamedexy map replay` (`gamedexy help`). An account keeps 20 runs that hold screenshots.

No `gamedexy login` (an agent that uses the MCP directly): call `map_create_game`,
`map_start_run`, `map_set_inventory` yourself, then `gamedexy map set-run`, `map payload` and
`map upload` instead of `--game`, `send` and `finish` (`gamedexy help deep`).

## Tell Gamedexy what got in your way

Leave a short note when you get stuck, cannot open a screen, find a tool missing or confusing, or
something works well: `gamedexy map feedback --dir <dir> --kind
stuck|unreachable|missing-tool|tool-bug|confusing|slow|idea|praise --text "..." [--step N]`. CLI errors
are noted automatically. Notes go with `map_finish_run`, are shown to the developer on their map and
carry no code. The developer can turn them off with `GAMEDEXY_NO_FEEDBACK=1`; tell them you sent notes.
