// `gamedexy init`: everything a developer needs before their first Game Map run,
// in one command. It installs the agent skill, connects the Gamedexy MCP where it
// can, checks the machine, and prints the one sentence to give the agent.
//
// It only writes in places the developer's own agent tools read from, never
// overwrites a file it did not write, and says exactly what it changed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { has } from "./devices.mjs";

// npm installs `claude` and `codex` as .cmd shims on Windows, which only start through a shell.
// The arguments are fixed strings from this file, never user input.
function agentCli(cmd, args, opts) {
  return spawnSync(cmd, args, { ...opts, shell: process.platform === "win32" });
}

export const MCP_URL = "https://www.gamedexy.com/api/mcp";
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
const MARK = "<!-- installed by gamedexy init -->";

/** Write `text` to `file` unless a file we did not write is already there. */
function place(file, text, dryRun) {
  if (existsSync(file)) {
    const cur = readFileSync(file, "utf8");
    if (!cur.includes(MARK)) return { file, done: false, why: "a file is already there that gamedexy did not write; left as it is" };
    if (cur === text) return { file, done: false, why: "already up to date" };
  }
  if (dryRun) return { file, done: false, why: "dry run: would write this file" };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return { file, done: true };
}

function withMark(md) {
  // Keep the YAML front matter first so agents still read the skill's name and description.
  const m = /^---\n[\s\S]*?\n---\n/.exec(md);
  return m ? `${m[0]}${MARK}\n${md.slice(m[0].length)}` : `${MARK}\n${md}`;
}

// Read only when a run needs them (deep passes, engine recipes), so the main skill stays short.
export const REFERENCE_FILES = ["DEEP.md", "ENGINES.md"];

/**
 * @param {{ agent?: string, dryRun?: boolean, home?: string }} o
 */
export function init(o = {}) {
  const home = o.home ?? homedir();
  const dryRun = Boolean(o.dryRun);
  const want = (o.agent ?? "all").toLowerCase();
  const steps = [];

  // 1. The skill.
  const skill = withMark(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"));
  if (want === "all" || want === "claude") {
    steps.push({ step: "Claude Code skill", ...place(join(home, ".claude", "skills", "gamedexy-game-map", "SKILL.md"), skill, dryRun) });
    for (const f of REFERENCE_FILES) steps.push({ step: `Claude Code skill: ${f}`, ...place(join(home, ".claude", "skills", "gamedexy-game-map", f), readFileSync(join(SKILL_DIR, f), "utf8"), dryRun) });
  }
  if (want === "all" || want === "codex" || want === "cursor" || want === "other") {
    const agents = withMark(readFileSync(join(SKILL_DIR, "AGENTS.md"), "utf8"));
    steps.push({
      step: "Instructions for Codex, Cursor and other agents",
      ...place(join(home, ".gamedexy", "AGENTS.md"), agents, dryRun),
      next: "Point your agent at ~/.gamedexy/AGENTS.md, or paste it into the project's AGENTS.md.",
    });
    for (const f of REFERENCE_FILES) steps.push({ step: `Reference: ${f}`, ...place(join(home, ".gamedexy", f), readFileSync(join(SKILL_DIR, f), "utf8"), dryRun) });
  }

  // 2. The MCP connection.
  const mcp = [];
  if ((want === "all" || want === "claude") && has("claude")) {
    const listed = agentCli("claude", ["mcp", "get", "gamedexy"], { encoding: "utf8" });
    if (listed.status === 0) mcp.push({ agent: "Claude Code", done: false, why: "already connected" });
    else if (dryRun) mcp.push({ agent: "Claude Code", done: false, why: "dry run" });
    else {
      const r = agentCli("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "gamedexy", MCP_URL], { encoding: "utf8" });
      mcp.push({ agent: "Claude Code", done: r.status === 0, ...(r.status === 0 ? {} : { why: (r.stderr || r.stdout || "").trim().slice(0, 200) }) });
    }
  }
  if ((want === "all" || want === "codex") && has("codex")) {
    const listed = agentCli("codex", ["mcp", "get", "gamedexy"], { encoding: "utf8" });
    if (listed.status === 0) mcp.push({ agent: "Codex", done: false, why: "already connected" });
    else if (dryRun) mcp.push({ agent: "Codex", done: false, why: "dry run" });
    else {
      const r = agentCli("codex", ["mcp", "add", "gamedexy", "--url", MCP_URL], { encoding: "utf8" });
      mcp.push({ agent: "Codex", done: r.status === 0, ...(r.status === 0 ? {} : { why: (r.stderr || r.stdout || "").trim().slice(0, 200) }) });
    }
  }

  // 3. What this machine can map.
  const mac = process.platform === "darwin";
  const machine = {
    ios: mac && has("xcrun") ? (has("axe") || has("idb") ? "ready" : "needs a tap tool: brew install cameroncooke/axe/axe") : "needs a Mac with Xcode",
    android: has("adb") ? "ready (start an emulator from Android Studio)" : "needs Android platform-tools (adb)",
  };

  return {
    dry_run: dryRun,
    skill: steps,
    mcp,
    mcp_by_hand: {
      "Claude Code": `claude mcp add --scope user --transport http gamedexy ${MCP_URL}`,
      Codex: `codex mcp add gamedexy --url ${MCP_URL}`,
      "Cursor and others": `Add an HTTP MCP server named gamedexy with the URL ${MCP_URL}`,
    },
    sign_in: "The first time your agent uses Gamedexy it opens a browser to sign in (Claude Code: /mcp, then gamedexy). Game Map needs a Pro plan.",
    machine,
    then: "Open your game's project in your agent and say: Map my game with Gamedexy",
  };
}
