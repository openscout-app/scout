# Release-train evidence recipes

Use these recipes to collect evidence. They do not grant mutation authority.

## Contents

- Baseline and worktree discovery
- GitHub and review state
- Scout owner polling
- Commit, reconciliation, and release gates
- Review escalation
- Recovery and completion

## Baseline and worktree discovery

```bash
git fetch origin
git status --short --branch
git remote -v
git branch --show-current
git log -12 --oneline --decorate
git diff --stat
git diff --cached --stat
git branch -vv
git worktree list --porcelain
python3 scripts/derived-state/roster.py
```

For each live checkout record the exact path, branch or detached state, HEAD,
dirty paths, `origin/main...HEAD` ancestry counts, upstream, owner/task
registration, commits, and linked PR. Treat every non-artifact diff as
intentional until its owner says otherwise.

Build stable lane IDs from repository identity + canonical checkout path +
branch. Never use a display title as an idempotency key.

## GitHub and review state

Prefer the connected GitHub app for structured PR metadata and review threads;
use `gh` for current-branch discovery and Actions logs.

```bash
gh repo view --json nameWithOwner,defaultBranchRef,url,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed
gh pr list --state open --limit 100 --json number,title,url,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt,author
gh pr view <number> --json commits,files,reviews,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks <number>
```

Inspect unresolved review threads separately. Compare actual diffs and ancestry
before calling work duplicate or superseded.

## Scout owner polling

Use `ask`, because a classification reply is required. Send one DM per owner,
keep the concrete branch/worktree in the body, and preserve returned flight,
conversation, work, message, and session refs.

```text
OpenScout release-train convergence poll.
Believed owner: <owner>
Checkout: <absolute path>
Branch: <branch>
HEAD: <sha>

Reply within 10 minutes with exactly one disposition:
- READY — include checks, dirty state, and whether you authorize the release-train lead to rebase/reconcile/push.
- HOLD — include reason and next action.
- BLOCK — include blocker owner and next action.
- EXCLUDE — include reason.

Do not mutate another lane. HOLD/EXCLUDE is authoritative.
```

Prefer `scout ask --to session:<id>` for exact continuity. Use
project+harness routing only when no owner session exists. A failed Scout poll
is `BLOCK`, not implied consent, but only after the transport diagnostic gate
below. Broadcast only the final project-scoped convergence ledger to relevant
OpenScout agents.

### Scout transport diagnostic gate

Agent tool sandboxes can deny loopback/network access while the local Scout
broker remains healthy. A connection failure from a restricted execution is
not sufficient evidence for a Scout outage or lane `BLOCK`.

1. Preserve the failing command, stderr, exit status, execution restrictions,
   and timestamp.
2. With explicit loopback/network access, run `scout whoami --json` only as a
   transport probe. Then retry the original `scout ask`, `wait`, or other
   operation with the same target and request. If the first attempt returned a
   durable flight/ref, resume or wait on it instead of issuing a duplicate ask.
3. Let the unrestricted original operation decide the lane result. Success
   proves sandbox isolation and the lane continues. If `whoami` succeeds but
   the operation fails, record the failed poll/action rather than a broker
   outage. If both fail at transport, collect read-only service evidence
   (configured broker URL/socket, service state, and listener) before recording
   a transport `BLOCK` with an owner and next action.
4. Store both attempts as diagnostic evidence on one stage artifact/reason; do
   not create duplicate `owner_poll` receipt rows for the same lane and target.
   Never restart, reconfigure, or repoint the broker as a sandbox workaround.

For this Codex environment, step 2 means rerunning the command with the tool's
network escalation (`sandbox_permissions: require_escalated`). Do not claim a
broker outage when that retry was not attempted or not authorized. In that
case, leave S20 unadvanced and resume the diagnostic next cycle with the needed
network authority.

## Commit, reconciliation, and release gates

- Stage explicit paths after reviewing the complete diff.
- Use gitmoji and preserve authorship; never add AI attribution.
- Push without force.
- Ask the owner to rebase first. Reconcile an owner branch yourself only with an
  explicit receipt authorizing it.
- Re-read `docs/releases.md` and `docs/eng/releasing.md` at S90.
- Use `npm run ship -- <version>` for a release dry run. Execute only the
  repository's canonical command with an unambiguous version/channel/signing
  decision and required credentials.
- Verify remote merge reachability, tag target, GitHub release, workflow runs,
  artifacts, and registry/deployment state. A successful command is not a
  release receipt by itself.

## Review escalation

| Risk | Minimum review | Examples |
| --- | --- | --- |
| Low | SELF | narrow docs, tests only, small local refactor |
| Medium | INDEPENDENT | cross-package behavior, substantial UI/UX, runtime lifecycle |
| High | INDEPENDENT | architecture, security/privacy, migration/data integrity, public protocol/API, release/signing |
| Critical | MULTI_AGENT | multiple high-risk domains or low confidence after independent review |

For an independent Scout review, send a read-only brief with topic, workspace,
user goal, observed problem, current state, constraints, and concrete questions.
Classify every finding `must_fix`, `should_fix`, `follow_up`, or `reject`.

## Recovery and completion

- Resume the newest incomplete checkpoint.
- Reuse an existing branch/PR/tag/release receipt instead of duplicating it.
- Quarantine a blocked lane and continue independent READY lanes.
- Loop S70 or S80 to S40/S50 only through encoded transitions.
- Stop S90 on ambiguity; do not guess a version, channel, tag, signing identity,
  deployment, or publication owner.
- Complete S110 with ready-to-merge, needs-review, needs-follow-up,
  held/excluded, and shipped queues plus stable receipts and next owners.


## Local validation and hosted opt-in

Read [local-delivery.md](local-delivery.md) for the normative evidence contract.
Do not dispatch GitHub Actions as a default review step. Record required local
checks at S30 and their exact-head/base receipts at S50. Before S60/S80 and each
merge, freshly inspect the PR head, base, mergeability, reviews, protection and
rulesets using GitHub's read API. Persist the observation with the receipts.
Merge using `--match-head-commit <reviewed-head>`; if the base or head changes,
return to validation and refresh the exact revision receipts. Do not create
synthetic check runs or statuses, dismiss feedback, or bypass a remote rule.
