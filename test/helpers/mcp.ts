import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildMcpServer } from '../../src/mcp/server';

export type JsonRpcResult = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type ToolDescriptor = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, boolean>;
};

export interface McpTestClient {
  rpc(method: string, params?: Record<string, unknown>): Promise<JsonRpcResult>;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/**
 * A JSON-RPC client over an MCP handler, exercising the same path the mounted
 * `POST /mcp` endpoint serves.
 *
 * One handler per test file, closed in that file's `afterAll` — bun runs every
 * file in one process, so a shared handler would be closed out from under the
 * files that had not finished yet.
 *
 * No `initialize` handshake is needed: the handler's stateless mode answers
 * each request from a fresh server instance. Replies come back as a
 * single-event SSE stream, so the `data:` payload is unwrapped here.
 */
export function makeMcpClient(): McpTestClient {
  const handler = createMcpHandler(buildMcpServer);

  async function rpc(method: string, params?: Record<string, unknown>): Promise<JsonRpcResult> {
    const res = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
      }),
    );

    const body = await res.text();
    const data = body
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice('data:'.length)
      .trim();

    if (!data) throw new Error(`No JSON-RPC payload in response (${res.status}): ${body.slice(0, 200)}`);
    return JSON.parse(data) as JsonRpcResult;
  }

  return {
    rpc,
    async listTools() {
      const { result } = await rpc('tools/list');
      return (result?.tools ?? []) as ToolDescriptor[];
    },
    async callTool(name, args = {}) {
      const { result, error } = await rpc('tools/call', { name, arguments: args });
      if (error) throw new Error(`${name} failed at the protocol level: ${error.message}`);
      return result as unknown as ToolResult;
    },
    close: () => handler.close(),
  };
}

/** The text of a tool result, which for an error result is the message. */
export function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join('\n');
}
