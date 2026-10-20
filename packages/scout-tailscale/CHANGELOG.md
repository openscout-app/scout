# Changelog

## 0.3.2 (unreleased candidate)

- Document existing out-of-band bootstrap enrollment without a hosted service.
- Make CLI bootstrap help describe manual enrollment, not only fixtures.
- Replace assumed release URLs with explicit candidate status and verified
  local-wheel installation until a release is approved.
- Use SPDX MIT metadata and include the unchanged LICENSE with setuptools 77+.
- Add a release checklist and metadata consistency tests.

Protocol remains `scout-guest/1`. Python remains 3.11 or newer, with
`cryptography>=42,<51`. Client signing, TLS pinning, state, and ask routing are
unchanged. The owner-side guest CLI, ingress hardening, and Linux admission
instructions are separate Scout changes, not code bundled into this wheel.

## 0.3.1 source baseline

Standalone MIT-licensed client source was added with version 0.3.1. This entry
records source history, not proof of a published artifact or registry release.
