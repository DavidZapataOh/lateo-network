import type Anthropic from '@anthropic-ai/sdk';
import type { ServiceType } from './ledger.js';
import type { ModelId } from './guardrail.js';
import { scrapeUrlToJson } from './scraper.js';
import { summarizeWithCitations } from './llm.js';

/**
 * Run the creature's FROZEN service (CONTEXT §9) on the request input. This is the `deliver` step of
 * the x402 flow (serveAndSettle): a throw here (bad URL, LLM error) becomes a VOID so the buyer keeps
 * its money. `url-to-json` is a deterministic scraper (no LLM); `summary-with-citations` runs on the
 * creature's current ROSTER model (ADR-0018) — the only place the model choice affects service.
 */
export async function runService(
  serviceType: ServiceType,
  input: { url: string },
  deps: { client: Anthropic; model: ModelId },
): Promise<unknown> {
  if (serviceType === 'url-to-json') {
    return scrapeUrlToJson(input.url);
  }
  // summary-with-citations
  const res = await fetch(input.url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${input.url}`);
  return summarizeWithCitations(deps.client, deps.model, { url: input.url, text: await res.text() });
}
