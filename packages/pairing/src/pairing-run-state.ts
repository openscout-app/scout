// The per-Mac `run/` directory that shared pairing state lives in.
//
// Both the pair-request store and the LAN beacon claim write files beside the
// pairing identity in `~/.openscout`, which is real user data: a pair-request
// row carries a bearer token that completes a pair. Every writer of OpenScout
// user state is expected to refuse to run against a real home under a test
// runner, and these are no exception — an unisolated test once left a live
// pending token in the operator's actual `~/.openscout/run/pair-requests.json`.

import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { assertTestIsolatedUserData } from "@openscout/runtime/config";

/** Symlink hops we will follow before calling a path circular. */
const MAX_LINK_HOPS = 64;

/**
 * The canonical path a write would actually land on.
 *
 * A lexical `resolve()` is not enough, and the gap is not theoretical: a
 * symlink anywhere beneath the isolated home — `<isolated>/run` pointing at
 * `~/.openscout/run` — reads as "inside the isolated home" to any string
 * comparison, while the bytes land in the operator's real home. So every
 * component is resolved here before anything is compared.
 *
 * Deliberately not `realpathSync`. The paths this guard is asked about are
 * usually about to be CREATED, and realpath needs the whole path to exist;
 * resolving only the existing prefix and re-joining the tail would see straight
 * past a symlink whose target does not exist yet — which is the same bypass
 * with one directory missing. `readlink` has no such requirement, so the walk
 * follows dangling links too, and restarts from the top after each hop because
 * a link's target may itself sit behind one (`/tmp` -> `/private/tmp` on macOS
 * being the case every temp-directory test hits).
 */
function canonicalize(path: string): string {
  let current = resolve(path);
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const walked = followFirstLink(current);
    if (walked === null) return current;
    current = walked;
  }
  // A symlink cycle. Nothing sane resolves it either, so refuse to claim the
  // path is contained anywhere: the caller's real-home check gets the last
  // form we reached.
  return current;
}

/**
 * Resolve the shallowest symlink component of `path`, or null when there is
 * none left and the path is fully canonical.
 */
function followFirstLink(path: string): string | null {
  const parts = path.split(sep).filter(Boolean);
  let prefix = "";
  for (const part of parts) {
    prefix = `${prefix}${sep}${part}`;
    let target: string;
    try {
      target = readlinkSync(prefix);
    } catch {
      // Not a symlink, or not there at all: keep the component as written.
      continue;
    }
    const tail = path.slice(prefix.length);
    const resolved = isAbsolute(target) ? target : join(dirname(prefix), target);
    return resolve(`${resolved}${tail}`);
  }
  return null;
}

function isInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Refuse to write shared pairing state unless a test has isolated it.
 *
 * Two conditions, because either alone leaves the hole open:
 *
 * - `OPENSCOUT_HOME` must be set at all, matching every other user-data writer
 *   (`writeLocalConfig`, `writeOpenScoutSettings`). Without it, a path derived
 *   from `homedir()` lands in the runner's real home.
 * - the path must not be inside the REAL `~/.openscout` unless the isolation
 *   variable explicitly points there. A test that sets `OPENSCOUT_HOME` to a
 *   temp directory and then hands us a hard-coded real-home path would satisfy
 *   the first check and still leak, so the destination is checked too.
 *
 * Both checks run on canonical paths, on both sides. Containment is a claim
 * about where the bytes land, and only the resolved path knows that.
 *
 * Outside a test runner this is a no-op: production is exactly the case that is
 * supposed to write to the real home.
 */
export function assertIsolatedPairingRunStateWrite(path: string): void {
  assertTestIsolatedUserData("write shared pairing run state", "OPENSCOUT_HOME");
  if (process.env.NODE_ENV !== "test") return;
  const target = canonicalize(path);
  const isolatedHome = process.env.OPENSCOUT_HOME?.trim();
  if (isolatedHome && isInside(canonicalize(isolatedHome), target)) return;
  if (!isInside(canonicalize(join(homedir(), ".openscout")), target)) return;
  const via = target === resolve(path) ? "" : ` (${path} resolves there)`;
  throw new Error(
    `Refusing to write pairing run state to ${target}${via} while NODE_ENV=test: that path is inside the `
      + "real ~/.openscout. Point OPENSCOUT_HOME at a temp directory (see isolateOpenScoutUserDataForTests).",
  );
}
