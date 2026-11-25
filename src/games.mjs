// Find the Game Map game a command means before creating one. `map_create_game` makes a new game for
// any slug it has not seen, so a re-typed or renamed title ("Rattle Pop" for "Rattlepop") quietly
// made a second game. Here the account's games are listed first (`map_list_games`) and an existing
// one is reused; when several could be meant, nothing is created and the candidates are listed.

/** Same rule as the server (apps/web/src/lib/mcp-gamemap.ts slugify). */
export function slugify(name) {
  const s = String(name).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (s || "game").slice(0, 60);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (s) => String(s ?? "").trim().toLowerCase();
const compact = (s) => lower(s).replace(/[^\p{L}\p{N}]/gu, "");

/** Every game of the signed-in account, all pages. null when the server does not have map_list_games yet. */
export async function listGames(call) {
  const games = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    let reply;
    try {
      reply = await call("map_list_games", { limit: 50, ...(cursor ? { cursor } : {}) });
    } catch (e) {
      // An older Gamedexy server has no such tool: keep the old create-by-name behaviour, but say so.
      if (page === 0 && /unknown tool|not found|method not found/i.test(String(e?.message))) return null;
      throw e;
    }
    games.push(...(Array.isArray(reply?.games) ? reply.games : []));
    cursor = reply?.next_cursor;
    if (!cursor) break;
  }
  return games;
}

const line = (g) => `${g.name} (slug ${g.slug}, id ${g.id})`;

export class AmbiguousGame extends Error {
  constructor(target, matches, why) {
    super(`${why} "${target}": ${matches.map(line).join("; ")}. Nothing was created. Pick one with --game <slug|id>, or add --create-new to make a new game named "${target}".`);
    this.matches = matches.map((g) => ({ id: g.id, slug: g.slug, name: g.name }));
  }
}

/**
 * Decide which existing game `target` means.
 *   { game }                    one game to reuse
 *   { create: true }            nothing like it: create it
 *   throws AmbiguousGame        several could be meant (or only a loose lookalike): list them, create nothing
 * Order: id, then slug, then case-insensitive name. A name that differs only in spaces or punctuation
 * ("Rattle Pop" / "Rattlepop") is a lookalike, never reused silently.
 */
export function pickGame(games, target, { createNew = false } = {}) {
  const t = String(target ?? "").trim();
  if (UUID.test(t)) {
    const g = games.find((x) => lower(x.id) === lower(t));
    if (g) return { game: g };
    throw new Error(`No game with id ${t} on this account. Run without --game to use the title, or pick a slug from: ${games.map((x) => x.slug).join(", ") || "(none yet)"}.`);
  }
  const bySlug = games.find((x) => lower(x.slug) === lower(t)) ?? games.find((x) => x.slug === slugify(t));
  if (bySlug && !createNew) return { game: bySlug };
  const byName = games.filter((x) => lower(x.name) === lower(t));
  if (byName.length === 1 && !createNew) return { game: byName[0] };
  if (byName.length > 1 && !createNew) throw new AmbiguousGame(t, byName, "Several games are named");
  if (createNew) {
    // map_create_game is keyed by slug: an existing slug would come back as that game, not a new one. Say so instead.
    const clash = games.find((x) => lower(x.slug) === lower(slugify(t)));
    if (clash) throw new Error(`--create-new cannot make "${t}": it would get the slug "${clash.slug}", which is already the game ${line(clash)}. Use a different name (for example "${t} 2"), or drop --create-new and pass --game ${clash.slug} to use that game.`);
    return { create: true };
  }
  const loose = games.filter((x) => compact(x.name) === compact(t) || compact(x.slug) === compact(t));
  if (loose.length) throw new AmbiguousGame(t, loose, "No game has exactly that name, but these look alike to");
  return { create: true };
}

/**
 * Look the account's games up and decide, creating nothing. Throws AmbiguousGame when several fit.
 * Returns { game } to reuse, { create: true }, or { create: true, skipped } on a server without map_list_games.
 */
export async function lookupGame(call, o) {
  const target = String(o.game ?? o.name ?? "").trim();
  if (!target) throw new Error("--game is required");
  const games = await listGames(call);
  if (!games) return { create: true, skipped: "this Gamedexy server has no map_list_games yet" };
  return pickGame(games, target, { createNew: Boolean(o.createNew) });
}

/**
 * The game for this command, in the shape map_create_game answers: { game_id, slug, name, created, map_url }.
 * Looks the account's games up first and only calls map_create_game when nothing matches.
 * Pass an earlier lookupGame result to avoid asking twice.
 */
export async function resolveGame(call, o, found) {
  const pick = found ?? (await lookupGame(call, o));
  if (pick.game) {
    const g = pick.game;
    return { game_id: g.id, slug: g.slug, name: g.name, created: false, reused: true, map_url: g.map_url };
  }
  const name = String(o.game ?? o.name).trim();
  const g = await call("map_create_game", { name, platform: o.platform ?? "ios", ...(o.engine ? { engine: o.engine } : {}), ...(o.genre ? { genre: o.genre } : {}) });
  // The server hands back the existing game for a slug it already has (a game made a moment ago, or by another run).
  if (o.createNew && g.created === false) throw new Error(`--create-new asked for a new game, but "${name}" matched the existing game ${g.slug} (id ${g.game_id}); nothing new was made. Use a different name.`);
  return { ...g, name, reused: false, ...(pick.skipped ? { lookup: `skipped: ${pick.skipped}` } : {}) };
}
