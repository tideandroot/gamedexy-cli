# gamedexy

Your AI coding agent can build a mobile game. This CLI lets it read your game's code, open every
screen and level on the iOS Simulator or an Android emulator, and map it with
[Gamedexy Game Map](https://www.gamedexy.com/game-map): every screen and how they connect, where
money and ads appear, possible bugs, a week of daily rewards and notifications, and how all of it
compares with real top-grossing games. It can also play the first session when you want the real
order a new player sees.

It works with Claude Code, Codex, Cursor and any agent that can run shell commands.

## Start

```bash
npx gamedexy init
```

That installs the agent skill, connects the Gamedexy MCP (Claude Code, Codex and Antigravity/Gemini, whichever are
installed) and checks what this machine can map. For Antigravity it adds a `gamedexy` entry to
`~/.gemini/config/mcp_config.json` (only if `agy` or that folder exists): your other servers are kept, an existing
`gamedexy` entry is never changed, no token is written, the old file is saved once as `mcp_config.json.bak-gamedexy-init`,
and `--dry-run` shows the diff. The entry is the `npx -y mcp-remote@0.16.7 https://www.gamedexy.com/api/mcp` bridge, which
opens the browser to sign in and works in `agy`; `gamedexy init --agent antigravity --transport url` writes Antigravity's
native `serverUrl` entry instead (its sign-in is documented for the desktop app, so the bridge is the default). Then open your game's project in your agent and say:

> Map my game with Gamedexy

The map appears, privately, at gamedexy.com/my-games/map. Game Map needs a Gamedexy Pro plan.

## Game Codex

Every die, enemy, boss, upgrade, perk and item your game defines, with what it does, its key numbers
and the file and line it lives in, read from the code with no AI:

```bash
npx gamedexy codex scan --src .            # writes codex.json; your agent fills the missing descriptions
npx gamedexy codex render --src . --codex ~/.gamedexy/codex/<game>/codex.json   # optional pictures (Godot hook)
npx gamedexy codex send --codex ~/.gamedexy/codex/<game>/codex.json --game "My Game"
```

`codex send` and `map start` look your games up first and reuse the one that matches (`--game` takes a slug, an id or
a name). If several could be meant they stop and list them instead of guessing (`--create-new` makes a new game anyway).
A picture that fails to upload does not stop the others: the failures are listed and the exit code is 1.

Each version shows what changed since the last one on the map's Codex tab. Pictures come from a
small debug-only render hook in your game (`gamedexy/codex.gd`, see the design note), run in a
window for a few seconds.

## What it will and will not do

- **Never buys anything.** Every tap is checked against the screen first. Prices, buy and
  subscribe buttons, rewarded ads and sign-in are refused in nine languages, and an open purchase
  sheet stops all input. These rules are in code (`src/guard.mjs`), not in the agent's prompt.
- **Your own builds only**, on simulators and emulators. Never a store download, never a real phone.
- **Never wipes what it did not create.** A fresh install resets only your game, after backing up
  its data, or a simulator this tool made.
- **Asks before changing code.** Optional debug shortcuts go on their own branch, in debug builds
  only, and `gamedexy doctor --release-app` proves they are absent from Release.
- **Sends screenshots and labels only**, to short-lived private upload links, never your source
  code or build. Text is read on your machine (Apple Vision on a Mac, the Android UI dump elsewhere).
- **Agent notes.** When the agent gets stuck it can leave Gamedexy a short note, scrubbed of paths,
  emails and keys and shown to you on your map. Turn this off with `GAMEDEXY_NO_FEEDBACK=1`.

## Needs

- Node 20 or newer.
- iOS: a Mac with Xcode, and a tap tool ([AXe](https://github.com/cameroncooke/AXe):
  `brew install cameroncooke/axe/axe`, or idb).
- Android: Android platform-tools (`adb`) and an emulator.

Before anything runs, `gamedexy scan --src <repo>` reads your code on your machine (plain code, no
AI, nothing uploaded) and lists every screen, which screen opens which, store products, ads and
notifications, so the agent knows what to capture without guessing. Swift, Kotlin, Godot and Unity. Godot screens built in GDScript (no `.tscn`) are found too: UI scripts made with `.new()`, `match`/enum screen switches, `show_*`/`open_*` functions and popups made in code.

It also finds level and stage lists (count, order, unlock rule). Then, with your yes and on its own
branch, `gamedexy capture init` adds a small debug-only capture list to your game (for code-built Godot screens it also lists how to open each one, with an optional `--seed N` for the global random generator; a game with its own `RandomNumberGenerator` reads the seed from the capture file), and
`gamedexy map capture --all` opens every screen and level directly and screenshots it, labelled from
the code. No playing needed; nothing of it is in your Release build (`gamedexy doctor --release-app`).

For Godot, all of it lives in one `gamedexy/` folder that never ships: `capture init` adds `gamedexy/*` to
every export preset's exclude filter (plus a "(Gamedexy capture)" copy of each iOS and Android preset to export capture
builds from; re-run `capture init` to refresh a copy after changing its original: your `gamedexy/capture.gd` is kept as it is), puts a tiny stub autoload outside the folder so release builds still start, and adds a `.gdignore` to
screenshot folders. `gamedexy check-export <build>` reads an exported `.pck`, `.apk`, `.ipa`, `.zip` or folder and
exits 1 if any `gamedexy/` path or capture script is inside, so a ship script can refuse that build. It checks paths only: debug-gated code you keep outside `gamedexy/` can still ship (`doctor --release-app` checks Release builds for it).

Capture runs are kept in `~/.gamedexy/runs/<game>/<time>/` (override with `--out`), never a temp folder; the path is
printed at the start and again when the run finishes. `map capture` makes its `shots/` folder if it is missing.

Every command prints JSON. `gamedexy help` lists them all; `gamedexy doctor` checks a setup.

## Source

This repository mirrors the `cli/` folder of Gamedexy's main repository and is updated with each
npm release. Issues are welcome here; for anything about your account, write to support@gamedexy.com.

## License

[MIT](LICENSE). Open source: read it, run it, fork it, ship it. The Gamedexy library, Game Map and the MCP server are a hosted service and
are not part of this repository. The Gamedexy name and logo are not covered by the license.
