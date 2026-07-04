import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Account } from 'viem';
import { buyService } from './buyer.js';

/**
 * The MINIMAL MCP (ADR-0009): exactly two tools — `discover` + `buy` — so an EXTERNAL agent can find
 * a creature and pay it. This is the Lepton-thesis interface (agents paying agents). Deliberately not
 * extended (no catalog, no complex auth, no streaming) — minimal is what separates a toy from a real
 * economy.
 */
export function createMcpServer(deps: { base: string; agentWallet: Account }): McpServer {
  const server = new McpServer({ name: 'lateo', version: '0.1.0' });

  server.registerTool(
    'discover',
    { description: 'List creatures for sale (id, service, price, state) — a proxy of the registry.', inputSchema: {} },
    async () => {
      const res = await fetch(`${deps.base}/creatures`);
      return { content: [{ type: 'text' as const, text: await res.text() }] };
    },
  );

  server.registerTool(
    'buy',
    {
      description: "Pay a creature for its service. Signs an x402 payment from the calling agent's own wallet.",
      inputSchema: { creatureId: z.string(), url: z.string() },
    },
    async ({ creatureId, url }) => {
      const r = await buyService(deps.base, creatureId, { url }, deps.agentWallet);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
    },
  );

  return server;
}
