// Replay on every build (gameplan 8). A finished run's path is saved as a route: every input the
// agent sent, in order, with the screen it was sent on. On a new build the CLI replays that route
// by itself, with no agent and no AI cost: before each input it checks the screen still looks the
// same, re-finds a button by its text if it moved, and stops where the game now differs. Every tap
// still goes through the purchase guard. Screens that match the old run get the old labels, so
// only new screens need the agent.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { overlap } from "./extras.mjs";
import { key, launch, lookFor, readJsonl, shot, swipe, tap } from "./map.mjs";
import { hamming, sameText } from "./phash.mjs";

export const ROUTE_SCHEMA = "gamedexy.route/1";

/** Is the screen now the one the route expects? Pictures can change between builds; text usually carries over. */
export function sameScreen(expect, now) {
  if (!expect || !now) return false;
  const d = hamming(expect.phash, now.phash);
  if (d <= 6) return true;
  if (d <= 14 && sameText(expect.text, now.text)) return true;
  return overlap(expect.text, now.text) >= 0.6;
}

/** The ordered inputs of a run: launches, taps, swipes and keys that were actually sent. */
export function buildRoute(dir) {
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  const steps = new Map(readJsonl(join(dir, "steps.jsonl")).map((s) => [s.step, s]));
  const expectAt = (n) => {
    const s = steps.get(n);
    return s ? { step: s.step, phash: s.phash, text: String(s.text ?? "").slice(0, 400) } : null;
  };
  const events = [];
  for (const [i, t] of readJsonl(join(dir, "taps.jsonl")).entries()) {
    if (!t.sent || t.allowed === false) continue;
    const base = { order: [t.after_step ?? 0, 1, t.utc ?? "", i], expect: expectAt(t.after_step) };
    if (t.key) events.push({ ...base, kind: "key", key: t.key });
    else if (t.swipe) events.push({ ...base, kind: "swipe", swipe: t.swipe });
    else if (t.play) continue; // real-time play is not repeatable step for step
    else if (typeof t.x === "number") events.push({ ...base, kind: "tap", x: t.x, y: t.y, hold: t.hold ?? 0, label: t.label ?? "" });
  }
  // A launch at step N happens after that step's taps (older runs have no time on launches).
  for (const [i, l] of (run.launches ?? []).entries()) events.push({ order: [l.after_step ?? 0, 2, l.utc ?? "", i], kind: "launch", state: l.state ?? null });
  events.sort((a, b) => a.order[0] - b.order[0] || (a.order[2] && b.order[2] ? a.order[2].localeCompare(b.order[2]) : a.order[1] - b.order[1]) || a.order[3] - b.order[3]);
  return {
    schema: ROUTE_SCHEMA,
    app_id: run.app_id,
    platform: run.platform,
    from_build: run.build ?? null,
    made_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    actions: events.map(({ order: _o, ...e }) => e),
  };
}

export function saveRoute(o) {
  const route = buildRoute(o.dir);
  const out = o.out ?? join(o.dir, "route.json");
  writeFileSync(out, JSON.stringify(route, null, 1));
  return { route: out, actions: route.actions.length, taps: route.actions.filter((a) => a.kind === "tap").length, next: "On the next build: gamedexy map start ... then gamedexy map replay --dir <new folder> --route <this file>" };
}

/** Where to tap now: the same button found by its text if it moved, else the old point. */
export function aimFor(action, boxes, scale) {
  const want = String(action.label ?? "").trim().toLowerCase();
  if (want.length >= 2) {
    const hit = boxes.find((b) => String(b.text).trim().toLowerCase() === want) ?? boxes.find((b) => String(b.text).toLowerCase().includes(want));
    if (hit) return { x: Math.round((hit.x0 + hit.x1) / 2 / scale), y: Math.round((hit.y0 + hit.y1) / 2 / scale), moved: true };
  }
  return { x: action.x, y: action.y, moved: false };
}

