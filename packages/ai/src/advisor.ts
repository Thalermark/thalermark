import { generateObject } from 'ai';
import { z } from 'zod';
import { businessPersona } from './persona.js';
import { type LlmCredential, resolveModel } from './provider.js';
import type { CashFlowAdvisor, CashFlowNudge, CashFlowSignals } from './types.js';

// Bump whenever the prompt or the CashFlowSignals shape changes. The API folds
// this into the nudge cache key so a logic change regenerates cached nudges
// instead of serving stale text (the signals hash alone wouldn't change).
//
// Note that signals now carries businessType, so an entity-type change
// invalidates a company's cached nudge on its own. That is a property of the
// hashed struct, not a substitute for this constant: a prompt-only edit changes
// no hash, and a refactor that made the key conditional would silently restore
// old hashes for null companies. This is the only lever that always works.
//
// '4' (TMC-171): the sole_prop persona was reworded. A pure copy edit like that
// is exactly the case the paragraph above describes — the signals are byte-for-
// byte identical, so nothing else would have regenerated a single cached nudge.
export const CASH_FLOW_NUDGE_VERSION = '4';

// Cash-flow nudges use the 'reasoning' role (Sonnet on Anthropic; a capable
// local model on Ollama) — it's interpretation + prioritisation, where the
// bigger model earns its keep. The API computes every number; this prompt is
// strict that the model must quote them, never compute.
const schema = z.object({
  nudges: z
    .array(
      z.object({
        text: z.string().describe('One short, plain-English sentence'),
        tone: z.enum(['good', 'warning', 'info']),
      }),
    )
    .max(3),
});

function money(s: string): string {
  // Pre-format for the prompt so the model quotes "$812.50" verbatim rather
  // than reformatting (and risking a transcription slip).
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : s;
}

function buildPrompt(s: CashFlowSignals): string {
  const months =
    s.trailingMonths.length > 0
      ? s.trailingMonths
          .map((m) => `  ${m.month}: in ${money(m.moneyIn)}, out ${money(m.moneyOut)}`)
          .join('\n')
      : '  (no prior months on record yet)';
  return [
    `You are a plain-English money assistant for ${businessPersona(s.businessType)}.`,
    'Write 1-3 short cash-flow nudges, each a single friendly sentence. Prefer one or two specific, grounded nudges over three vague ones — generic encouragement with no number is not useful.',
    'Rules:',
    '- GROUND every nudge in a specific figure below: name the actual dollar amount you are referring to (e.g. "You\'ve spent $4,074.99 this month" or "You have $800 on hand"). A nudge with no concrete number is not allowed.',
    '- Use ONLY the figures below. Never compute, estimate, or invent a number; quote the dollar amounts exactly as given.',
    '- NEVER contradict the figures. If "money out this month" is more than $0, there ARE transactions this month — do not say otherwise. If cash on hand is negative, say money is tight, not that there is nothing happening.',
    '- These are observations and gentle prompts, NOT financial, tax, or investment advice.',
    '- How the business is set up is context for TONE ONLY. Never comment on entity structure, owner pay, distributions, payroll, retained earnings, or taxes.',
    '- Address the reader directly as "you", whatever the business setup. Never write about them in the third person.',
    '- If there is genuinely too little data to say anything specific, return fewer nudges, or none.',
    '- tone: pick per nudge. "warning" when money is tight (cash on hand low or negative, money out exceeding money in, invoices overdue); "good" when things look healthy (cash positive, income up); "info" for a neutral observation. Do not default everything to "info".',
    '',
    `As of ${s.asOf}:`,
    `- Cash on hand: ${money(s.cashOnHand)}`,
    `- This month so far: money in ${money(s.monthToDate.moneyIn)}, money out ${money(s.monthToDate.moneyOut)}`,
    `- Owed to you by customers (unpaid invoices): ${money(s.owed)}${
      s.overdueCount > 0 ? ` — ${s.overdueCount} past due` : ''
    }`,
    'Recent full months (money in / money out):',
    months,
  ].join('\n');
}

// Build a cash-flow advisor. Stateless: the reasoning model is resolved per
// call from the credential the api passes, so one process serves many accounts'
// keys. AI availability for the account is decided upstream (a null credential
// 503s the route); a null model here is a misconfiguration. Same shape as the
// extractor and categorizer.
export function createCashFlowAdvisor(): CashFlowAdvisor {
  return {
    async advise(signals: CashFlowSignals, credential: LlmCredential): Promise<CashFlowNudge[]> {
      const model = resolveModel(credential, 'reasoning');
      if (!model) throw new Error('no reasoning model for the provided LLM credential');

      const { object } = await generateObject({
        model,
        schema,
        messages: [{ role: 'user', content: buildPrompt(signals) }],
      });
      return object.nudges;
    },
  };
}
