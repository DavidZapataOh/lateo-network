// The PUBLIC MCP entry (stdio): a third party runs this with THEIR OWN key, so the payer is their
// wallet — never ours (anti-wash by construction: a payment through here is external by provenance
// unless their wallet traces to the treasury). Configure in Claude Desktop / Claude Code:
//
//   { "mcpServers": { "lateo": {
//       "command": "npx", "args": ["tsx", "<repo>/apps/api/src/mcp-main.ts"],
//       "env": { "AGENT_PRIVATE_KEY": "0x<your key>", "LATEO_BASE": "https://<lateo host>" } } } }
//
// Tools: `discover` (list creatures for sale) + `buy` (pay one with x402 from YOUR wallet).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createMcpServer } from './mcp.js';

const key = process.env.AGENT_PRIVATE_KEY;
const base = process.env.LATEO_BASE;
if (!key || !base) {
  console.error('Set AGENT_PRIVATE_KEY (your wallet) and LATEO_BASE (the LATEO API url).');
  process.exit(1);
}
const wallet = privateKeyToAccount(key as `0x${string}`);
console.error(`[lateo-mcp] agent wallet ${wallet.address} -> ${base}`);
const server = createMcpServer({ base, agentWallet: wallet });
await server.connect(new StdioServerTransport());