export async function replay(o, io = { shot, tap, swipe, key, launch }) {
  const route = JSON.parse(readFileSync(o.route, "utf8"));
  if (route.schema !== ROUTE_SCHEMA) throw new Error("Not a Gamedexy route file. Make one with: gamedexy map route --dir <old run>");
  const run = JSON.parse(readFileSync(join(o.dir, "run.json"), "utf8"));
  if (run.app_id !== route.app_id) throw new Error(`This route is for ${route.app_id}, the run is ${run.app_id}.`);
  const log = [];
  const changes = [];
  let stopped = null;
  // Which old step each new screenshot was taken to match: labels carry by this, not by look-alikes.
  const stepMap = {};
  const lastStep = () => readJsonl(join(o.dir, "steps.jsonl")).at(-1);
  // A new screen in the way (a fixed dead button, a new popup): note it, step back with the game's
  // own Back/Close/OK button (through the guard), and carry on if the expected screen returns.
  const recover = async (expect) => {
    const scr = lastStep();
    const scale = run.platform === "ios" ? (scr.width >= 1100 ? 3 : scr.width >= 700 ? 2 : 1) : 1;
    for (const word of ["Back", "Close", "OK", "Not now", "Continue"]) {
      const b = (scr.boxes ?? []).find((x) => String(x.text).trim().toLowerCase() === word.toLowerCase());
      if (!b) continue;
      const r = await io.tap({ dir: o.dir, x: Math.round((b.x0 + b.x1) / 2 / scale), y: Math.round((b.y0 + b.y1) / 2 / scale), label: word });
      if (r.refused) return false;
      await io.shot({ dir: o.dir, action: `replay: tapped ${word} to get back on route` });
      if (sameScreen(expect, lastStep())) return word;
      return false;
    }
    return false;
  };
  for (const [i, a] of route.actions.entries()) {
    if (a.kind === "launch") {
      await io.launch({ dir: o.dir, state: a.state ?? undefined });
      log.push({ n: i + 1, kind: "launch" });
      continue;
    }
    const now = await io.shot({ dir: o.dir, action: `replay: before ${a.kind} ${a.label ?? a.key ?? ""}`.trim() });
    let last = lastStep();
    if (a.expect?.step && sameScreen(a.expect, last)) stepMap[String(last.step)] = a.expect.step;
    if (a.expect && !sameScreen(a.expect, last)) {
      const change = { at: i + 1, step: now.step, expected: a.expect.text.slice(0, 120), now: String(last?.text ?? "").slice(0, 120) };
      const back = o.noRecover ? false : await recover(a.expect);
      if (!back) {
        stopped = { ...change, reason: "screen changed" };
        break;
      }
      changes.push({ ...change, got_back_with: back });
      last = lastStep();
      if (a.expect.step) stepMap[String(last.step)] = a.expect.step;
    }
    let r;
    if (a.kind === "tap") {
      const scale = run.platform === "ios" ? (last.width >= 1100 ? 3 : last.width >= 700 ? 2 : 1) : 1;
      const aim = aimFor(a, last.boxes ?? [], scale);
      r = await io.tap({ dir: o.dir, x: aim.x, y: aim.y, hold: a.hold, label: a.label || undefined });
      log.push({ n: i + 1, kind: "tap", label: a.label, ...(aim.moved && (aim.x !== a.x || aim.y !== a.y) ? { moved_to: [aim.x, aim.y] } : {}), ...(r.refused ? { refused: r.refused } : {}) });
    } else if (a.kind === "swipe") {
      const [x1, y1, x2, y2] = a.swipe;
      r = await io.swipe({ dir: o.dir, x1, y1, x2, y2 });
      log.push({ n: i + 1, kind: "swipe", ...(r.refused ? { refused: r.refused } : {}) });
    } else if (a.kind === "key") {
      r = io.key({ dir: o.dir }, a.key);
      log.push({ n: i + 1, kind: "key", key: a.key });
    }
    if (r?.refused) {
      stopped = { at: i + 1, reason: `guard refused: ${r.refused}` };
      break;
    }
  }
  await io.shot({ dir: o.dir, action: stopped ? "replay: stopped here" : "replay: end of route" });
  const report = { route: o.route, from_build: route.from_build, actions: route.actions.length, done: log.length, changes, ...(stopped ? { stopped } : { finished: true }), step_map: stepMap, log };
  writeFileSync(join(o.dir, "replay.json"), JSON.stringify(report, null, 1));
  const labels = o.from && o.labels ? carryLabels(o.from, o.labels, o.dir, stepMap) : null;
  const carried = o.from ? carryIssues(o.from, o.labels) : null;
  if (carried) writeFileSync(join(o.dir, "carried-issues.json"), JSON.stringify(carried, null, 1));
  return {
    finished: !stopped,
    done: `${log.length} of ${route.actions.length} actions`,
    ...(changes.length ? { changes: changes.map((c) => `At action ${c.at}: "${c.now}" appeared where the old build showed "${c.expected}" (got back with ${c.got_back_with})`) } : {}),
    ...(stopped ? { stopped, tip: "Where a replay stops is a change worth looking at. Ask the developer before playing on from here." } : {}),
    ...(labels ? { labels: labels.file, labelled: labels.carried, to_label: labels.todo } : {}),
    ...(carried ? { issues_to_recheck: carried.length, recheck: "map finish re-checks the agent's issues from the last build by their text on the same screen" } : {}),
    next: labels?.todo.length ? "Label only the steps in to_label (add them to the labels file), then gamedexy map send and gamedexy map finish." : "gamedexy map send --labels <labels file>, then gamedexy map finish. The Overview opens with what changed since the last build.",
  };
}

