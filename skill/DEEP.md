# Game Map deep run

Read this only when the developer chose a **deep run**. Everything in SKILL.md still applies
(hard rules, start, send, finish); this file adds the passes a quick run skips. A deep run uses
much more of the developer's AI plan, and debug states change their code: ask before each change,
on its own branch, debug builds only.

## Capture mode (capture first, every screen without playing)

The dependable core of a run: open each screen from the scan's checklist directly and screenshot
it, instead of hoping to reach it by playing. A code change, so ask first, on its own branch, debug
builds only.

1. `gamedexy scan --src <repo> --out <run folder>` lists every screen, each with the code that opens
   it, and the level or stage list (count, order, unlock rule).
2. With the developer's yes, on a branch (`git switch -c gamedexy/capture`):
   `gamedexy capture init --src <repo> --scan <run folder>/scan.json` writes `GamedexyCapture`
   (Swift, Kotlin, GDScript or C#). It reads `-gdxState` like every debug state and lists the keys.
   Wire each key where the scan says that screen opens (`case "shop": sheet = .shop`), and the
   level parameter (`stage=2`) where a run starts. Show the diff; build Debug.
3. `gamedexy map start ...` as usual, then
   `gamedexy map capture --dir <dir> --scan <run folder>/scan.json --all [--with "motes=2000"]`.
   It launches each `screen=` state, waits for the screen to settle, screenshots it and writes
   `labels.json` from the keys (levels titled by their names). It never taps. A key that comes up
   as the start screen, a duplicate, or a purchase sheet is listed under `failed`, not labelled.
4. Wire or drop the failed keys and run `map capture --only key1,key2`. Fill any category listed
   under `needs_category`, check titles and tags against `run-rules.json`, then `map send` and
   `map finish` as usual. Screens reached this way show as "captured", never as played.
5. Before any release: `gamedexy doctor --release-app <Release build>` must pass.

## Reaching later states and goals

   - Fast real-time gameplay is hard for an agent. Do not grind levels. Reach later states with:
     a. **Save seeding (no code change):** write the game's own save with
        `gamedexy map seed --key <key> --value-file <json> [--clear-webkit]`, then `map launch`.
     b. **Gamedexy debug states (code change, ask first):** the game reads one launch argument,
        `-gdxState`, in debug builds only, and jumps to that state. Launch with
        `gamedexy map launch --dir <dir> --state "level=26,gems=100"` (everything after it counts
        as prepared, no `mark-seeded` needed). Standard keys, so every game reads the same way:
        `level`, a currency by its own name (`gems=100`, `coins=5000`), `day` (streak day),
        `screen` (open one screen directly: `screen=pause`, `screen=result-cleared`, `screen=ad`),
        `event` (switch a timed event on), `outcome` (`outcome=win` / `outcome=lose`: start a level
        and end it at once as a win or a loss, so the result and reward screens open), `clock`
        (`clock=3d`: the game's "now" runs 3 days ahead, for step 3e), `offline` (`offline=1`: the
        game behaves as if it has no connection; iOS simulators share the Mac's network).
        Coverage's "Plan my next run" lists which screens need one.
        Templates (adapt names to the game; keep the debug check):
        - Swift / SwiftUI / SpriteKit:
          ```swift
          #if DEBUG
          /// Gamedexy debug states: -gdxState level=26,gems=100. Debug builds only.
          enum GamedexyDebugState {
              static let values: [String: String] = {
                  let args = ProcessInfo.processInfo.arguments
                  guard let i = args.firstIndex(of: "-gdxState"), i + 1 < args.count else { return [:] }
                  return args[i + 1].split(separator: ",").reduce(into: [:]) { out, pair in
                      let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                      if kv.count == 2 { out[kv[0]] = kv[1] }
                  }
              }()
          }
          #endif
          ```
          WKWebView games: in DEBUG only, pass the values to the page with a `WKUserScript` at
          document start (`window.gdxState = {...}`), and have the page apply them only when present.
        - Android (Kotlin): `if (BuildConfig.DEBUG) intent.getStringExtra("gdxState")?.let { ... }`
          (`map launch --state` sends it as a string extra).
        - Godot and Unity: see `ENGINES.md` (Godot tested on Android; Unity from its documentation).
     c. **Prove it stays out of Release:** build Release and run
        `gamedexy doctor --platform ios --release-app <path to Release .app>`. The check "Debug
        states left out of Release" must pass before you finish. Tell the developer it passed.
   - **Reach the goals.** Try each one by playing first (`gamedexy map play` for real-time games).
     When its screen is up, mark it: `gamedexy map goal --dir <dir> --key win`. Only if play cannot
     get there, use a debug state (`--state "outcome=win"`) and mark it the same way; the map shows
     how each goal was reached.
   - **System prompts** (notifications, tracking, location): the shot reply says `system_prompt`.
     Answer the privacy way ("Don't Allow", "Ask App Not to Track") unless the run needs it; the
     map times when the game asked.
   - Stop and report if the app crashes, a purchase sheet appears, or you are stuck.

   d. **Variant passes, at the end of the run** (each one command; the guard keeps refusing buy, ad
      and sign-in buttons in every language):
      - Big text: `gamedexy map variant --dir <dir> --text-size largest`, revisit home, store,
        settings, a level and a result screen.
      - Languages: `--lang de`, revisit the same screens, then `--lang ja`.
      - Small phone (iOS): `gamedexy device create --platform ios --type "iPhone SE (3rd generation)"`,
        boot it, then `gamedexy map variant --dir <dir> --device <its id> --app <path to .app>`.
      - Finish with `gamedexy map variant --dir <dir> --reset`.
      - No connection: `--offline on` (Android turns wifi and data off; on iOS the game must read
        `offline=1`), revisit home, the store and a level, then `--offline off`.
      Label every variant shot with the SAME screen key as its normal version: Gamedexy compares
      each screen with itself (text that does not grow, English left over, labels cut off).

   e. **Days 1 to 7 in one sitting.** Find every place the game reads today's date (daily rewards,
      streaks, events, energy refills, offers) and route them through one debug-only clock that adds
      the `clock` state (ask first, own branch, debug builds only):
      ```swift
      enum GameClock {
          static var now: Date {
              #if DEBUG
              if let v = GamedexyDebugState.values["clock"], v.hasSuffix("d"), let n = Int(v.dropLast()) {
                  return Date().addingTimeInterval(Double(n) * 86_400)
              }
              #endif
              return Date()
          }
      }
      ```
      After the first session: `gamedexy map days --dir <dir> --days 2-7 --collect "Claim|Collect"`
      relaunches each day with the clock moved on, screenshots it and taps the first matching button
      (through the guard). Open anything new each day (offers, events) before the next.

   f. **Notifications.** Read the code for every notification the game schedules (local and push):
      title, body, trigger, when it is scheduled, what cancels it, file. Save them as
      `notifications.json` (`[{"id","title","body","trigger":{"type":"calendar|interval|push","hour","minute","seconds","repeats"},"when","condition","where"}]`)
      and run `gamedexy map notifications --dir <dir> --code notifications.json`. For what is really
      pending on the device, add the debug-only dump (iOS): after scheduling, write
      `UNUserNotificationCenter.getPendingNotificationRequests` to
      `Library/Caches/gamedexy-notifications.json` as `{"at": ISO date, "pending": [{"id","title","body","trigger":{"type","hour","minute","weekday","seconds","repeats","next"}}]}`.
      `map days` snapshots it after each day. Answer the notification prompt "Allow" for this part
      only. iOS 27 simulators currently drop local notifications; use an iOS 26 simulator.

   g. **Earnings.** After every run or level, record what the result screen paid:
      `gamedexy map earn --dir <dir> --currency coins --amount 40 --per run` (or level, day, ad).
      Open every store tab so prices are on screen. The map works out how long each item takes.

   h. **Store page.** `gamedexy map store --dir <dir> --src <repo>` (fastlane metadata) or
      `--app-store-id <id>` for a live game: the map checks the description's promises (no ads,
      offline play, daily rewards...) and that store screenshots show real screens.

   i. **Design review (your own judgement, optional).** Look at the main screens next to library
      examples (`search_screens`) and write `critique.json`: up to 20
      `{"area": "onboarding|clarity|hierarchy|feedback|monetization|accessibility|delight", "severity": "high|medium|low", "step", "finding", "suggestion", "library": ["game and screen"]}`.
      Specific and kind; one finding per item. `gamedexy map critique --dir <dir> --file critique.json`.

## Deep-run commands

`gamedexy help deep` lists them all with their flags.
