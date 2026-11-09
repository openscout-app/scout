import { IntegrationWorkerLeases, type IntegrationWorkerGrant } from "./integration-worker-leases.js";
import { slackAppManifest } from "@openscout/protocol";
import type { SlackWorkerIdentity } from "./slack-worker-process.js";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import type { SlackCredentialReference, SlackProjectBinding, SlackSetupOperation, SlackSetupReceipt, ScoutDeliverRequest, ScoutDeliverAcceptedResponse } from "@openscout/protocol";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";

const workspace = z.string().regex(/^T[A-Z0-9]+$/);
const setupInput = z.object({
  provider: z.literal("slack"), mode: z.literal("project_agent"),
  projectPath: z.string().min(1).max(4096).refine(isAbsolute, "projectPath must be absolute"),
  agentId: z.string().min(1).max(256).optional(),
  displayName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  workspaceId: workspace.optional(), idempotencyKey: z.string().min(1).max(256).optional(),
}).strict();
const revision = z.number().int().positive();
const resumeInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("choose_workspace"), expectedRevision: revision, workspaceId: workspace }).strict(),
  z.object({ action: z.literal("confirm_authority"), expectedRevision: revision }).strict(),
  z.object({ action: z.literal("register_app"), expectedRevision: revision, appId: z.string().regex(/^A[A-Z0-9]+$/) }).strict(),
]);

const credentialInput = z.object({
  expectedRevision: revision,
  rotate: z.boolean().optional(),
  reference: z.object({ backend: z.enum(["secret_cli", "private_file"]), appTokenKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/), botTokenKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/) }).strict(),
  allowedUserIds: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).min(1).max(100),
  allowedChannelIds: z.array(z.string().regex(/^[CG][A-Z0-9]+$/)).max(100),
}).strict();

type Row = { record_json: string };
export class IntegrationSetupError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function decode(row: Row | null): SlackSetupOperation | undefined {
  return row ? JSON.parse(row.record_json) as SlackSetupOperation : undefined;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  // Never echo untrusted body values (including accidentally supplied secrets).
  if (!result.success) throw new IntegrationSetupError("invalid_request", "Invalid integration request. Use the documented token-free fields.", 400);
  return result.data;
}

/** The broker is the sole writer; every read-modify-write runs in its shared SQLite transaction. */
export class BrokerIntegrationSetupService {
  readonly workers: IntegrationWorkerLeases;
  constructor(private readonly deps: {
    database: ControlPlaneSqliteTransactionalDatabase;
    ownerRealmId: string;
    nodeId: string;
    snapshot: () => RuntimeSnapshot;
    now?: () => number;
    createId?: () => string;
    verifyCredentials?: (input: { reference: SlackCredentialReference; teamId: string; appId: string }) => Promise<SlackWorkerIdentity>;
  }) { this.workers = new IntegrationWorkerLeases(deps.database, undefined, deps.now ?? Date.now); }

