// `gamedexy login`: the CLI signs in to Gamedexy with the same OAuth the MCP uses
// (Supabase OAuth 2.1, PKCE, a loopback redirect), so it can upload a run by itself instead of
// handing payload and reply files to the agent. The token is kept in the user's config folder,
// readable only by them, and is never printed.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const MCP_URL = process.env.GAMEDEXY_MCP_URL || "https://www.gamedexy.com/api/mcp";
const SCOPE = "openid email profile offline_access";

export function configDir() {
  const base = process.platform === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "gamedexy");
}
const authFile = (dir) => join(dir ?? configDir(), "auth.json");

export function loadAuth(dir) {
  const p = authFile(dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function saveAuth(auth, dir) {
  const d = dir ?? configDir();
  mkdirSync(d, { recursive: true });
  const p = authFile(d);
  writeFileSync(p, JSON.stringify(auth, null, 1), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows: the file sits in the user's own profile folder */
  }
}

export function logout(o = {}) {
  const p = authFile(o.configDir);
  const had = existsSync(p);
  rmSync(p, { force: true });
  return { signed_out: had };
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** RFC 9728 and RFC 8414 discovery, from the MCP endpoint to the authorization server. */
export async function discover(endpoint, f = fetch) {
  const u = new URL(endpoint);
  const prm = await (await f(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)).json();
  const issuer = new URL(prm.authorization_servers?.[0] ?? "");
  const as = await (await f(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`)).json();
  if (!as.authorization_endpoint || !as.token_endpoint || !as.registration_endpoint) throw new Error("Gamedexy's sign-in server did not describe itself. Try again later.");
  return { resource: prm.resource ?? endpoint, as };
}

function openBrowser(url) {
  // Windows: `start` treats & as a command separator, so go through the URL handler instead.
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

async function tokenRequest(as, body, f) {
  const res = await f(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Sign-in failed: ${json.error_description || json.error || res.status}`);
  return json;
}

const toAuth = (endpoint, as, clientId, t, prev) => ({
  endpoint,
  token_endpoint: as.token_endpoint,
  client_id: clientId,
  access_token: t.access_token,
  refresh_token: t.refresh_token ?? prev?.refresh_token ?? null,
  expires_at: Date.now() + Number(t.expires_in ?? 3600) * 1000,
  signed_in_utc: prev?.signed_in_utc ?? new Date().toISOString(),
});

/**
 * Browser sign-in. Prints the link on stderr (the agent can show it) and waits for the
 * redirect on 127.0.0.1. Options exist for tests: fetch, a browser stand-in, a config folder.
 */
export async function login(o = {}) {
  const f = o.fetch ?? fetch;
  const endpoint = o.endpoint ?? MCP_URL;
  const { resource, as } = await discover(endpoint, f);
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));

  let done;
  const result = new Promise((resolve, reject) => (done = { resolve, reject }));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      ok
        ? "<!doctype html><title>Gamedexy</title><body style=\"font:16px system-ui;padding:40px\"><h1>Signed in</h1><p>You can close this tab and go back to your agent.</p>"
        : "<!doctype html><title>Gamedexy</title><body style=\"font:16px system-ui;padding:40px\"><h1>Sign-in did not finish</h1><p>Run <code>gamedexy login</code> again.</p>",
    );
    if (ok) done.resolve(u.searchParams.get("code"));
    else done.reject(new Error(u.searchParams.get("error_description") || u.searchParams.get("error") || "Sign-in was cancelled."));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const redirect = `http://127.0.0.1:${port}/callback`;

  try {
    // A fresh public client per sign-in: loopback ports change, and nothing secret is stored for it.
    const reg = await f(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Gamedexy CLI", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    const client = await reg.json().catch(() => ({}));
    if (!reg.ok || !client.client_id) throw new Error(`Could not register the CLI with Gamedexy's sign-in server (${client.error_description || reg.status}).`);

    const url = new URL(as.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256", resource })) url.searchParams.set(k, v);
    process.stderr.write(`Open this link to sign in to Gamedexy (it should open by itself):\n${url}\n`);
    const opened = o.openBrowser ? o.openBrowser(url.toString()) : o.noOpen ? false : openBrowser(url.toString());

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Sign-in timed out after 5 minutes. Run gamedexy login again.")), o.timeoutMs ?? 300000).unref());
    const code = await Promise.race([result, timeout]);
    const t = await tokenRequest(as, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource }, f);
    saveAuth(toAuth(endpoint, as, client.client_id, t), o.configDir);
    return { signed_in: true, endpoint, opened_browser: Boolean(opened), saved_to: authFile(o.configDir), next: "gamedexy map start ... --game \"<your game>\"" };
  } finally {
    server.close();
  }
}

/** A usable access token, refreshed when it is about to expire. Throws a plain instruction otherwise. */
export async function accessToken(o = {}) {
  const auth = loadAuth(o.configDir);
  if (!auth?.access_token) throw new Error("Not signed in. Run: gamedexy login");
  if (Date.now() < auth.expires_at - 60000) return auth;
  if (!auth.refresh_token) throw new Error("Your Gamedexy sign-in expired. Run: gamedexy login");
  const t = await tokenRequest({ token_endpoint: auth.token_endpoint }, { grant_type: "refresh_token", refresh_token: auth.refresh_token, client_id: auth.client_id }, o.fetch ?? fetch).catch(() => {
    throw new Error("Your Gamedexy sign-in expired. Run: gamedexy login");
  });
  const next = toAuth(auth.endpoint, { token_endpoint: auth.token_endpoint }, auth.client_id, t, auth);
  saveAuth(next, o.configDir);
  return next;
}

export function whoami(o = {}) {
  const auth = loadAuth(o.configDir);
  if (!auth) return { signed_in: false, next: "gamedexy login" };
  let account = null;
  try {
    const claims = JSON.parse(Buffer.from(auth.access_token.split(".")[1], "base64url").toString("utf8"));
    account = claims.email ?? null;
  } catch {
    account = null;
  }
  return { signed_in: true, account, endpoint: auth.endpoint, expires: new Date(auth.expires_at).toISOString(), refreshes: Boolean(auth.refresh_token) };
}

/** One MCP tool call over plain JSON-RPC (the Gamedexy MCP is stateless). Returns the tool's JSON. */
export async function callTool(name, args, o = {}) {
  const auth = await accessToken(o);
  const res = await (o.fetch ?? fetch)(auth.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${auth.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.status === 401) throw new Error("Gamedexy did not accept the sign-in. Run: gamedexy login");
  if (res.status === 403) throw new Error("Game Map needs a Gamedexy Pro account.");
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`Gamedexy answered ${res.status} with no data.`);
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
