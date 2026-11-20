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

That installs the agent skill, connects the Gamedexy MCP (Claude Code and Codex, if installed) and
checks what this machine can map. Then open your game's project in your agent and say:

> Map my game with Gamedexy

The map appears, privately, at gamedexy.com/my-games/map. Game Map needs a Gamedexy Pro plan.

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
notifications, so the agent knows what to capture without guessing. Swift, Kotlin, Godot and Unity.

It also finds level and stage lists (count, order, unlock rule). Then, with your yes and on its own
branch, `gamedexy capture init` adds a small debug-only capture list to your game, and
`gamedexy map capture --all` opens every screen and level directly and screenshots it, labelled from
the code. No playing needed; nothing of it is in your Release build (`gamedexy doctor --release-app`).

Every command prints JSON. `gamedexy help` lists them all; `gamedexy doctor` checks a setup.

## Source

This repository mirrors the `cli/` folder of Gamedexy's main repository and is updated with each
npm release. Issues are welcome here; for anything about your account, write to support@gamedexy.com.

## License

[MIT](LICENSE). Open source: read it, run it, fork it, ship it. The Gamedexy library, Game Map and the MCP server are a hosted service and
are not part of this repository. The Gamedexy name and logo are not covered by the license.
