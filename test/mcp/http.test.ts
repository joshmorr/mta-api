import { afterAll, describe, expect, it } from 'bun:test';
import { createMcpHttpHandler, rejectBatch } from '../../src/mcp/http';

const handler = createMcpHttpHandler();
afterAll(() => handler.close());

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function post(body: string): Request {
  return new Request('http://localhost/mcp', { method: 'POST', headers, body });
}

function toolCall(id: number) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'mta_list_routes', arguments: {} } };
}

describe('MCP HTTP transport', () => {
  it('refuses a JSON-RPC batch without running any of its tool calls', async () => {
    const res = await handler.fetch(post(JSON.stringify([toolCall(1), toolCall(2), toolCall(3)])));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { id: unknown; error: { code: number; message: string } };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain('batched');
  });

  it('refuses a batch of one, since it is still a batch', async () => {
    const res = await handler.fetch(post(JSON.stringify([toolCall(1)])));
    expect(res.status).toBe(400);
  });

  it('still answers a single tool call', async () => {
    const res = await handler.fetch(post(JSON.stringify(toolCall(1))));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"result"');
  });

  it('leaves a malformed body to the SDK, which reports a parse error', async () => {
    const res = await handler.fetch(post('{not json'));
    expect(await res.text()).toContain('-32700');
  });

  it('does not read the body of a non-POST request', async () => {
    expect(await rejectBatch(new Request('http://localhost/mcp', { method: 'GET' }))).toBeNull();
  });
});
