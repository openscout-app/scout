# Prepare scout-tailscale 0.3.2

Status: unreleased candidate. This checklist builds and checks local artifacts;
it does not tag, upload, publish, enroll a device, install a grant, or start an
installed runtime. Release approval and publication remain maintainer actions.

## Prerequisites before publication

- Merge the owner guest CLI and its bootstrap interoperability test.
- Review the HTTP proxy refusal, direct-ingress regression coverage, and Linux
  admission instructions. Keep their documented limits visible.
- Rebase onto the repaired public baseline and complete exact-head validation.
  Dispatch hosted CI once for the coherent release batch, not once per branch.
- Run a real Linux guest acceptance: restricted admission, policy positive and
  negative tests, independent node-key confirmation, signed/pinned ask/result,
  retry without duplicate work, scope denial, local revoke, and network removal.
  Fixture success is not evidence that this VM test occurred.
- Verify the intended tag/artifact name is unused and confirm the exact commit,
  version, changelog, LICENSE, Python floor, and dependency bounds.

## Build and check without publishing

From `packages/scout-tailscale`, with Python 3.11 or newer:

```sh
python3 -m venv .release-venv &&
.release-venv/bin/python -m pip install --only-binary=:all: build setuptools wheel twine 'cryptography>=42,<51' &&
PYTHONPATH=src .release-venv/bin/python -m unittest discover -s tests &&
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" .release-venv/bin/python -m build --wheel --no-isolation --outdir dist &&
.release-venv/bin/python -m twine check dist/scout_tailscale-0.3.2-py3-none-any.whl &&
(cd dist && shasum -a 256 scout_tailscale-0.3.2-py3-none-any.whl > SHA256SUMS && shasum -a 256 -c SHA256SUMS)
```

Use a clean build directory. Inspect wheel contents and metadata: only the
standalone Python client, its entrypoint, README metadata, and MIT license
belong in the wheel. It must not contain a runtime, app, credential, local
state, private path, or internal material. Record the tool/dependency versions
used. A checksum covers these exact artifact bytes; rebuilds require new
checksums and validation even when the version is unchanged.

Install the verified wheel in a second fresh virtualenv, outside the source
import path. Check `scout-tailscale --version`, `--help`, and
`connect --help`. Test key creation only with a temporary
`SCOUT_TAILSCALE_HOME`. Never overwrite an existing client identity for a smoke
test. Check dependency metadata with `pip check` in that environment.

## Publication handoff

Keep the candidate wheel, SHA256SUMS, exact source commit, validation results,
known failures/skips, and real acceptance receipts together. Resolve all
blocking baseline failures and review findings first. Maintainers then choose
whether to create the versioned GitHub release and upload these exact bytes.
Do not publish to a registry or silently switch distribution channels. Update
README installation links only after the canonical release assets exist.
