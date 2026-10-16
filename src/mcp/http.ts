import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildMcpServer } from './server';
import { log } from '../utils/logger';

/**
 * Turn away a JSON-RPC batch before it reaches the SDK.
 *
 * The rate limiter counts HTTP requests, and the SDK runs up to 100 messages
 * from one batched POST — so a batch would turn the /mcp ceiling into 100x as
 * many tool calls. MCP dropped batching in the 2025-06-18 spec revision, so no
 * current client sends one; refusing it keeps one request to one tool call.
 *
 * Returns null for anything that is not a batch, including a body that is not
 * JSON at all — the SDK answers that with its own parse error.
 */
export async function rejectBatch(req: Request): Promise<Response | null> {
  if (req.method !== 'POST') return null;

  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;

  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid Request: batched JSON-RPC is not supported; send one message per request',
      },
    },
    { status: 400 },
  );
}

/**
 * The HTTP transport's handler: the SDK's stateless streamable-HTTP face, with
 * batches refused in front of it. Shared by `POST /mcp` and the test client so
 * tests exercise the same path the server mounts.
 */
export function createMcpHttpHandler() {
  const handler = createMcpHandler(buildMcpServer, {
    onerror: (err) => log.error({ err, transport: 'http' }, 'mcp error'),
  });

  return {
    fetch: async (req: Request): Promise<Response> => (await rejectBatch(req)) ?? handler.fetch(req),
    close: () => handler.close(),
  };
}
