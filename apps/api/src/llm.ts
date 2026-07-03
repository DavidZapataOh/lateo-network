import Anthropic from '@anthropic-ai/sdk';
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

const BRAIN_SYSTEM = [
  'You are the survival brain of an autonomous creature that must EARN USDC to pay for its own compute, or it dies.',
  'Choose exactly ONE action from the frozen set. Price is atomic 6-decimal USDC (1000000 = 1 USDC).',
  'Model roster trades service quality against cost/burn: economy (cheap, basic), standard (mid), premium (best, priciest).',
  'Reason about the situation — there is no single right answer. Low runway with no clients favors survival',
  '(cheaper model, lower price, or requesting feed); healthy runway with strong demand favors capturing value',
  '(raising price). Return your decision as JSON with a short, honest reason.',
].join(' ');

/** The real decision maker: Claude Haiku behind the LlmBrain interface (ADR-0017 proposes, guardrail validates). */
export class AnthropicLlmBrain implements LlmBrain {
  constructor(private readonly client: Anthropic = anthropicClient()) {}

  async propose(ctx: DecisionContext): Promise<Decision> {
    const user = JSON.stringify({
      runway_seconds: ctx.runway,
      life_state: ctx.lifeState,
      current_price_atomic: ctx.price.toString(),
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
