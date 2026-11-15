// gamedexy login / send / finish against a stand-in sign-in server and MCP (no network).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { accessToken, callTool, loadAuth, login, logout, pkce, whoami } from "../src/auth.mjs";
import { finish, send } from "../src/map.mjs";

const ENDPOINT = "https://gdx.test/api/mcp";
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

function fakeServer() {
  const seen = { registered: null, token: [], mcp: [] };
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (u.pathname === "/.well-known/oauth-protected-resource/api/mcp") return json({ resource: ENDPOINT, authorization_servers: ["https://auth.test/auth/v1"] });
    if (u.pathname === "/.well-known/oauth-authorization-server/auth/v1")
      return json({ authorization_endpoint: "https://auth.test/auth/v1/oauth/authorize", token_endpoint: "https://auth.test/auth/v1/oauth/token", registration_endpoint: "https://auth.test/auth/v1/oauth/clients/register" });
    if (u.pathname === "/auth/v1/oauth/clients/register") {
      seen.registered = JSON.parse(init.body);
      return json({ client_id: "cli-123" });
    }
    if (u.pathname === "/auth/v1/oauth/token") {
      const p = Object.fromEntries(new URLSearchParams(init.body));
      seen.token.push(p);
      if (p.grant_type === "authorization_code" && p.code === "good-code" && p.code_verifier) return json({ access_token: jwt({ email: "dev@example.com" }), refresh_token: "r1", expires_in: 3600 });
      if (p.grant_type === "refresh_token" && p.refresh_token === "r1") return json({ access_token: jwt({ email: "dev@example.com", n: 2 }), refresh_token: "r2", expires_in: 3600 });
      return json({ error: "invalid_grant" }, 400);
    }
    if (u.href === ENDPOINT) {
      seen.mcp.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
      return json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { f, seen };
}

test("PKCE pairs are S256 and URL-safe", () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
});

test("login: discovery, a public client on a loopback redirect, PKCE, then the token is saved privately and never printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-auth-"));
  const { f, seen } = fakeServer();
  let authorizeUrl;
  const out = await login({
    endpoint: ENDPOINT,
    fetch: f,
    configDir: dir,
    // Stand-in for the browser: the user approves, and the sign-in server redirects back.
    openBrowser: (url) => {
      authorizeUrl = new URL(url);
      const back = new URL(authorizeUrl.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "good-code");
      back.searchParams.set("state", authorizeUrl.searchParams.get("state"));
      setTimeout(() => fetch(back), 10);
      return true;
    },
  });
  assert.equal(out.signed_in, true);
  assert.ok(!JSON.stringify(out).includes("r1"), "the refresh token must not be printed");
  assert.equal(seen.registered.token_endpoint_auth_method, "none");
  assert.match(seen.registered.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl.searchParams.get("resource"), ENDPOINT);
  assert.equal(seen.token[0].resource, ENDPOINT);
  const saved = loadAuth(dir);
  assert.equal(saved.refresh_token, "r1");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "auth.json")).mode & 0o077, 0, "auth.json must be private to the user");
  assert.equal(whoami({ configDir: dir }).account, "dev@example.com");
  assert.deepEqual(logout({ configDir: dir }), { signed_out: true });
  assert.equal(whoami({ configDir: dir }).signed_in, false);
});

test("a wrong state is rejected, so another site cannot finish someone's sign-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-auth-"));
  const { f } = fakeServer();
  await assert.rejects(
    login({
      endpoint: ENDPOINT,
      fetch: f,
      configDir: dir,
      openBrowser: (url) => {
        const back = new URL(new URL(url).searchParams.get("redirect_uri"));
        back.searchParams.set("code", "good-code");
        back.searchParams.set("state", "forged");
        setTimeout(() => fetch(back), 10);
        return true;
      },
    }),
  );
  assert.equal(loadAuth(dir), null);
});

test("an expiring token refreshes itself before a tool call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gdx-auth-"));
  const { f, seen } = fakeServer();
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ endpoint: ENDPOINT, token_endpoint: "https://auth.test/auth/v1/oauth/token", client_id: "cli-123", access_token: "old", refresh_token: "r1", expires_at: Date.now() + 1000 }));
  const out = await callTool("map_get", {}, { fetch: f, configDir: dir });
  assert.deepEqual(out, { ok: true });
  assert.equal(seen.token.at(-1).grant_type, "refresh_token");
  assert.notEqual(seen.mcp[0].auth, "Bearer old");
  assert.equal(loadAuth(dir).refresh_token, "r2");
  await assert.rejects(accessToken({ configDir: mkdtempSync(join(tmpdir(), "gdx-none-")) }), /gamedexy login/);
});

function runFolder() {
  const dir = mkdtempSync(join(tmpdir(), "gdx-run-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "run-1", started_utc: new Date().toISOString(), platform: "android", launches: [], variant: {} }));
  const shot = (n) => ({ step: n, utc: "2026-11-10T00:00:00Z", action: "tap", seeded: false, phash: "0", text: "Play", width: 1080, height: 2400, image_type: "image/png", full: join(dir, `${n}_f.png`), thumb: join(dir, `${n}_t.png`), new: true });
  for (const n of [1, 2]) {
    writeFileSync(join(dir, `${n}_f.png`), "F");
    writeFileSync(join(dir, `${n}_t.png`), "T");
  }
  writeFileSync(join(dir, "steps.jsonl"), [shot(1), shot(2)].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, "labels.json"), JSON.stringify({ screens: { title: { title: "Title", category: "onboarding", confidence: 0.9 } }, steps: { 1: ["title"], 2: ["title", "again"] } }));
  return dir;
}

test("send: screens go to map_add_screens and each accepted image is PUT to its link, no reply files", async () => {
  const dir = runFolder();
  const calls = [];
  const puts = [];
  const out = await send({
    dir,
    labels: join(dir, "labels.json"),
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { screens: args.screens.map((s) => ({ step: s.step, accepted: s.step === 1, content_type: "image/png", full_url: `https://put/${s.step}f`, thumb_url: `https://put/${s.step}t`, errors: s.step === 1 ? undefined : ["dupe"] })) };
    },
    fetch: async (url, init) => (puts.push([url, init.method]), { ok: true }),
  });
  assert.equal(calls[0][0], "map_add_screens");
  assert.equal(calls[0][1].run_id, "run-1");
  assert.equal(out.accepted, 1);
  assert.equal(out.uploaded, 1);
  assert.deepEqual(puts, [["https://put/1f", "PUT"], ["https://put/1t", "PUT"]]);
  assert.deepEqual(out.skipped, [{ step: 2, why: ["dupe"] }]);
});

test("finish: stats from the folder, confirmed issues from a file, and a named comparison set", async () => {
  const dir = runFolder();
  writeFileSync(join(dir, "issues.json"), JSON.stringify([{ step: 2, kind: "dead_tap", detail: "Leaderboard does nothing" }]));
  let sent;
  const out = await finish({ dir, issues: join(dir, "issues.json"), compare: "Royal Match, Block Blast", callTool: async (name, args) => ((sent = [name, args]), { map_url: "https://gdx.test/my-games/map/x" }) });
  assert.equal(sent[0], "map_finish_run");
  assert.equal(sent[1].status, "finished");
  assert.equal(sent[1].issues[0].kind, "dead_tap");
  assert.deepEqual(sent[1].compare_with, ["Royal Match", "Block Blast"]);
  assert.equal(sent[1].stats.screenshots_taken, 2);
  assert.match(out.next, /Overview tab/);
  assert.ok(readFileSync(join(dir, "run.json"), "utf8").includes("run-1"));
});
