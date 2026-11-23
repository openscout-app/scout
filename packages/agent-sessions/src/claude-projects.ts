import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export function claudeProjectsRoot(home = homedir()): string {
  return process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT ?? join(home, ".claude", "projects");
}

/** A local-root override opts out of the default mirror, but not an explicit mirror. */
export function claudeMirrorRoot(localOverride = false, defaultHubHome?: () => string): string | undefined {
  const explicit = process.env.OPENSCOUT_HUB_CLAUDE_MIRROR_ROOT?.trim();
  if (explicit) return explicit;
  if (localOverride || process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT) return undefined;
  const openscoutHome = process.env.OPENSCOUT_HOME?.trim();
  const hubHome = process.env.OPENSCOUT_HUB_HOME?.trim()
    || (openscoutHome && join(openscoutHome, "hub")) || defaultHubHome?.();
  return hubHome ? join(hubHome, "claude", "projects") : undefined;
}

export function claudeProjectFolder(root: string, filePath: string): string | undefined {
  const rel = relative(root, filePath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  const parts = rel.split(sep);
  return parts.length >= 2 ? parts[0] : undefined;
}

/** Standalone history readers do not resolve runtime instances or scan their stores. */
export function claudeMirrorLabelForHistoryPath(filePath: string): string | undefined {
  const mirror = claudeMirrorRoot();
  if (mirror) return claudeProjectFolder(mirror, filePath);
  if (process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT) return undefined;
  return /\/\.openscout\/(?:instances\/[^/]+\/)?hub\/claude\/projects\/([^/]+)\//u.exec(filePath)?.[1];
}

export function isClaudeHistoryPath(filePath: string): boolean {
  return Boolean(claudeMirrorLabelForHistoryPath(filePath)
    || claudeProjectFolder(claudeProjectsRoot(), filePath)
    || filePath.toLowerCase().includes("/.claude/projects/"));
}
