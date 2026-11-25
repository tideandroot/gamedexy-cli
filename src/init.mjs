// `gamedexy init`: everything a developer needs before their first Game Map run,
// in one command. It installs the agent skill, connects the Gamedexy MCP where it
// can, checks the machine, and prints the one sentence to give the agent.
//
// It only writes in places the developer's own agent tools read from, never
// overwrites a file it did not write, and says exactly what it changed.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// ---- Antigravity (Gemini) -------------------------------------------------------------------------------
// Antigravity reads MCP servers from ~/.gemini/config/mcp_config.json ({ "mcpServers": { name: entry } }); an entry has
// either `command` (stdio) or `serverUrl` (remote, Streamable HTTP). Its docs say remote servers get OAuth with DCR
// natively, but the sign-in is documented only for the desktop app (Authenticate, paste the code), not for `agy`. The
// stdio bridge below is the entry that already works in the CLI (mcp-remote opens the browser itself), so it is the
// default; `transport: "url"` writes the native remote entry instead.
export const MCP_REMOTE = "mcp-remote@0.16.7";
export const antigravityEntry = (transport = "stdio") =>
  transport === "url" ? { serverUrl: MCP_URL } : { command: "npx", args: ["-y", MCP_REMOTE, MCP_URL] };

/**
 * Add the gamedexy server to Antigravity's MCP config. Keeps every other entry and key, never overwrites an existing
 * gamedexy entry (even a different one), never writes a token (the entry has no env or headers), and leaves a file it
 * cannot parse alone. A changed file is backed up first as mcp_config.json.bak-gamedexy-init (not overwritten).
 */
export function connectAntigravity({ home, dryRun = false, transport = "stdio" }) {
  const file = join(home, ".gemini", "config", "mcp_config.json");
  const entry = antigravityEntry(transport);
  let cfg = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    try {
      cfg = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { agent: "Antigravity", file, done: false, why: "mcp_config.json is not valid JSON; left as it is. Add the gamedexy entry by hand (see mcp_by_hand)." };
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || (cfg.mcpServers !== undefined && (typeof cfg.mcpServers !== "object" || cfg.mcpServers === null || Array.isArray(cfg.mcpServers)))) {
      return { agent: "Antigravity", file, done: false, why: "mcp_config.json has an unexpected shape; left as it is." };
    }
    if (cfg.mcpServers?.gamedexy) return { agent: "Antigravity", file, done: false, why: "already connected (an existing gamedexy entry is never changed)" };
  }
  const diff = [`@@ ${file} (mcpServers) @@`, ...JSON.stringify({ gamedexy: entry }, null, 2).split("\n").slice(1, -1).map((l) => `+${l}`)];
  if (dryRun) return { agent: "Antigravity", file, done: false, why: "dry run: would add the gamedexy entry", diff };
  const next = { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), gamedexy: entry } };
  mkdirSync(dirname(file), { recursive: true });
  const backup = `${file}.bak-gamedexy-init`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { agent: "Antigravity", file, done: true, transport: transport === "url" ? "url" : "stdio (mcp-remote)", ...(existsSync(backup) ? { backup } : {}), diff };
}

// Read only when a run needs them (deep passes, engine recipes), so the main skill stays short.
export const REFERENCE_FILES = ["DEEP.md", "ENGINES.md"];

/**
 * @param {{ agent?: string, dryRun?: boolean, home?: string, transport?: string, has?: (cmd: string) => boolean }} o
 */
export function init(o = {}) {
  const home = o.home ?? homedir();
  const dryRun = Boolean(o.dryRun);
  const want = (o.agent ?? "all").toLowerCase();
  const steps = [];
  const hasCli = o.has ?? has;
  if (o.transport !== undefined && !["stdio", "url"].includes(o.transport)) throw new Error(`--transport must be stdio or url (got "${o.transport}"). stdio is the mcp-remote bridge, url is Antigravity's own remote entry.`);

  // 1. The skill.
  const skill = withMark(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"));
  if (want === "all" || want === "claude") {
    steps.push({ step: "Claude Code skill", ...place(join(home, ".claude", "skills", "gamedexy-game-map", "SKILL.md"), skill, dryRun) });
    for (const f of REFERENCE_FILES) steps.push({ step: `Claude Code skill: ${f}`, ...place(join(home, ".claude", "skills", "gamedexy-game-map", f), readFileSync(join(SKILL_DIR, f), "utf8"), dryRun) });
  }
  if (want === "all" || want === "codex" || want === "cursor" || want === "antigravity" || want === "gemini" || want === "other") {
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
  if ((want === "all" || want === "claude") && hasCli("claude")) {
    const listed = agentCli("claude", ["mcp", "get", "gamedexy"], { encoding: "utf8" });
    if (listed.status === 0) mcp.push({ agent: "Claude Code", done: false, why: "already connected" });
    else if (dryRun) mcp.push({ agent: "Claude Code", done: false, why: "dry run" });
    else {
      const r = agentCli("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "gamedexy", MCP_URL], { encoding: "utf8" });
      mcp.push({ agent: "Claude Code", done: r.status === 0, ...(r.status === 0 ? {} : { why: (r.stderr || r.stdout || "").trim().slice(0, 200) }) });
    }
  }
  if ((want === "all" || want === "codex") && hasCli("codex")) {
    const listed = agentCli("codex", ["mcp", "get", "gamedexy"], { encoding: "utf8" });
    if (listed.status === 0) mcp.push({ agent: "Codex", done: false, why: "already connected" });
    else if (dryRun) mcp.push({ agent: "Codex", done: false, why: "dry run" });
    else {
      const r = agentCli("codex", ["mcp", "add", "gamedexy", "--url", MCP_URL], { encoding: "utf8" });
      mcp.push({ agent: "Codex", done: r.status === 0, ...(r.status === 0 ? {} : { why: (r.stderr || r.stdout || "").trim().slice(0, 200) }) });
    }
  }

  // Only when Antigravity is there: the agy command or its config folder (~/.gemini/config).
  if ((want === "all" || want === "antigravity" || want === "gemini") && (hasCli("agy") || existsSync(join(home, ".gemini", "config")))) {
    mcp.push(connectAntigravity({ home, dryRun, transport: o.transport ?? "stdio" }));
  } else if (want === "antigravity" || want === "gemini") {
    mcp.push({ agent: "Antigravity", done: false, why: "Antigravity not found (no agy command and no ~/.gemini/config folder)" });
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
      Antigravity: `Add to ~/.gemini/config/mcp_config.json under "mcpServers": "gamedexy": { "command": "npx", "args": ["-y", "${MCP_REMOTE}", "${MCP_URL}"] } (or { "serverUrl": "${MCP_URL}" } to let Antigravity run the OAuth sign-in itself)`,
      "Cursor and others": `Add an HTTP MCP server named gamedexy with the URL ${MCP_URL}`,
    },
    sign_in: "The first time your agent uses Gamedexy it opens a browser to sign in (Claude Code: /mcp, then gamedexy; Antigravity: the mcp-remote bridge opens the browser). Game Map needs a Pro plan.",
    machine,
    then: "Open your game's project in your agent and say: Map my game with Gamedexy",
  };
}
