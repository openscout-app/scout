---
name: untrack-folder
description: Keep a local copy of a folder and remove it from Git.
---

Ask for the folder if the brief does not name one.

1. Identify the Git root. Confirm the folder is a tracked directory inside it,
   not the root, a symlink, or a submodule. Inspect the worktree and index.
   Preserve unrelated changes. If the folder has local edits, ask before removal.
2. Copy the whole directory, including hidden and untracked files, to
   the destination named in the brief. If none is given, use
   `~/Documents/OpenScout/<repo>-<folder>` with the repository and folder
   basenames. Use a new location outside the repository. Do not follow
   symlinks or overwrite an existing copy.
3. Compare the source and copy, including file contents and symlink targets.
   Stop if they differ. Keep the verified copy regardless of later Git or PR errors.
4. On a topic branch, run git rm recursively with a literal pathspec for that
   folder only. Do not force removal. If Git removed the now-empty parent
   directory, recreate it. Add a directory-only ignore rule to that parent's
   .gitignore, anchored there and escaped for the literal folder name. Check
   the staged diff and verify Git ignores the path.
5. Commit only the removal and the ignore rule. Use plain sentences for the
   commit subject, PR title and body. Add no trailers. Run local checks only.
   Do not trigger hosted CI. If pushing or opening a PR would trigger it, stop
   before the push and report the blocker. Otherwise push the topic branch
   and open a draft PR against the repository's normal base. Do not merge.

Report the draft PR link and the absolute path of the verified copy.
