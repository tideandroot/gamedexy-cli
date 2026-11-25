// Where a capture run lives. Runs hold the screenshots, steps and labels of a whole Game Map pass, and
// agents twice lost one left in a session scratchpad. So the default is a durable folder under the user's
// home, `~/.gamedexy/runs/<game>/<timestamp>/`, and it is printed when the run starts, after map capture
// and when it finishes. `--out DIR` (or `--dir DIR`) picks another; a temporary folder is warned about.
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const slug = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "game";

export const runsRoot = () => join(homedir(), ".gamedexy", "runs");

/** `~/.gamedexy/runs/<game>/<YYYYMMDD-HHMMSS>` (UTC). `game` is a name, slug or bundle id. */
export function defaultRunDir(game, now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  return join(runsRoot(), slug(game), stamp);
}

/** realpath of the nearest existing ancestor plus the rest, so /tmp/x (not made yet) still resolves to /private/tmp/x. */
const real = (p) => {
  let cur = resolve(p);
  let rest = "";
  for (let i = 0; i < 64; i++) {
    try {
      return rest ? join(realpathSync(cur), rest) : realpathSync(cur);
    } catch {
      const up = dirname(cur);
      if (up === cur) break;
      rest = rest ? join(basename(cur), rest) : basename(cur);
      cur = up;
    }
  }
  return resolve(p);
};

/** A warning when `dir` is somewhere the system may clean up (a temp or scratch folder), else null. */
export function temporaryWarning(dir) {
  const d = real(resolve(dir));
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/var/folders"].map(real);
  const scratch = /[\\/](scratchpad|\.claude[\\/]projects|AppData[\\/]Local[\\/]Temp)([\\/]|$)/i.test(d);
  if (scratch || roots.some((r) => d === r || d.startsWith(r + sep))) {
    return `This run folder is in a temporary location (${d}) and can disappear when the session or the system cleans up. Use the default (~/.gamedexy/runs/<game>/<time>) or pass --out with a folder you keep.`;
  }
  return null;
}
