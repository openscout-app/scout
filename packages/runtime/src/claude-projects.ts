import { homedir } from "node:os";
import { resolve } from "node:path";
import { claudeMirrorRoot, claudeProjectFolder, claudeProjectsRoot } from "@openscout/agent-sessions";

import { resolveHubHome } from "./hub/state.js";

export { claudeProjectsRoot };

export function claudeProjectRoots(home = homedir(), localOverride?: string): Array<{ root: string; mirror: boolean }> {
  const local = localOverride || claudeProjectsRoot(home);
  const roots = [{ root: local, mirror: false }];
  let mirror: string | undefined;
  try {
    mirror = claudeMirrorRoot(Boolean(localOverride), resolveHubHome);
  } catch {
    // Discovery can still read local transcripts without a valid instance layout.
  }
  if (mirror && resolve(local) !== resolve(mirror)) roots.push({ root: mirror, mirror: true });
  return roots;
}

export function claudeProjectForPath(filePath: string, roots = claudeProjectRoots()): { folder: string; mirror: boolean } | undefined {
  // Prefer the more specific root when the explicit mirror lives inside the local store.
  for (const entry of [...roots].sort((a, b) => resolve(b.root).length - resolve(a.root).length)) {
    const folder = claudeProjectFolder(entry.root, filePath);
    if (folder) return { folder, mirror: entry.mirror };
  }
  return undefined;
}

export function hubLabelForPath(filePath: string): string | undefined {
  const project = claudeProjectForPath(filePath);
  return project?.mirror ? project.folder : undefined;
}
