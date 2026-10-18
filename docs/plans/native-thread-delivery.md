# Native Codex thread delivery

## Design

- Discover app-held threads from live writer evidence, independently of historical search coverage.
- Expose exact thread identity and available draft/submit modes; never create a replacement writer.
- Treat harness-only constraints on an exact session as lookup filters; retain model/effort verification.
- Draft opens the exact `codex://` thread link, fills the composer, never invokes submission, and reports `delivered: draft` (not transcript delivery).
- Submit requires an idle thread, content-anchored composer selection, and transcript confirmation; ambiguous activity fails closed.
- Prefer Scout's Accessibility bridge, then standalone Lattices with equivalent content anchoring.
- Explicit requester addresses are evidence; never infer a return route from arbitrary transcript text.
- Cancellation belongs to broker-owned queued work, with an atomic pre-submission guard.
- Surface actionable errors and document discovery, draft, submit, and confirmation separately.

## Delivery slices

1. Draft runtime + MCP + CLI, injected transport tests, documentation.
2. Exact-session harness filtering and attached-placement schema parity.
3. Live discovery, safe submit fallback, explicit return-address propagation and guarded cancellation.

Do not merge, install, or restart services as part of this work. Native UI tests must use injected transports.
