import { TaskClosedError, validateTaskAsk, validateTaskReply, SCOUT_TASKS_CAPABILITY } from "@openscout/protocol";
import { principalSchema } from "./identity.ts";
import { labelBrief, labelFeed, matchingLabelWorks } from "./label-views.ts";
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { diagnoseAgentIdentity, parseAgentIdentity, namedChannelNaturalKey, systemChannelNaturalKey, stableChannelId, parseScoutComposerRouteTarget, parseScoutRuntimeSpec, SCOUT_MCP_CORE_TOOL_NAMES, type McpEventPrincipal } from '@openscout/protocol';
import definitions from './core-tools.json';
import { RuntimeHttpClient } from './http-client.ts';

const tools = definitions as unknown as Tool[];
const validators = new AjvJsonSchemaValidator();
const values = (input: any): any[] => Array.isArray(input) ? input : Object.values(input ?? {});
const pick = (input: Record<string, any>, names: string[]) => Object.fromEntries(names.filter(k => input[k] !== undefined).map(k => [k, input[k]]));
function channelIdentity(name: string) {
  const normalized = name.trim().toLowerCase().replace(/^channel\./, '').replace(/[^a-z0-9_.-]+/g, '-');
  const channel = normalized === 'shared' ? 'broadcast' : normalized;
  const naturalKey = channel === 'system' ? systemChannelNaturalKey(channel) : namedChannelNaturalKey(channel);
  return { channel, naturalKey, id: stableChannelId(naturalKey) };
}
const query = (path: string, input: Record<string, any>) => {
  const q = new URLSearchParams(); for (const [k,v] of Object.entries(input)) if (v !== undefined && v !== null) {
    for (const item of Array.isArray(v) ? v : [v]) q.append(k, String(item));
  }
  return `${path}?${q}`;
};
export function selectCoreTools(selection: 'core' | readonly string[] = 'core'): Tool[] {
  const names = selection === 'core' ? [...SCOUT_MCP_CORE_TOOL_NAMES] : [...selection];
  const unsupported = names.filter(name => !SCOUT_MCP_CORE_TOOL_NAMES.includes(name as never));
  if (!names.length || unsupported.length) throw new Error(`unsupported bridge tools: ${unsupported.join(', ') || '(empty list)'}`);
  return [...new Set(names)].map(name => tools.find(t => t.name === name)!);
}
export class CoreHttpAdapter {
  readonly tools: Tool[];
  constructor(readonly options: { client: RuntimeHttpClient; principal: McpEventPrincipal; tools?: 'core' | readonly string[]; currentDirectory?: string; replyContext?: Record<string, unknown>; diagnosticsIdentityVerified?: boolean }) {
    this.tools = selectCoreTools(options.tools);
    principalSchema.parse(options.principal);
  }
  async call(name: string, input: unknown = {}, signal?: AbortSignal): Promise<any> {
    const tool = this.tools.find(t => t.name === name); if (!tool) throw new Error(`unsupported bridge tool: ${name}`);
    const checked = validators.getValidator<Record<string, any>>(tool.inputSchema as never)(input);
    if (!checked.valid) throw new Error(`invalid arguments for ${name}`);
    const a = { ...checked.data };const p = this.options.principal; const senderId = p.agentId;
    if (a.senderId !== undefined && a.senderId !== senderId) throw new Error('sender identity is pinned to the relay principal');
    const currentDirectory = a.currentDirectory ?? this.options.currentDirectory ?? '/';
    const request = (path: string, body?: unknown) => this.options.client.request(path, body, signal);
    const snapshot = () => request('/v1/snapshot');
    const context = { currentDirectory, brokerUrl: this.options.client.origin, senderId };
    if (name.startsWith('sessions_')) return request(`/v1/external-sessions/${name.slice(9)}`, { ...a, ownerId: senderId });
    if (name === 'whoami') return { ...context, defaultSenderId: senderId };
    if (name === 'current_reply_context') return { active: !!this.options.replyContext, context: this.options.replyContext ?? null };
    if (name === 'feedback_send') {
      // Provenance is constructor state from the authenticated envelope, never a tool argument.
      const saved = await request('/v1/mesh/bridge/feedback/collect', { message: a.note, diagnostics: a.diagnostics === true && this.options.diagnosticsIdentityVerified !== false, principal: p });
      if (a.localOnly) return saved;
      try { return { ...saved, ...await request('/v1/mesh/bridge/feedback/upload', { id: saved.id, principal: p }) }; }
      catch { return saved; } // A failed upload never switches to local-operator provenance.
    }
    if (name === 'tail_events') return { ...context, ...await request(query('/v1/tail/recent', { limit: a.limit ?? 80, ...pick(a, ['sources','kinds','sessionId','project','cwd','query']), transcripts: a.transcripts ? '1' : '0' })) };
    if (name === 'broker_feed') return { ...context, ...await request(query('/v1/broker/messages', { agentId: a.agentId ?? senderId, ...pick(a,['since','limit']), includeAcknowledged: a.includeAcknowledged ? '1' : undefined })) };
    if (name === 'messages_inbox' || name === 'messages_channel') {
      const filter = name === 'messages_inbox' ? { participantId: senderId, inboxOnly: '1' } : { conversationId: channelIdentity(a.channel ?? 'shared').id };
      const messages = await request(query('/v1/messages', { ...filter, limit: a.limit ?? 20, since: a.since }));
      return { ...context, ...filter, limit: a.limit ?? 20, since: a.since ?? null, messages };
    }
    if (name === 'agents_search' || name === 'agents_resolve') {
      const s = await snapshot();const agents = values(s.agents).map(agent => ({ ...agent, agentId: agent.id }));
      const term = String(a.query ?? a.label ?? '').trim().replace(/^@/, '').toLowerCase();
      let candidates = agents.filter(v => [v.id,v.name,v.label,v.displayName,v.handle,v.selector].some(s => typeof s === 'string' && (name === 'agents_resolve' ? s.replace(/^@/,'').toLowerCase() === term : s.toLowerCase().includes(term))));
      let kind = candidates.length === 1 ? 'resolved' : candidates.length ? 'ambiguous' : 'unresolved';
      if (name === 'agents_resolve') {
        const identity = parseAgentIdentity(a.label);
        if (identity) {
          const identities = agents.map(agent => ({ ...agent, agentId: agent.id, definitionId: agent.definitionId ?? agent.id,
            aliases: [agent.name,agent.displayName,agent.selector,agent.handle].filter(Boolean),
            profile: agent.metadata?.profile ?? agent.profile, model: agent.metadata?.model ?? agent.model, harness: agent.metadata?.harness ?? agent.harness }));
          const diagnosis = diagnoseAgentIdentity(identity, identities);
          if (diagnosis.kind === 'resolved') { candidates = [diagnosis.match];kind = 'resolved'; }
          else if (diagnosis.kind === 'ambiguous') { candidates = diagnosis.candidates;kind = 'ambiguous'; }
        }
      }
      candidates = candidates.slice(0, a.limit ?? 50);
      return name === 'agents_search' ? { ...context, query: term, candidates } : { ...context, label: a.label, kind, candidate: kind === 'resolved' ? candidates[0] : null, candidates };
    }

    if (name === 'invocations_get' || name === 'invocations_wait') {
      const deadline = Date.now() + (name === 'invocations_wait' ? (a.timeoutSeconds ?? 30) * 1000 : 0);
      let flight: any, lifecycle: any;
      do {
        const s = await snapshot();flight = values(s.flights).find(v => v.id === a.flightId);
        if (!flight || ['completed','failed','cancelled'].includes(flight.state) || Date.now() >= deadline) break;
        await delay(Math.min(500, deadline - Date.now()), undefined, { signal });
      } while (true);
      if (flight?.invocationId) lifecycle = await request(`/v1/invocations/${encodeURIComponent(flight.invocationId)}/lifecycle`);
      return { ...context, flightId: a.flightId, found: !!flight, flight: flight ?? null, lifecycle: lifecycle ?? null, waitStatus: name === 'invocations_get' ? 'not_requested' : flight && ['completed','failed','cancelled'].includes(flight.state) ? 'completed' : 'timed_out' };
    }
    if (name === 'labels_brief' || name === 'labels_feed') {
      const s = await snapshot();
      if (name === 'labels_brief') return { ...context, ...labelBrief(s,a.label) };
      const ids = matchingLabelWorks(s,a.label).map(v => v.id).slice(0,128);
      const events = [];
      for (const recordId of ids) events.push(...values(await request(query('/v1/collaboration/events', { recordId, limit: a.limit ?? 100 }))));
      return { ...context, ...labelFeed(s,a.label,events,a.since,a.limit) };
    }

    if (name === 'work_update') {
      const s = await snapshot();const previous = values(s.collaborationRecords).find(v => v.kind === 'work_item' && v.id === a.work.workId);
      if (!previous) throw new Error('unknown work item');
      const now = Date.now(), state = a.work.state ?? previous.state;
      const updated = { ...previous, waitingOn: a.work.waitingOn === undefined ? state === 'waiting' ? previous.waitingOn : undefined : a.work.waitingOn, ...pick(a.work, ['title','summary','state','acceptanceState','ownerId','nextMoveOwnerId','priority','labels','waitingOn','progress']), updatedAt: now,
        metadata: { ...previous.metadata, ...a.work.metadata }, ...(state === 'working' ? { startedAt: previous.startedAt ?? now } : {}),
        ...(state === 'review' ? { reviewRequestedAt: previous.reviewRequestedAt ?? now } : {}),
        ...(['done','cancelled'].includes(state) ? { completedAt: previous.completedAt ?? now } : {}) };
      await request('/v1/collaboration/records', updated);
      await request('/v1/collaboration/events', { id: `evt.${randomUUID()}`, recordId: updated.id, recordKind: 'work_item', kind: updated.acceptanceState !== previous.acceptanceState && ['accepted','reopened'].includes(updated.acceptanceState) ? updated.acceptanceState : state !== previous.state ? ({ waiting: 'waiting', review: 'review_requested', done: 'done', cancelled: 'cancelled', working: previous.state === 'open' ? 'claimed' : 'progressed' } as Record<string,string>)[state] ?? 'progressed' : updated.ownerId !== previous.ownerId || updated.nextMoveOwnerId !== previous.nextMoveOwnerId ? 'handoff' : 'progressed', actorId: senderId, at: now, summary: a.work.eventSummary ?? updated.summary ?? updated.title, metadata: { source: 'scout-mesh-http' } });
      return { ...context, usedBroker: true, workItem: updated, workId: updated.id };
    }
    if (name === 'reply') {
      validateTaskReply(a);
      if (a.sessionId || a.deliveryId || a.replyToken) {
        if (!a.ref || !a.sessionId || !a.deliveryId || a.image)
          throw new Error('external reply requires its exact task and correlated return address');
        return request('/v1/external-sessions/reply', { ...pick(a, ['sessionId','deliveryId','replyToken','body','ref','progress','failed','attachments']), requestId: a.requestId ?? `external-${createHash("sha256").update(JSON.stringify([a.deliveryId, a.progress ? ["progress", a.body] : ["final"]])).digest("hex")}`, ownerId: senderId });
      }
      const node = await request('/v1/node');
      if (!node.capabilities?.includes(SCOUT_TASKS_CAPABILITY)) throw new Error(`runtime requires ${SCOUT_TASKS_CAPABILITY}`);
      if (a.image) throw new Error('image paths are host-local; submit inline evidence through a local Scout client');
      return request('/v1/messages/reply', { ...pick(a, ['ref','to','progress','failed','body','attachments']),
        requestId: a.requestId ?? `reply-${randomUUID()}`, senderId });
    }
    if (name === 'ask') {
      const isAsk = !a.fyi, operator = a.operator === true;
      const task = { version: 1, ...pick(a, ['operator','ref','continue','cancel','fyi','notify','defaultAction','options','permission','because','window']) } as import('@openscout/protocol').ScoutTaskAsk;
      validateTaskAsk(task, { to: a.to ?? a.targetSessionId, channel: a.channel, capability: !a.continue && Boolean(a.projectPath || a.profile),
        execution: Boolean(a.harness || a.model || a.reasoningEffort || a.on || a.runtime || a.placement || a.projectPath), relation: Boolean(a.relation) });
      const node = await request('/v1/node');
      if (!node.capabilities?.includes(SCOUT_TASKS_CAPABILITY)) throw new Error(`runtime requires ${SCOUT_TASKS_CAPABILITY}`);
      if (a.image) throw new Error('image paths are host-local; submit inline evidence through a local Scout client');
      a.requestId ??= `ask-${randomUUID()}`;
      if (a.profile && !a.projectPath) { if (!this.options.currentDirectory || this.options.currentDirectory === '/') throw new Error('profile requires an explicit projectPath');a.projectPath = this.options.currentDirectory; }
      if (a.on && !a.continue && (!a.projectPath || a.to || a.targetSessionId || a.profile)) throw new Error('on requires projectPath and cannot combine with an exact target or profile');
      if (a.continue && (a.on || a.projectPath)) task.successor = { host: a.on, projectPath: a.projectPath };
      let target = a.ref || a.continue ? { kind: 'binding_ref', ref: a.ref ?? a.continue } : operator ? { kind: 'agent_id', agentId: 'operator' } : a.targetAgentId ? { kind: 'agent_id', agentId: a.targetAgentId }
        : a.targetSessionId ? { kind: 'session_id', sessionId: a.targetSessionId }
        : a.projectPath ? { kind: 'project_path', projectPath: a.projectPath, ...(a.on ? { host: a.on } : {}) }
        : parseScoutComposerRouteTarget(a.to ?? a.targetLabel ?? (a.channel ? `channel:${a.channel}` : ''));
      if (a.profile && a.projectPath) target = { kind: 'runtime_profile', profile: a.profile, projectPath: a.projectPath };
      if (!target) throw new Error('one explicit target or project is required');
      if ((a.completion || a.relation) && (!a.requestId || !['agent_id','session_id'].includes(target.kind))) throw new Error('completion requires requestId and an exact target');
      let execution = pick(a,['harness','model','reasoningEffort','placement']);
      if (a.runtime) {
        const spec = parseScoutRuntimeSpec(a.runtime);if (!spec.ok) throw new Error('invalid runtime specification');
        for (const [key,value] of Object.entries(spec.value)) if (execution[key] !== undefined && execution[key] !== value) throw new Error(`conflicting runtime field ${key}`);
        execution = { ...spec.value, ...execution };
      }
      if (target.kind === 'session_id') a.targetSessionId = target.sessionId;
      const body = a.body;
      if (target.kind === 'route_alias' && (a.aliasProject || a.aliasHost)) target = { ...target, scope: { ...(a.aliasProject ? { projectRoot: a.aliasProject } : {}), ...(a.aliasHost ? { authorityNodeId: a.aliasHost } : {}) } } as typeof target;
      const intent = 'task_ask';
      const workRecordId = a.workItem ? a.requestId ? `work-request-${createHash('sha256').update(JSON.stringify([senderId,a.requestId])).digest('hex')}` : `work.${randomUUID()}` : undefined;
      const metadata = { source: 'scout-mesh-http', ...(a.workspace ? { askWorkspace: a.workspace } : {}),
        ...(workRecordId ? { collaborationRecordId: workRecordId, workId: workRecordId } : {}),
        ...(a.labels ? { labels: a.labels } : {}), ...(a.replyToSessionId ? { replyToSessionId: a.replyToSessionId } : {}),
        replyMode: a.wait ? 'inline' : a.replyMode ?? 'notify', senderContext: { agentId: senderId, cwd: currentDirectory } };
      const result = await request('/v1/deliver', { caller: { actorId: senderId, currentDirectory, metadata: { source: 'scout-mesh-http' } }, target, body, intent, task,
        ...pick(a,['requestId','completion','relation','targetSessionId','replyToSessionId','labels','channel']),
        ...(isAsk && !a.ref && !operator ? { execution: { ...execution, session: a.targetSessionId ? 'existing' : 'new' } } : {}), ...(operator ? {} : { ensureAwake: isAsk || a.wake === true }), ...(a.shouldSpeak ? { speechText: body } : {}),
        ...(a.workItem ? { collaborationRecordId: workRecordId, workItem: { id: workRecordId, ...a.workItem } } : {}),
        messageMetadata: isAsk ? metadata : { source: 'scout-mesh-http' }, ...(isAsk ? { invocationMetadata: metadata } : {}),
      });
      const flightId = result.flight?.id ?? result.flightId;
      const inline = isAsk && (a.wait || a.replyMode === 'inline') && flightId ? await this.call('invocations_wait', { flightId, timeoutSeconds: a.timeoutSeconds ?? 30 }, signal) : undefined;
      return { ...context, ...result, ...(inline ? { flight: inline.flight, waitStatus: inline.waitStatus } : {}), flightId,
        ids: { flightId, invocationId: result.flight?.invocationId ?? result.invocationId, messageId: result.message?.id ?? result.messageId, conversationId: result.conversation?.id ?? result.conversationId }, usedBroker: true };
    }
    throw new Error(`unsupported bridge tool: ${name}`);
  }
  server() {
    const server = new Server({ name: 'scout-mesh', version: '0.3.9' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try { const result = await this.call(request.params.name, request.params.arguments, extra.signal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result } }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof TaskClosedError
        ? error.message : `Scout tool ${request.params.name} failed; check arguments, consent and runtime availability.` }] }; }
    });
    return server;
  }
}
