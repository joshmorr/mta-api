import { McpServer } from '@modelcontextprotocol/server';
import { registerMtaTools } from './tools';

export const MCP_SERVER_INFO = {
  name: 'mta-mcp-server',
  version: '1.0.0',
  title: 'MTA transit data',
} as const;

/**
 * Build a server instance with every tool registered.
 *
 * Passed as the factory to both transports rather than shared as a singleton:
 * `createMcpHandler` builds one instance per request in its stateless mode, and
 * `serveStdio` pins one per connection. Tools hold no state of their own — the
 * SQLite handle and the realtime cache are module-level and shared regardless.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { capabilities: { tools: {} } });
  registerMtaTools(server);
  return server;
}
