import { basename } from "node:path";
import { nodeKeyId } from "./node-identity.js";
import { createHash } from "node:crypto";
import { json, readRequestBody } from "./broker-http-helpers.js";
import { ACCESS_ACTIONS, ACCESS_PROTOCOL, accessMembership, accessRequestHash, MeshAccessError, type AccessProof, type AccessResource, type AccessPolicy, type AccessGrant, type AccessDelegation } from "./mesh-access.js";
import { type MeshAccessStore } from "./mesh-access-store.js";
import type { BrokerGuestHttpDeps } from "./broker-guest-http-routes.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

export type AccessAgent = { id: string; displayName: string; projectRoot?: string };
export type BrokerAccessHttpDeps = Omit<BrokerGuestHttpDeps, "grants" | "listAgents"> & {
  access: MeshAccessStore | null;
  listAgents: () => AccessAgent[];
  enforced?: () => boolean;
  legacyPeers?: () => unknown[];
  ingressPosture?: () => Promise<unknown>;
};
const executionBoundary = "A request on an agent running as the broker owner can provide owner-level local execution unless that agent is sandboxed or runs as another user. Restricted services must be isolated from broker/agent credentials and control files.";
const queues = new Map<string, Promise<unknown>>();
function notFound(): never { throw new MeshAccessError("not_found", "resource not found", 404); }
function deny(): never { throw new MeshAccessError("access_denied", "access denied"); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MeshAccessError("invalid_request", "expected object", 400);
  return value as Record<string, any>;
}
function strict(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new MeshAccessError("invalid_request", "unsupported request field", 400);
}
function workId(proof: AccessProof, requestId: string): string {
  return "scoped-" + createHash("sha256").update(`${proof.networkId}:${proof.principalId}:${requestId}`).digest("hex");
}
function resourceFor(deps: BrokerAccessHttpDeps, proof: AccessProof, id: string): AccessResource | undefined {
  const agent = deps.listAgents().find((a) => a.id === id);
  return agent ? deps.access!.resource(proof.networkId, id, agent.projectRoot) : undefined;
}
function discover(deps: BrokerAccessHttpDeps, proof: AccessProof) {
  const evaluator = deps.access!.prepareAccess(proof, deps.now?.() ?? Date.now());
  return deps.listAgents().flatMap((agent) => {
    const resource = deps.access!.resource(proof.networkId, agent.id, agent.projectRoot);
    if (!resource || !evaluator.allowed("discover", resource)) return [];
    return [{ id: agent.id, displayName: agent.displayName, executionBoundary, ...(resource.projectId ? { projectId: resource.projectId, projectName: agent.projectRoot ? basename(agent.projectRoot) : "Project" } : {}),
      actions: ACCESS_ACTIONS.filter((action) => action !== "admin" && action !== "read-history" && evaluator.allowed(action, resource)) }];
  });
}
export async function handleBrokerAccessRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike,
  url: URL, method: string, deps: BrokerAccessHttpDeps): Promise<boolean> {
  if (url.pathname !== "/v1/access/admin" && url.pathname !== "/v1/access/rpc" && url.pathname !== "/v1/access/policy") return false;
  const store = deps.access;
  try {
    if (!store || !store.healthy()) throw new MeshAccessError("unavailable", "access persistence unavailable", 503);
    if (method !== "POST") throw new MeshAccessError("not_found", "not found", 404);
    if (url.pathname === "/v1/access/policy") {
      if (!deps.enforced?.()) throw new MeshAccessError("scoped_access_unenforced", "protected local ingress required", 409);
      const submitted = object(await readRequestBody(request)); strict(submitted, ["artifact"]);
      store.submitArtifact(submitted.artifact);
      json(response, 200, { accepted: true }); return true;
    }
    const local = url.pathname === "/v1/access/admin";
    if (local && (request.transportContext?.transport === "remote" || request.transportContext?.peer || request.transportContext?.guest || request.transportContext?.scoped)) deny();
    const body = object(await readRequestBody(request));
    const proof = request.transportContext?.scoped;
    if (!local && !proof) deny();
    if (proof) store.verifyDelegation(proof.delegation);
    const operation = body.operation;
    if (operation !== "status" && deps.enforced && !deps.enforced()) throw new MeshAccessError("scoped_access_unenforced", "configure OPENSCOUT_LOCAL_ADMIN_KEY_FILE to remove trusted loopback/Unix fallback before activating scoped access", 409);
    const administrative = ["status", "policy.import", "grant.import", "delegation.import", "revocation.import", "resources.enroll", "revoke", "unrevoke", "preview"];
    if (local || administrative.includes(operation)) {
      if (!local && (!proof || !store.admin(proof))) deny();
      // Trust-root acceptance and local resource enrollment can never be delegated remotely.
      if (!local && ["status", "resources.enroll", "delegation.import", "revoke", "unrevoke", "preview"].includes(operation)) deny();
      const operationFields: Record<string, string[]> = { status: [], "policy.import": ["artifact"], "grant.import": ["artifact"], "delegation.import": ["artifact"], "revocation.import": ["artifact"],
        "resources.enroll": ["networkId", "agentIds", "projects"], revoke: ["networkId", "kind", "id"], unrevoke: ["networkId", "kind", "id"], preview: ["delegation"] };
      if (!Object.hasOwn(operationFields, operation)) throw new MeshAccessError("unsupported_operation", "unsupported access operation", 400);
      strict(body, ["operation", ...(local ? [] : ["delegation"]), ...operationFields[operation]!]);
      let result: unknown;
      switch (operation) {
        case "status": result = { ...store.status(), executionBoundary, ingress: await deps.ingressPosture?.(), enforced: deps.enforced?.() ?? true, legacyMachineAccess: deps.legacyPeers?.() ?? [], localTrustBoundary: "Protected mode authenticates every HTTP listener. Unknown relays gain no operator authority unless inside the trusted OS/key/database boundary; legacy grants remain broad until explicitly revoked.", controlChannels: { tcpAndUnix: "authenticated", upgrades: "disabled", otlp: "disabled", nats: "disabled", managedIroh: "disabled", managedSlack: "disabled", probes: "outbound client only", relayRegistry: "owner-only files; trusted writer boundary", pairing: "matrix-public signed enrollment handshake only" } }; break;
        case "policy.import":
          if (!local && body.artifact?.networkId !== proof!.networkId) deny();
          store.importPolicy(body.artifact, local); result = { ok: true }; break;
        case "grant.import":
          if (!local && body.artifact?.networkId !== proof!.networkId) deny();
          store.importGrant(body.artifact); result = { ok: true }; break;
        case "delegation.import": result = store.importDelegation(body.artifact); break;
        case "revocation.import": store.importRevocation(body.artifact); result = { ok: true }; break;
        case "resources.enroll": {
          const agents = deps.listAgents();
          result = store.enroll({ networkId: body.networkId, agentIds: body.agentIds, projects: body.projects },
            new Set(agents.flatMap((a) => a.projectRoot ? [a.projectRoot] : [])), new Set(agents.map((a) => a.id))); break;
        }
        case "revoke":
          if (!local && (body.networkId !== proof!.networkId || (accessMembership(store.policy(proof!.networkId)!, proof!.principalId)?.role !== "owner" && body.kind !== "grant"))) deny();
          store.revoke(body.networkId, body.kind, body.id); result = { ok: true }; break;
        case "unrevoke": store.unrevoke(body.networkId, body.kind, body.id); result = { ok: true }; break;
        case "preview": { const preview = store.verifyDelegation(body.delegation); result = { agents: discover(deps, preview) }; break; }
        default: throw new MeshAccessError("unsupported_operation", "unsupported access operation", 400);
      }
      // Stores audit actual mutations once; reads, previews and no-op retries
      // must not consume the bounded administration history.
      json(response, 200, result); return true;
    }
    if (!proof) deny();
    if (operation === "whoami") {
      strict(body, ["operation", "delegation"]);
      const policy = store.policy(proof.networkId)!;
      json(response, 200, { protocol: ACCESS_PROTOCOL, principal: accessMembership(policy, proof.principalId),
        executionBoundary, networkId: proof.networkId, deviceId: proof.deviceId, audience: store.audience, policyRevision: policy.revision,
        policyExpiresAt: policy.expiresAt, delegationExpiresAt: proof.delegation.expiresAt,
        supportedOperations: ["whoami", "discover", "network.status", "work.list", "device.approve", "access.preview", "message", "request", "result"], scope: proof.delegation.scope }); return true;
    }
    if (operation === "network.status") {
      strict(body, ["operation", "delegation", "offset"]);
      const offset = body.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new MeshAccessError("invalid_request", "invalid page offset", 400);
      let hasMore = false;
      const page = <T,>(items: T[], start = offset): T[] => { if (items.length > start + 100) hasMore = true; return items.slice(start, start + 100); };
      const policy = store.policy(proof.networkId)!;
      const viewer = accessMembership(policy, proof.principalId)!;
      const canAdmin = store.admin(proof), agents = discover(deps, proof);
      const status = store.scopedStatusRows(proof.networkId, canAdmin ? null : proof.principalId, offset);
      const principals = canAdmin ? [{ principal: policy.root, role: "owner" }, ...policy.members] : [viewer];
      const delegations = status.delegations, devices = status.devices, grants = status.grants;
      const freshness = { lastReceivedAt: status.lastReceivedAt, lastRootIssuedAt: policy.issuedAt };
      const enrollment = store.enrollment(proof.networkId);
      const projectIds = new Set(agents.flatMap((a) => a.projectId ? [a.projectId] : []));
      const visibleScope = (scope: { all: boolean; agentIds: string[]; projectIds: string[] }) => ({ all: false,
        agentIds: agents.filter((a) => scope.all || scope.agentIds.includes(a.id)).map((a) => a.id),
        projectIds: [...projectIds].filter((id) => scope.all || scope.projectIds.includes(id)) });
      const safeGrants = canAdmin ? grants : grants.map(({ signature: _signature, ...g }) => ({ ...g, scope: visibleScope(g.scope), actions: g.actions.filter((a) => proof.delegation.actions.includes(a)) }));
      const safeDelegations = canAdmin ? delegations : delegations.map(({ signature: _signature, ...d }) => ({ ...d, scope: visibleScope(d.scope), actions: d.actions.filter((a) => proof.delegation.actions.includes(a)) }));
      json(response, 200, { network: { id: policy.networkId, label: policy.label, revision: policy.revision, expiresAt: policy.expiresAt, ...freshness },
        viewer, viewerDevice: { scope: canAdmin ? proof.delegation.scope : visibleScope(proof.delegation.scope), actions: proof.delegation.actions, expiresAt: proof.delegation.expiresAt }, canAdmin, canManageMembership: canAdmin && viewer.role === "owner", executionBoundary,
        ...(canAdmin ? { policy } : {}), principals: page(principals), grants: page(safeGrants, 0), delegations: page(safeDelegations, 0), devices: page(devices, 0),
        resources: { agents: page(agents), projects: page((enrollment?.projects ?? []).filter((p) => canAdmin || projectIds.has(p.id)).map((p) => ({ id: p.id, name: basename(p.root), includesFutureAgents: true }))) },
        signedRevocations: page(status.signedRevocations, 0),
        localDenials: page(status.localDenials, 0),
        revokedPrincipalIds: canAdmin ? policy.revokedPrincipalIds : policy.revokedPrincipalIds.filter((id) => id === proof.principalId),
        revokedDeviceIds: policy.revokedDeviceIds.filter((id) => canAdmin || delegations.some((d) => d.principalId === proof.principalId && id === nodeKeyId(d.devicePublicKey))),
        revokedDelegationIds: policy.revokedDelegationIds.filter((id) => canAdmin || id.startsWith(proof.principalId + ":")),
        revokedGrantIds: policy.revokedGrantIds.filter((id) => canAdmin || grants.some((g) => id === g.issuerId + ":" + g.id)),
        pagination: { offset, limit: 100, nextOffset: hasMore ? offset + 100 : null } }); return true;
    }
    if (operation === "access.preview") {
      strict(body, ["operation", "delegation", "artifact"]);
      if (!store.admin(proof) || body.artifact?.networkId !== proof.networkId) deny();
      const preview = store.verifyDelegation(body.artifact);
      json(response, 200, { agents: discover(deps, preview), executionBoundary }); return true;
    }
    if (operation === "device.approve") {
      strict(body, ["operation", "delegation", "artifact"]);
      const artifact = body.artifact as AccessDelegation;
      if (artifact?.networkId !== proof.networkId || artifact?.principalId !== proof.principalId) deny();
      store.importDelegation(artifact);
      json(response, 200, { approved: true, delegation: artifact, possessionProven: store.knownDevice(nodeKeyId(artifact.devicePublicKey)) }); return true;
    }
    if (operation === "work.list") {
      strict(body, ["operation", "delegation"]);
      const evaluator = store.prepareAccess(proof);
      const work = store.ownWork(proof.networkId, proof.principalId).flatMap((record) => {
        const resource = resourceFor(deps, proof, record.agent_id);
        if (!resource || (resource.projectId ?? null) !== record.project_id || !evaluator.allowed("read-own", resource)) return [];
        const invocation = deps.existingInvocation(record.id);
        if (!invocation || invocation.requesterId !== `principal.${proof.principalId}` || invocation.targetAgentId !== record.agent_id) return [];
        const flight = deps.flightForInvocation(record.id);
        return [{ id: record.id, agentId: record.agent_id, projectId: resource.projectId, state: flight?.state ?? "queued", summary: flight?.summary?.slice(0, 512) ?? "", createdAt: invocation.createdAt }];
      });
      json(response, 200, { work }); return true;
    }
    if (operation === "discover") {
      strict(body, ["operation", "delegation"]);
      const agents = discover(deps, proof); store.audit(proof, "discover", "collection", "allow", store.policy(proof.networkId)?.revision);
      json(response, 200, { agents }); return true;
    }
    if (operation === "result") {
      strict(body, ["operation", "delegation", "requestId", "workId"]);
      if ((body.requestId !== undefined) === (body.workId !== undefined)) deny();
      if (body.workId !== undefined ? typeof body.workId !== "string" || !/^scoped-[a-f0-9]{64}$/.test(body.workId)
        : typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.requestId)) deny();
      const id = body.workId ?? workId(proof, body.requestId), work = store.work(id);
      if (!work || work.principal_id !== proof.principalId || work.network_id !== proof.networkId) notFound();
      const resource = resourceFor(deps, proof, work.agent_id);
      if (!resource || (resource.projectId ?? null) !== work.project_id || !store.allowed(proof, "read-own", resource)) notFound();
      const invocation = deps.existingInvocation(id);
      if (!invocation || invocation.requesterId !== `principal.${proof.principalId}` || invocation.targetAgentId !== work.agent_id) deny();
      const flight = deps.flightForInvocation(id);
      json(response, 200, { requestId: body.requestId, invocationId: id, state: flight?.state ?? "queued",
        ...(flight?.output !== undefined ? { output: flight.output } : {}), ...(flight?.summary !== undefined ? { summary: flight.summary } : {}),
        ...(flight?.error !== undefined ? { error: flight.error } : {}) }); return true;
    }
    if (operation !== "message" && operation !== "request") throw new MeshAccessError("unsupported_operation", "operation unavailable for scoped access", 400);
    strict(body, ["operation", "delegation", "requestId", "target", "body"]);
    if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.requestId)
      || typeof body.target !== "string" || typeof body.body !== "string" || !body.body.trim() || Buffer.byteLength(body.body) > 32768)
      throw new MeshAccessError("invalid_request", "invalid requestId, target or body", 400);
    const id = workId(proof, body.requestId), payload = { operation, target: body.target, body: body.body };
    const previous = queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const resource = resourceFor(deps, proof, body.target);
      if (!resource || !store.allowed(proof, operation, resource)) notFound();
      const existing = store.work(id);
      if (existing && existing.request_hash !== accessRequestHash(payload)) throw new MeshAccessError("request_conflict", "request ID already used", 409);
      const actorId = `principal.${proof.principalId}`;
      const invocation = deps.existingInvocation(id);
      if (invocation) {
        if (invocation.requesterId !== actorId || invocation.targetAgentId !== body.target) deny();
        return { accepted: true, duplicate: true, requestId: body.requestId, invocationId: id };
      }
      store.recordWork(id, proof, resource, payload);
      await deps.ensureGuestActor({ id: actorId, kind: "bridge", displayName: accessMembership(store.policy(proof.networkId)!, proof.principalId)!.principal.label,
        labels: ["scoped-principal"], metadata: { networkId: proof.networkId, principalId: proof.principalId } });
      if (!resourceFor(deps, proof, body.target) || !store.allowed(proof, operation, resourceFor(deps, proof, body.target)!)) notFound();
      const conversation = await deps.openThread({ requesterId: actorId, targetAgentId: body.target });
      if (!resourceFor(deps, proof, body.target) || !store.allowed(proof, operation, resourceFor(deps, proof, body.target)!)) notFound();
      await deps.postMessage({ id: `msg-${id}`, conversationId: conversation.id, actorId, originNodeId: deps.nodeId, class: "agent", body: body.body,
        mentions: [], audience: operation === "message"
          ? { delivery: "none", visibleTo: [actorId, body.target], reason: "direct_message" }
          : { notify: [body.target], visibleTo: [actorId, body.target], reason: "direct_message" },
        visibility: "private", policy: "durable", createdAt: deps.now?.() ?? Date.now(),
        metadata: { source: ACCESS_PROTOCOL, clientMessageId: id, wake: operation === "message" ? "never" : "permitted", networkId: proof.networkId, principalId: proof.principalId, scopedRequestId: body.requestId } });
      if (operation === "request") {
        if (!resourceFor(deps, proof, body.target) || !store.allowed(proof, "request", resourceFor(deps, proof, body.target)!)) notFound();
        await deps.invoke({ origin: { source: "unknown" }, id, requesterId: actorId, requesterNodeId: deps.nodeId, targetAgentId: body.target, action: "consult", task: body.body,
          conversationId: conversation.id, messageId: `msg-${id}`, ensureAwake: true, stream: false, createdAt: deps.now?.() ?? Date.now(),
          metadata: { source: ACCESS_PROTOCOL, networkId: proof.networkId, principalId: proof.principalId } });
        if (!deps.existingInvocation(id)) throw new MeshAccessError("target_unavailable", "target did not accept work", 409);
      }
      return { accepted: true, duplicate: Boolean(existing), requestId: body.requestId, ...(operation === "request" ? { invocationId: id } : { messageId: `msg-${id}` }) };
    });
    queues.set(id, current);
    try { json(response, 202, await current); } finally { if (queues.get(id) === current) queues.delete(id); }
    return true;
  } catch (error) {
    const known = error instanceof MeshAccessError;
    try { if (request.transportContext?.scoped) deps.access?.audit(request.transportContext.scoped, "request", url.pathname, "deny"); } catch { /* Store failure must remain a controlled denial. */ }
    json(response, known ? error.status : 400, { error: known ? error.code : "invalid_request", detail: known ? error.message : "invalid access request" });
    return true;
  }
}
