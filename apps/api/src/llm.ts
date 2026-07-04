import Anthropic from '@anthropic-ai/sdk';
import { atomicToUsdc, type Atomic } from './money.js';
import type { LlmBrain, Decision, DecisionContext } from './decide.js';
import type { BrainAction, ModelId } from './guardrail.js';

// ADR-0018 ISOLATION: this is the ONLY file that names the provider. The brain/service logic talks
// to the LlmBrain / summarize interfaces and never learns it is Claude — a provider swap is local.

/** The BRAIN runs on a cheap-and-sufficient model (survival reasoning is a simple, frequent task). */
export const BRAIN_MODEL = 'claude-haiku-4-5';

/** The SERVICE roster the creature chooses among via set_model — a real cost+quality spread. */
export const ROSTER: Record<ModelId, string> = {
  economy: 'claude-haiku-4-5',
  standard: 'claude-sonnet-5',
  premium: 'claude-opus-4-8',
};

/** Reads ANTHROPIC_API_KEY from the environment (loaded from .env.local by scripts/tests). */
export function anthropicClient(): Anthropic {
  return new Anthropic();
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['hold', 'set_price', 'set_model', 'request_feed'] },
    price: { type: 'integer' }, // atomic 6-dec USDC, when action = set_price
    model: { type: 'string', enum: ['economy', 'standard', 'premium'] }, // when action = set_model
    reason: { type: 'string' },
  },
  required: ['action', 'reason'],
  additionalProperties: false,
} as const;

interface RawDecision {
  action: string;
  price?: number;
  model?: string;
  reason: string;
}

function toAction(d: RawDecision): BrainAction {
  switch (d.action) {
    case 'set_price':
      return { kind: 'set_price', price: BigInt(d.price ?? 0) };
    case 'set_model':
      return { kind: 'set_model', model: (d.model ?? 'economy') as ModelId };
    case 'request_feed':
      return { kind: 'request_feed' };
    default:
      return { kind: 'hold' };
  }
}

function firstJson<T>(resp: Anthropic.Message): T {
  const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block) throw new Error('LLM returned no text block');
  return JSON.parse(block.text) as T;
}

// The prompt INFORMS the decision space (what actions exist, when they are relevant, the numeric
// scale) but NEVER dictates a threshold->action rule — that strategy is the LLM's to choose, or the
// ablation is meaningless (ADR-0017). "Cheaper = smaller number" fixes the atomic-scale confusion.
const BRAIN_SYSTEM = [
  'You are the survival brain of an autonomous creature. It EARNS USDC by selling a service to clients,',
  'and must earn enough to pay for its own compute or it dies. You choose exactly ONE action per turn.',
  '',
  'MONEY IS IN ATOMIC UNITS: 1000000 atomic = 1.00 USDC. You are given the current price and the legal',
  'price range in BOTH atomic and USDC — reason in those exact numbers. A LOWER price is a SMALLER atomic',
  'number; a HIGHER price is a LARGER atomic number.',
  '',
  'Your action space (frozen):',
  '- set_price(price): set your service price, within the legal [min,max]. Lowering it may attract more',
  '  clients; raising it captures more USDC per client.',
  '- set_model(economy|standard|premium): a cheaper model BURNS LESS USDC (extends your runway) at some',
  '  cost to service quality; a pricier model burns more for higher quality.',
  '- request_feed: ask a patron for a survival top-up (a lifeline, not earned income).',
  '- hold: change nothing this turn.',
  '',
  'Your situation gives your runway (seconds of life left), whether clients are arriving, and your current',
  'price and model. When runway is critical you are near death — your survival options include requesting',
  'feed, switching to a cheaper model, or cutting price to draw clients; evaluate which, if any, actually',
  'helps given whether clients are present and where your price already is. When runway is healthy and demand',
  'is strong, capturing more value (raising price) may be worth it. There is no single right answer — reason',
  'about YOUR specific situation and pick ONE action. Your action MUST be consistent with your reason: if your',
  'reason says cut the price, the price number must go DOWN; if it says raise, it must go UP.',
].join('\n');

/** The real decision maker: Claude Haiku behind the LlmBrain interface (ADR-0017 proposes, guardrail validates). */
export class AnthropicLlmBrain implements LlmBrain {
  private readonly client: Anthropic;
  private readonly bounds: { minPrice: Atomic; maxPrice: Atomic };

  constructor(
    client: Anthropic = anthropicClient(),
    bounds: { minPrice: Atomic; maxPrice: Atomic } = { minPrice: 1000n, maxPrice: 1_000_000n },
  ) {
    this.client = client;
    this.bounds = bounds;
  }

  async propose(ctx: DecisionContext): Promise<Decision> {
    const user = JSON.stringify({
      runway_seconds: ctx.runway,
      life_state: ctx.lifeState,
      current_price: { atomic: ctx.price.toString(), usdc: atomicToUsdc(ctx.price) },
      legal_price_range: {
        min: { atomic: this.bounds.minPrice.toString(), usdc: atomicToUsdc(this.bounds.minPrice) },
        max: { atomic: this.bounds.maxPrice.toString(), usdc: atomicToUsdc(this.bounds.maxPrice) },
      },
      current_model: ctx.model,
      recent_clients: ctx.recentClients,
    });
    const resp = await this.client.messages.create({
      model: BRAIN_MODEL,
      max_tokens: 512,
      system: BRAIN_SYSTEM,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: DECISION_SCHEMA } },
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);
    const raw = firstJson<RawDecision>(resp);
    return { action: toAction(raw), reason: raw.reason };
  }
}

export interface Citation {
  marker: string; // e.g. "[1]"
  quote: string; // a passage lifted from the page
}
export interface SummaryResult {
  summary: string;
  citations: Citation[];
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { marker: { type: 'string' }, quote: { type: 'string' } },
        required: ['marker', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'citations'],
  additionalProperties: false,
} as const;

/**
 * The `summary-with-citations` service (CONTEXT §9): summarize a page with >=2 cited passages.
 * Runs on the creature's chosen roster model (ADR-0018) — the model choice is where service quality
 * lives (to be verified vs cost in C1; url-to-json has no LLM, so its model choice is cost-only).
 */
export async function summarizeWithCitations(
  client: Anthropic,
  model: ModelId,
  page: { url: string; text: string },
): Promise<SummaryResult> {
  const resp = await client.messages.create({
    model: ROSTER[model],
    max_tokens: 1024,
    system:
      'Summarize the page for a reader who has not seen it. Include at least two citations, each a short ' +
      'verbatim quote from the page with a [n] marker referenced in the summary. Return JSON.',
    messages: [{ role: 'user', content: `URL: ${page.url}\n\n${page.text}` }],
    output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  return firstJson<SummaryResult>(resp);
}
