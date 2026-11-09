export const SCOUT_HOST_PROBE_SCHEMA_VERSIONS = {
  "tailscale.status": 1,
  "git.buildInfo": 1,
  "git.revParse": 1,
  "git.diffShortstat": 1,
  "git.statusPorcelain": 1,
  "git.mergeBase": 1,
  "git.logLastCommitUnix": 1,
  "git.worktreeListPorcelain": 1,
  "tmux.sessions": 3,
  "tmux.panes": 1,
  "zellij.sessions": 1,
  "ps.runtime": 1,
  "ps.discovery": 1,
  "ps.cwd": 1,
  "net.listeners": 1,
  "repo.scan": 1,
  "repo.diff": 1,
} as const;

export const SCOUT_HOST_EXEC_VERB_SCHEMA_VERSIONS = {
  "tmux.sendKeys": 1,
  "tmux.sendKeysLiteral": 1,
  "tmux.loadBuffer": 1,
  "tmux.pasteBuffer": 1,
  "tmux.deleteBuffer": 1,
  "tmux.killSession": 1,
  "tmux.newSession": 1,
  "tmux.detachClient": 1,
  "tailscale.cert": 1,
  "reveal.open": 1,
} as const;

export type ScoutHostProbeId = keyof typeof SCOUT_HOST_PROBE_SCHEMA_VERSIONS;
export type ScoutHostExecVerb = keyof typeof SCOUT_HOST_EXEC_VERB_SCHEMA_VERSIONS;

export function expectedScoutHostProbeSchemaVersion(probeId: string): number | null {
  return Object.hasOwn(SCOUT_HOST_PROBE_SCHEMA_VERSIONS, probeId)
    ? SCOUT_HOST_PROBE_SCHEMA_VERSIONS[probeId as ScoutHostProbeId]
    : null;
}

export function expectedScoutHostExecVerbSchemaVersion(verb: string): number | null {
  return Object.hasOwn(SCOUT_HOST_EXEC_VERB_SCHEMA_VERSIONS, verb)
    ? SCOUT_HOST_EXEC_VERB_SCHEMA_VERSIONS[verb as ScoutHostExecVerb]
    : null;
}