/**
 * Old labels onto new steps that show the same screen; the rest are left for the agent. Each step
 * takes the label of the old step the route expected there (stepMap); only steps outside the route
 * fall back to the closest look-alike. The first look-alike was the old way, and it gave every plain
 * menu the label of the reward popup over it (launch gate 2026-11, bug 3).
 */
export function carryLabels(fromDir, labelsFile, dir, stepMap = {}) {
  const old = JSON.parse(readFileSync(labelsFile, "utf8"));
  const oldSteps = readJsonl(join(fromDir, "steps.jsonl"));
  const steps = {};
  const todo = [];
  const labelled = oldSteps.filter((p) => old.steps?.[String(p.step)]);
  for (const s of readJsonl(join(dir, "steps.jsonl"))) {
    const mapped = labelled.find((p) => p.step === stepMap[String(s.step)]);
    const alike = labelled
      .filter((p) => sameScreen({ phash: p.phash, text: p.text }, s))
      .sort((a, b) => hamming(a.phash, s.phash) - hamming(b.phash, s.phash) || (sameText(b.text, s.text) ? 1 : 0) - (sameText(a.text, s.text) ? 1 : 0));
    const twin = mapped && sameScreen({ phash: mapped.phash, text: mapped.text }, s) ? mapped : alike[0];
    if (twin) steps[String(s.step)] = [old.steps[String(twin.step)][0], "replayed"];
    else todo.push(s.step);
  }
  const file = join(dir, "labels.json");
  if (existsSync(file)) throw new Error(`${file} already exists; not overwriting it.`);
  writeFileSync(file, JSON.stringify({ screens: old.screens, steps }, null, 1));
  return { file, carried: Object.keys(steps).length, todo };
}

/**
 * The agent's issues from the earlier run, with the screen key each was on and the text to look
 * for, saved for map finish to re-check (a replay has no agent to report them again).
 */
export function carryIssues(fromDir, labelsFile) {
  const out = new Map();
  const add = (c) => out.set(`${c.kind}|${c.screen_key}|${c.detail}`, c);
  const prev = join(fromDir, "carried-issues.json");
  if (existsSync(prev)) for (const c of JSON.parse(readFileSync(prev, "utf8"))) add(c);
  const sent = join(fromDir, "issues.sent.json");
  const labels = labelsFile && existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, "utf8")) : { steps: {} };
  if (existsSync(sent)) {
    for (const i of JSON.parse(readFileSync(sent, "utf8"))) {
      if (!i || !i.kind || !i.detail) continue;
      const screen_key = i.screen_key ?? (labels.steps?.[String(i.step)] ?? [])[0] ?? null;
      add({ kind: i.kind, detail: i.detail, screen_key, look_for: i.look_for ?? lookFor(i.detail) });
    }
  }
  return [...out.values()];
}
