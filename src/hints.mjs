// Developer hints and agent feedback.
//
// Hints: an optional `gamedexy.map.md` in the game's repo, written by the developer (or drafted
// by their agent from the code and accepted by the developer). It says how to win, how to lose
// and how to reach screens an agent will not find by playing. Only goal names, their one-line
// labels and whether each was reached leave the machine (D-091).
//
// Feedback: notes the agent leaves for Gamedexy while it maps (where it got stuck, what the CLI
// or MCP was missing). Scrubbed of paths, emails and secrets, shown to the developer on their
// map, and sent with map_finish_run unless GAMEDEXY_NO_FEEDBACK=1 (D-092).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HINT_FILES = ["gamedexy.map.md", ".gamedexy/map.md", "docs/gamedexy.map.md"];

export function findHints(src) {
  for (const f of HINT_FILES) {
    const p = join(src, f);
    if (existsSync(p)) return { path: p, file: f, text: readFileSync(p, "utf8") };
  }
  return null;
}

const KEY = /^[a-z][a-z0-9_-]{0,30}$/;

/** Sections of the hints file: goals (`- key: how`), debug states, tips and off-limits lines. */
export function parseHints(text) {
  const out = { goals: [], states: [], tips: "", off_limits: [] };
  let section = "";
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) {
      const name = h[1].toLowerCase();
      section = /goal/.test(name) ? "goals" : /debug|state/.test(name) ? "states" : /off.?limit|never|don.?t/.test(name) ? "off" : /tip|note|how/.test(name) ? "tips" : "";
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/)?.[1];
    if (section === "goals" && item) {
      const m = item.match(/^`?([A-Za-z][\w-]{0,30})`?\s*[:—-]\s*(.+)$/);
      if (m && KEY.test(m[1].toLowerCase())) out.goals.push({ key: m[1].toLowerCase(), text: m[2].trim() });
    } else if (section === "states" && item) {
      const s = item.replace(/`/g, "").split(/\s+[—-]\s+|\s*:\s+/)[0].trim();
      if (/^[a-z][\w]*=[\w.-]+(,[a-z][\w]*=[\w.-]+)*$/i.test(s)) out.states.push(s);
    } else if (section === "off" && item) out.off_limits.push(item);
    else if (section === "tips" && line && !line.startsWith(">")) out.tips += (out.tips ? "\n" : "") + line;
  }
  return out;
}

export const HINTS_TEMPLATE = `# Gamedexy map hints

Read by your coding agent before a Gamedexy Game Map run. Plain words are fine.
Only the goal names and their one-line labels below are uploaded (so the map can show which
were reached); everything else stays on your machine.

## Goals
Screens the map should reach. One per line, \`- key: how to get there\`.
- win: How to win a level, match or night (for example: survive until dawn on night 1).
- lose: How to fail on purpose (for example: let the flame go out).
- reward: Where rewards or level-up screens appear after a win.

## Debug states
Gamedexy debug states your debug build understands (\`gamedexy map launch --state ...\`).
- outcome=win — opens the win screen with its rewards
- outcome=lose — opens the fail screen

## Tips
Controls, timing, which button skips the intro: anything an agent would not guess.

## Off limits
Screens or actions the agent must never touch.
`;

export function initHints(src) {
  const have = findHints(src);
  if (have) return { exists: have.path, note: "A hints file already exists. Edit it instead." };
  const p = join(src, HINT_FILES[0]);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, HINTS_TEMPLATE);
  return { created: p, next: "Fill in the goals from the code (win and lose conditions), show the developer, and keep only what they accept." };
}

// ---- feedback ------------------------------------------------------------------------

export const FEEDBACK_KINDS = ["stuck", "unreachable", "missing-tool", "tool-bug", "confusing", "slow", "idea", "praise", "cli-error"];

/** Remove what must not leave the machine: home paths, emails, long secrets, URL queries. */
export function scrub(text, max = 600) {
  return String(text ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    // Device and simulator ids say nothing useful to us and identify the developer's machine.
    .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g, "[device]")
    .replace(/(\/Users|\/home)\/[^/\s]+/g, "~")
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "~")
    .replace(/\b(sk|pk|rk|ghp|gho|xox[abp]|eyJ)[A-Za-z0-9_\-.]{12,}/g, "[secret]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[secret]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[secret]")
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function feedbackRow({ kind, text, step, command, auto }) {
  const k = String(kind ?? "").toLowerCase();
  if (!FEEDBACK_KINDS.includes(k)) throw new Error(`--kind must be one of: ${FEEDBACK_KINDS.filter((x) => x !== "cli-error").join(", ")}`);
  const t = scrub(text);
  if (t.length < 3) throw new Error("--text needs a sentence: what happened, or what you needed");
  return { utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), kind: k, text: t, ...(Number.isInteger(step) ? { step } : {}), ...(command ? { command } : {}), ...(auto ? { auto: true } : {}) };
}