  private get db() { return this.deps.database; }
  private now() { return (this.deps.now ?? Date.now)(); }
  private scope(binding: SlackProjectBinding) {
    return digest([binding.nodeId, binding.agentId, binding.projectPath]);
  }
  private row(id: string): SlackSetupOperation {
    const operation = decode(this.db.query<Row>("SELECT record_json FROM integration_setup_operations WHERE id = ?1 AND owner_realm_id = ?2")
      .get(id, this.deps.ownerRealmId));
    if (!operation) throw new IntegrationSetupError("not_found", "Integration setup operation not found.", 404);
    return operation;
  }
  private binding(projectPath: string, agentId?: string): SlackProjectBinding {
    const snapshot = this.deps.snapshot();
    const root = normalize(projectPath);
    const candidates = Object.values(snapshot.agents).filter((agent) => {
      if (agentId && agent.id !== agentId) return false;
      if (agent.homeNodeId !== this.deps.nodeId || agent.authorityNodeId !== this.deps.nodeId) return false;
      const roots = new Set(Object.values(snapshot.endpoints).filter((endpoint) => endpoint.agentId === agent.id)
        .map((endpoint) => endpoint.projectRoot ?? endpoint.cwd).filter((path): path is string => Boolean(path)).map(normalize));
      const configuredRoot = agent.metadata?.projectRoot;
      if (typeof configuredRoot === "string") roots.add(normalize(configuredRoot));
      // Never choose an arbitrary endpoint when an agent spans multiple projects.
      return roots.size === 1 && roots.has(root);
    });
    if (candidates.length !== 1) throw new IntegrationSetupError("project_agent_unresolved", "Choose one registered local project agent with an unambiguous project root.");
    const agent = candidates[0]!;
    return { agentId: agent.id, definitionId: agent.definitionId, projectPath: root, nodeId: this.deps.nodeId, revision: 1 };
  }
  private assertBinding(operation: SlackSetupOperation) {
    const binding = this.binding(operation.binding.projectPath, operation.binding.agentId);
    if (binding.definitionId !== operation.binding.definitionId) throw new IntegrationSetupError("binding_changed", "The project agent definition changed; reconcile the binding before continuing.");
  }
  private receipt(operation: SlackSetupOperation): SlackSetupReceipt {
    const actions = {
      awaiting_workspace: { kind: "choose_workspace", title: "Choose the Slack workspace for this project agent." },
      awaiting_authority: { kind: "confirm_authority", title: "Confirm that the operator can install apps in this Slack workspace." },
      awaiting_app: { kind: "create_or_connect_app", title: "Create or connect a dedicated Slack app for this project agent, then record its app ID." },
      ready_to_start: { kind: "start_worker", title: "Start the supervised project Slack worker with the verified credential references." },
      awaiting_credentials: { kind: "connect_secrets", title: "Install the app and attach its credentials through the local secure setup flow." },
    } as const;
    const worker = this.workers.observe(operation.id);
    const eventQueue = this.db.query<{ pending: number; retrying: number }>("SELECT COUNT(*) AS pending, COALESCE(SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END), 0) AS retrying FROM integration_slack_events WHERE operation_id = ?1 AND state = 'pending'").get(operation.id)!;
    const connected = operation.desiredState === "running" && worker?.state === "connected";
    const verified = operation.verification?.bindingRevision === operation.binding.revision && operation.verification?.credentialVerifiedAt === operation.credentials?.verifiedAt;
    const next = connected && verified ? { kind: "complete" as const, title: "Request, result delivery, and threaded continuation are verified. The worker is connected." } : operation.desiredState === "running"
      ? connected ? { kind: "verify_integration" as const, title: "Send a test mention and verify the returned result and threaded follow-up." }
        : { kind: "wait_for_worker" as const, title: operation.workerError ? "The worker is unavailable. Check the local Slack companion and credential helper; the supervisor will retry." : "Wait for the supervised worker to establish its verified Slack connection." }
      : actions[operation.state];
    return { operation, eventQueue, nextAction: { id: `${operation.id}:${operation.revision}`, ...next }, readiness: connected ? verified ? "verified" : "connected_unverified" : "not_connected", ...(worker ? { worker } : {}) };
  }
  manifest(id: string): Record<string, unknown> {
    const operation = this.row(id);
    if (!operation.authorityConfirmedAt) throw new IntegrationSetupError("authority_required", "Confirm workspace installation authority before preparing an app.");
    const manifest = slackAppManifest(operation.displayName, "project");
    if (digest(manifest) !== operation.manifestHash) throw new IntegrationSetupError("manifest_changed", "The setup manifest changed since this operation was prepared. Reconcile the app configuration before continuing.");
    return manifest;
  }
  get(id: string): SlackSetupReceipt { return this.receipt(this.row(id)); }
  /** Every setup operation in this realm, oldest first; receipts carry credential references, never secrets. */
  list(): SlackSetupReceipt[] {
    return this.db.query<Row>("SELECT record_json FROM integration_setup_operations WHERE owner_realm_id = ?1").all(this.deps.ownerRealmId)
      .map(row => decode(row)!)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(operation => this.receipt(operation));
  }
  classifyMention(id: string, text: string): "addressed" | "not_addressed" | "ambiguous" {
    const operation = this.row(id);
    const mentions = new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)].map(match => match[1]));
    if (!operation.credentials || !mentions.has(operation.credentials.botUserId)) return "not_addressed";
    const known = this.db.query<Row>("SELECT record_json FROM integration_setup_operations WHERE owner_realm_id = ?1 AND workspace_key = ?2")
      .all(operation.ownerRealmId, operation.workspaceId!).map(row => decode(row)?.credentials?.botUserId).filter((id): id is string => Boolean(id));
    return new Set(known.filter(bot => mentions.has(bot))).size > 1 ? "ambiguous" : "addressed";
  }

  verify(id: string, input: unknown): SlackSetupReceipt {
    const request = parse(z.object({ expectedRevision: revision }).strict(), input);
    return this.db.transaction(() => {
      const operation = this.row(id);
      if (operation.revision !== request.expectedRevision) throw new IntegrationSetupError("revision_conflict", "Setup changed. Read its current status before continuing.");
      this.assertBinding(operation);
      if (!operation.credentials || this.receipt(operation).readiness === "not_connected") throw new IntegrationSetupError("not_connected", "Connect the project worker before verifying request and result delivery.");
      if (operation.verification?.bindingRevision === operation.binding.revision && operation.verification.credentialVerifiedAt === operation.credentials.verifiedAt) return this.receipt(operation);
      const rows = this.db.query<{ event_id: string; channel_id: string; thread_ts: string; result_completed_at: number; request_json: string; response_json: string }>(`
        SELECT event.event_id,event.channel_id,event.thread_ts,event.result_completed_at,delivery.request_json,delivery.response_json
        FROM integration_slack_events AS event JOIN integration_slack_deliveries AS delivery
          ON event.operation_id = delivery.operation_id AND event.delivery_key = delivery.event_key
        WHERE event.operation_id = ?1 AND event.binding_revision = ?2 AND delivery.binding_revision = ?2
          AND event.state = 'processed' AND json_extract(event.envelope_json, '$.payload.event.type') = 'app_mention' AND event.progress_json IS NOT NULL AND event.result_completed_at IS NOT NULL
          AND event.received_at >= ?3 AND delivery.response_json IS NOT NULL
        ORDER BY event.received_at DESC,event.rowid DESC LIMIT 1000`).all(id, operation.binding.revision, operation.credentials.verifiedAt).reverse();
      const snapshot = this.deps.snapshot();
      const completed = rows.flatMap(row => {
        const delivery = JSON.parse(row.response_json) as ScoutDeliverAcceptedResponse;
        const request = JSON.parse(row.request_json) as ScoutDeliverRequest;
        if (delivery.kind !== "delivery" || !delivery.flight?.invocationId) return [];
        const flight = snapshot.flights[delivery.flight.id];
        if (!flight || flight.state !== "completed" || flight.invocationId !== delivery.flight.invocationId || flight.targetAgentId !== operation.binding.agentId) return [];
        return [{ row, request, delivery, evidence: { eventId: row.event_id, invocationId: flight.invocationId, messageId: delivery.receipt.messageId, resultDeliveredAt: row.result_completed_at } }];
      });
      for (const first of completed) {
        if (first.request.target?.kind !== "agent_id" || first.request.target.agentId !== operation.binding.agentId) continue;
        const followUp = completed.find(candidate => candidate.row.event_id !== first.row.event_id
          && candidate.row.channel_id === first.row.channel_id && candidate.row.thread_ts === first.row.thread_ts
          && candidate.request.target?.kind === "binding_ref" && candidate.request.target.ref === first.delivery.receipt.messageId
          && candidate.delivery.receipt.conversationId === first.delivery.receipt.conversationId
          && candidate.evidence.invocationId !== first.evidence.invocationId);
        if (!followUp) continue;
        return this.receipt(this.update(operation, { verification: { bindingRevision: operation.binding.revision, credentialVerifiedAt: operation.credentials.verifiedAt,
          verifiedAt: this.now(), channelId: first.row.channel_id, threadTs: first.row.thread_ts, first: first.evidence, followUp: followUp.evidence } }));
      }
      throw new IntegrationSetupError("verification_incomplete", "No completed request and exact threaded follow-up with delivered Slack results were found. Send a mention, wait for its result, then mention the same bot in that thread and verify again.");
    })();
  }

  setup(input: unknown): SlackSetupReceipt {
    const request = parse(setupInput, input);
    return this.db.transaction(() => {
      const binding = this.binding(request.projectPath, request.agentId);
      const scopeKey = this.scope(binding);
      const displayName = request.displayName ?? this.deps.snapshot().agents[binding.agentId]!.displayName;
      const requestHash = digest({ binding, displayName, workspaceId: request.workspaceId ?? null });
      if (request.idempotencyKey) {
        const prior = this.db.query<{ request_hash: string; operation_id: string }>(
          "SELECT request_hash, operation_id FROM integration_setup_requests WHERE owner_realm_id = ?1 AND request_key = ?2",
        ).get(this.deps.ownerRealmId, request.idempotencyKey);
        if (prior) {
          if (prior.request_hash !== requestHash) throw new IntegrationSetupError("idempotency_conflict", "This idempotency key belongs to a different setup request.");
          const priorReceipt = this.get(prior.operation_id);
          if (this.scope(priorReceipt.operation.binding) !== scopeKey) throw new IntegrationSetupError("idempotency_conflict", "This setup operation was rebound. Use its current operation ID or a new setup key.");
          return priorReceipt;
        }
      }
      // Reuse an exact workspace operation, then a pre-workspace draft. A missing
      // workspace cannot pick one of several existing workspace installations.
      const rows = this.db.query<Row>("SELECT record_json FROM integration_setup_operations WHERE owner_realm_id = ?1 AND scope_key = ?2")
        .all(this.deps.ownerRealmId, scopeKey).map((row) => decode(row)!);
      let operation = request.workspaceId
        ? rows.find((row) => row.workspaceId === request.workspaceId) ?? rows.find((row) => !row.workspaceId)
        : rows.find((row) => !row.workspaceId) ?? (rows.length === 1 ? rows[0] : undefined);
      if (!request.workspaceId && rows.length > 1 && !operation) throw new IntegrationSetupError("workspace_required", "Choose a workspace; this project already has multiple setup operations.");
      if (operation) this.assertBinding(operation);
      if (operation && operation.displayName !== displayName) throw new IntegrationSetupError("identity_conflict", "This project already has a setup operation with a different display name.");
      if (!operation) {
        const now = this.now();
        operation = { id: (this.deps.createId ?? randomUUID)(), provider: "slack", mode: "project_agent", ownerRealmId: this.deps.ownerRealmId,
          binding, displayName, manifestHash: digest(slackAppManifest(displayName, "project")), ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          state: request.workspaceId ? "awaiting_authority" : "awaiting_workspace", revision: 1, createdAt: now, updatedAt: now };
        this.db.query("INSERT INTO integration_setup_operations (id, owner_realm_id, scope_key, workspace_key, revision, record_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .run(operation.id, operation.ownerRealmId, scopeKey, operation.workspaceId ?? "", operation.revision, JSON.stringify(operation));
      } else if (request.workspaceId && !operation.workspaceId) {
        operation = this.update(operation, { workspaceId: request.workspaceId, state: "awaiting_authority" });
      }
      if (request.idempotencyKey) this.db.query("INSERT INTO integration_setup_requests (owner_realm_id, request_key, request_hash, operation_id) VALUES (?1, ?2, ?3, ?4)")
        .run(this.deps.ownerRealmId, request.idempotencyKey, requestHash, operation.id);
      return this.receipt(operation);
    })();
  }

  resume(id: string, input: unknown): SlackSetupReceipt {
    const request = parse(resumeInput, input);
    return this.db.transaction(() => {
      const operation = this.row(id);
      if (operation.revision !== request.expectedRevision) throw new IntegrationSetupError("revision_conflict", "Setup changed. Read its current status before continuing.");
      this.assertBinding(operation);
      switch (request.action) {
        case "choose_workspace": {
          if (operation.state !== "awaiting_workspace") throw new IntegrationSetupError("invalid_transition", "Workspace selection is already recorded.");
          const existing = this.db.query("SELECT id FROM integration_setup_operations WHERE owner_realm_id = ?1 AND scope_key = ?2 AND workspace_key = ?3")
            .get(operation.ownerRealmId, this.scope(operation.binding), request.workspaceId);
          if (existing) throw new IntegrationSetupError("installation_exists", "This project already has setup for the selected workspace. Resume that operation.");
          return this.receipt(this.update(operation, { workspaceId: request.workspaceId, state: "awaiting_authority" }));
        }
        case "confirm_authority":
          if (operation.state !== "awaiting_authority") throw new IntegrationSetupError("invalid_transition", "Authority confirmation is not the current setup step.");
          return this.receipt(this.update(operation, { authorityConfirmedAt: this.now(), state: "awaiting_app" }));
        case "register_app": {
          if (operation.state !== "awaiting_app") throw new IntegrationSetupError("invalid_transition", "App registration is not the current setup step.");
          const existing = this.db.query("SELECT id FROM integration_setup_operations WHERE owner_realm_id = ?1 AND workspace_key = ?2 AND app_id = ?3")
            .get(operation.ownerRealmId, operation.workspaceId, request.appId);
          if (existing) throw new IntegrationSetupError("app_already_bound", "This Slack app is already claimed by another setup operation.");
          return this.receipt(this.update(operation, { appId: request.appId, state: "awaiting_credentials" }));
        }
      }
    })();
  }
  async attachCredentials(id: string, input: unknown): Promise<SlackSetupReceipt> {
    const request = parse(credentialInput, input);
    if (request.reference.appTokenKey === request.reference.botTokenKey
      || /^(xapp|xoxb)-/.test(request.reference.appTokenKey) || /^(xapp|xoxb)-/.test(request.reference.botTokenKey)) {
      throw new IntegrationSetupError("invalid_reference", "Provide distinct local credential entry names, never token values.", 400);
    }
    const operation = this.row(id);
    if (operation.revision !== request.expectedRevision) throw new IntegrationSetupError("revision_conflict", "Setup changed. Read its current status before continuing.");
    if ((request.rotate ? operation.state !== "ready_to_start" || !operation.credentials : operation.state !== "awaiting_credentials") || !operation.appId || !operation.workspaceId) throw new IntegrationSetupError("invalid_transition", "Credential attachment is not the current setup step.");
    if (request.rotate && operation.desiredState === "running") throw new IntegrationSetupError("pause_required", "Pause this installation before rotating credentials. Existing references remain active until replacements verify.");
    if (request.rotate && operation.credentials) {
      const normalized = (values: string[]) => JSON.stringify([...new Set(values)].sort());
      const policyChanged = normalized(request.allowedUserIds) !== normalized(operation.credentials.allowedUserIds) || normalized(request.allowedChannelIds) !== normalized(operation.credentials.allowedChannelIds);
      if (policyChanged && this.db.query("SELECT 1 FROM integration_slack_events WHERE operation_id = ?1 AND (state = 'pending' OR (progress_json IS NOT NULL AND result_completed_at IS NULL)) LIMIT 1").get(id)) {
        throw new IntegrationSetupError("policy_work_pending", "Drain pending intake and result delivery under the existing policy before changing allowed users or channels.");
      }
    }
    this.assertBinding(operation);
    if (!this.deps.verifyCredentials) throw new IntegrationSetupError("verifier_unavailable", "The local Slack credential verifier is unavailable.", 503);
    let identity: SlackWorkerIdentity;
    try {
      identity = await this.deps.verifyCredentials({ reference: request.reference, teamId: operation.workspaceId, appId: operation.appId });
    } catch {
      throw new IntegrationSetupError("credentials_unverified", "Slack credentials could not be verified. Check the local helper, credential entries, and app installation, then retry.", 422);
    }
    if (identity.teamId !== operation.workspaceId || identity.appId !== operation.appId || !/^B[A-Z0-9]+$/.test(identity.botId) || !/^[UW][A-Z0-9]+$/.test(identity.botUserId)) {
      throw new IntegrationSetupError("identity_mismatch", "The verified Slack identity does not match this setup operation.", 422);
    }
    if (request.rotate && (identity.botId !== operation.credentials?.botId || identity.botUserId !== operation.credentials?.botUserId)) throw new IntegrationSetupError("identity_mismatch", "Replacement credentials must belong to the existing Slack bot.", 422);
    return this.db.transaction(() => {
      const current = this.row(id);
      if (current.revision !== request.expectedRevision) throw new IntegrationSetupError("revision_conflict", "Setup changed during credential verification. Read status before retrying.");
      this.assertBinding(current);
      if (request.rotate) this.workers.revoke(id);
      return this.receipt(this.update(current, {
        verification: undefined, workerError: undefined,
        state: "ready_to_start", credentials: { reference: request.reference, botId: identity.botId, botUserId: identity.botUserId,
          verifiedAt: Math.max(this.now(), (current.credentials?.verifiedAt ?? 0) + 1), allowedUserIds: [...new Set(request.allowedUserIds)], allowedChannelIds: [...new Set(request.allowedChannelIds)] },
      }));
    })();
  }

  rebind(id: string, input: unknown): SlackSetupReceipt {
    const request = parse(z.object({ expectedRevision: revision, projectPath: z.string().max(4096).refine(isAbsolute), agentId: z.string().min(1).max(256).optional() }).strict(), input);
    return this.db.transaction(() => {
      const operation = this.row(id);
      if (operation.revision !== request.expectedRevision) throw new IntegrationSetupError("revision_conflict", "Setup changed. Read its current status before continuing.");
      if (operation.state !== "ready_to_start" || operation.desiredState !== "paused") throw new IntegrationSetupError("pause_required", "Pause an installed project integration before rebinding it.");
      const binding = this.binding(request.projectPath, request.agentId);
      if (this.scope(binding) === this.scope(operation.binding) && binding.definitionId === operation.binding.definitionId) return this.receipt(operation);
      const busy = this.db.query("SELECT 1 FROM integration_slack_events WHERE operation_id = ?1 AND (state = 'pending' OR (progress_json IS NOT NULL AND result_completed_at IS NULL)) LIMIT 1").get(id);
      const pendingAcceptance = this.db.query("SELECT 1 FROM integration_slack_deliveries WHERE operation_id = ?1 AND response_json IS NULL LIMIT 1").get(id);
      if (busy || pendingAcceptance) throw new IntegrationSetupError("work_pending", "Finish event recovery and result delivery before changing the project binding. Resume the original worker to drain it.");
      const conflict = this.db.query("SELECT id FROM integration_setup_operations WHERE owner_realm_id = ?1 AND scope_key = ?2 AND workspace_key = ?3 AND id != ?4").get(operation.ownerRealmId, this.scope(binding), operation.workspaceId ?? "", id);
      if (conflict) throw new IntegrationSetupError("binding_conflict", "That project already has an integration in this workspace.");
      this.workers.revoke(id);
      return this.receipt(this.update(operation, { binding: { ...binding, revision: operation.binding.revision + 1 }, verification: undefined, workerError: undefined }));
    })();
  }

  setLifecycle(id: string, input: unknown): SlackSetupReceipt {
    const request = parse(z.object({ action: z.enum(["start", "pause", "disconnect"]), expectedRevision: revision }).strict(), input);
    return this.db.transaction(() => {
      const operation = this.row(id);
      if (operation.revision !== request.expectedRevision) throw new IntegrationSetupError("revision_conflict", "Setup changed. Read its current status before continuing.");
      if (request.action === "start") {
        if (!operation.credentials || operation.state !== "ready_to_start") throw new IntegrationSetupError("credentials_required", "Verify installation credentials before starting a worker.");
        this.assertBinding(operation);
      } else this.workers.revoke(id);
      const desiredState = request.action === "start" ? "running" : request.action === "pause" ? "paused" : "disconnected";
      return this.receipt(this.update(operation, { desiredState, workerError: undefined }));
    })();
  }
  wantedWorkers(): SlackSetupOperation[] {
    return this.db.query<Row>("SELECT record_json FROM integration_setup_operations WHERE owner_realm_id = ?1").all(this.deps.ownerRealmId)
      .map(row => decode(row)!).filter(operation => operation.binding.nodeId === this.deps.nodeId && operation.desiredState === "running");
  }
  claimWorker(id: string): { operation: SlackSetupOperation; grant: IntegrationWorkerGrant } {
    return this.db.transaction(() => {
      const operation = this.row(id);
      if (operation.desiredState !== "running" || !operation.credentials) throw new IntegrationSetupError("worker_not_requested", "This installation is not requested to run.");
      this.assertBinding(operation);
      return { operation, grant: this.workers.claim(id) };
    })();
  }
  authorizeWorker(grant: IntegrationWorkerGrant): SlackSetupOperation {
    const operation = this.row(grant.operationId);
    if (operation.desiredState !== "running") throw new IntegrationSetupError("worker_not_requested", "This installation is not requested to run.");
    this.assertBinding(operation);
    this.workers.authorize(grant);
    return operation;
  }
  recordWorkerFailure(id: string, code: "worker_unavailable" | "worker_exited"): void {
    this.db.transaction(() => {
      const operation = this.row(id);
      if (operation.desiredState !== "running" || operation.workerError?.code === code) return;
      this.update(operation, { workerError: { code, at: this.now() } });
    })();
  }
  workerRequest(id: string, input: unknown): { expiresAt: number; generation: number } {
    const request = parse(z.object({ action: z.enum(["check", "heartbeat"]), generation: revision, token: z.string().min(1).max(256), connected: z.boolean().optional() }).strict(), input);
    const grant = { operationId: id, generation: request.generation, token: request.token, expiresAt: 0 };
    try {
      this.authorizeWorker(grant);
      const current = request.action === "heartbeat" ? this.heartbeatWorker(grant, request.connected === true) : this.workers.observe(id)!;
      return { expiresAt: current.expiresAt, generation: current.generation };
    } catch { throw new IntegrationSetupError("worker_revoked", "Worker authority is expired or revoked.", 403); }
  }
  heartbeatWorker(grant: IntegrationWorkerGrant, connected: boolean): IntegrationWorkerGrant {
    return this.db.transaction(() => {
      const operation = this.authorizeWorker(grant);
      if (connected && operation.workerError) this.update(operation, { workerError: undefined });
      return this.workers.renew(grant, connected);
    })();
  }

  private update(operation: SlackSetupOperation, patch: Partial<SlackSetupOperation>): SlackSetupOperation {
    const next = { ...operation, ...patch, revision: operation.revision + 1, updatedAt: this.now() };
    const result = this.db.query("UPDATE integration_setup_operations SET workspace_key = ?1, app_id = ?2, revision = ?3, record_json = ?4, scope_key = ?7 WHERE id = ?5 AND revision = ?6")
      .run(next.workspaceId ?? "", next.appId ?? null, next.revision, JSON.stringify(next), next.id, operation.revision, this.scope(next.binding)) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new IntegrationSetupError("revision_conflict", "Setup changed. Read its current status before continuing.");
    return next;
  }
}
