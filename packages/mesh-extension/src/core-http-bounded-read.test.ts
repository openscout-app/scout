import { expect, test } from 'bun:test';
import { CoreHttpAdapter } from './core-http-mcp.ts';
import { RuntimeHttpClient, RuntimeHttpError } from './http-client.ts';

const principal = { kind: 'agent_token' as const, id: 'token', ownerKey: 'owner', node: 'entry', agentId: 'sender' };

test('discovery excludes large history, exposes bounded machine compatibility, and reports incomplete coverage', async () => {
  const paths: string[] = [];
  const client = new RuntimeHttpClient({ brokerUrl: 'http://localhost', fetch: (async (input: any) => {
    const url = new URL(input); paths.push(url.pathname + url.search);
    if (url.pathname === '/v1/mesh/nodes') return Response.json({
      first: { id: 'peer-current', name: 'Current peer', capabilities: ['ask-reply/1'], lastSeenAt: 100, privateField: 'do-not-return' },
      second: { id: 'peer-older', name: 'Older peer', capabilities: [], lastSeenAt: 50 },
    });
    if (url.searchParams.get('scope') === 'agents') return Response.json({ agents: { a: { id: 'a' }, b: { id: 'b' } } });
    return Response.json({ agents: {}, history: 'x'.repeat(9 * 1024 * 1024) });
  }) as typeof fetch });
  const adapter = new CoreHttpAdapter({ client, principal });
  const result = await adapter.call('agents_search', { limit: 1 });
  expect(paths.sort()).toEqual(['/v1/mesh/nodes', '/v1/snapshot?scope=agents']);
  expect(result.candidates).toHaveLength(1);
  expect(result.machines).toEqual([{ nodeId: 'peer-current', name: 'Current peer', lastSeenAt: 100, supportsTasks: true }]);
  expect(result.coverage).toMatchObject({ liveReachabilityChecked: false, candidatesTotal: 2, candidatesTruncated: true, machinesTotal: 2, machinesTruncated: true });
  expect(JSON.stringify(result)).not.toContain('do-not-return');
  paths.length = 0;
  expect((await adapter.call('agents_resolve', { label: 'b' })).candidate.agentId).toBe('b');
  expect(paths).toEqual(['/v1/snapshot?scope=agents']);
});

test('task polling uses exact flight reads and returns the terminal reply without a full snapshot', async () => {
  const paths: string[] = [];
  let reads = 0;
  const client = new RuntimeHttpClient({ brokerUrl: 'http://localhost', fetch: (async (input: any) => {
    const path = new URL(input).pathname; paths.push(path);
    if (path === '/v1/flights/task%2Fone') return Response.json({ flight: { id: 'task/one', invocationId: 'invocation', state: ++reads > 1 ? 'completed' : 'running', output: reads > 1 ? 'PONG fixture' : null } });
    if (path === '/v1/invocations/invocation/lifecycle') return Response.json({ state: 'completed' });
    return Response.json({ history: 'x'.repeat(9 * 1024 * 1024) });
  }) as typeof fetch });
  const result = await new CoreHttpAdapter({ client, principal }).call('invocations_wait', { flightId: 'task/one', timeoutSeconds: 2 });
  expect(result).toMatchObject({ found: true, terminal: true, output: 'PONG fixture', waitStatus: 'completed' });
  expect(paths).toEqual(['/v1/flights/task%2Fone', '/v1/flights/task%2Fone', '/v1/invocations/invocation/lifecycle']);
});

test('only an exact-read 404 is absence; unavailable state fails without exposing response details', async () => {
  let status = 404;
  const client = new RuntimeHttpClient({ brokerUrl: 'http://localhost', fetch: (async () => Response.json({ detail: 'private-runtime-detail' }, { status })) as typeof fetch });
  const adapter = new CoreHttpAdapter({ client, principal });
  expect(await adapter.call('invocations_get', { flightId: 'missing' })).toMatchObject({ found: false, terminal: false, flight: null });
  status = 503;
  try { await adapter.call('invocations_get', { flightId: 'missing' }); throw new Error('expected refusal'); }
  catch (error) { expect(error).toBeInstanceOf(RuntimeHttpError); expect((error as RuntimeHttpError).status).toBe(503); expect(String(error)).not.toContain('private-runtime-detail'); }
});
