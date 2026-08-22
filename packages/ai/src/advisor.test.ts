import { beforeEach, describe, expect, it, vi } from 'vitest';

// What the model is actually SHOWN, which is the whole of TMC-229. The old
// signals struct held six numbers, four of them already printed on the dashboard
// the nudge renders under, so the premium reasoning call could not say anything
// the free tiles did not. These tests assert the new signals reach the prompt,
// and that the prompt stays quiet about what it does not know.
const generateObject = vi.fn();
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
  APICallError: class extends Error {},
}));

const { createCashFlowAdvisor } = await import('./advisor.js');

import type { LlmCredential } from './provider.js';
import type { CashFlowSignals } from './types.js';

const cred: LlmCredential = { provider: 'anthropic', apiKey: 'sk-ant-test-key' };

const base: CashFlowSignals = {
  asOf: '2026-08-14',
  cashOnHand: '812.50',
  monthToDate: { moneyIn: '1000.00', moneyOut: '4074.99' },
  trailingMonths: [],
  owed: '2400.00',
  overdueCount: 1,
  businessType: 'sole_prop',
  latePayers: [],
  categoryMovers: [],
  merchantMovers: [],
};

// The advisor builds its prompt internally; this is the only seam that sees it.
async function promptFor(signals: CashFlowSignals): Promise<string> {
  generateObject.mockResolvedValue({ object: { nudges: [] } });
  await createCashFlowAdvisor().advise(signals, cred);
  const opts = generateObject.mock.calls[0]?.[0];
  return opts.messages[0].content as string;
}

describe('the prompt carries what the dashboard cannot show', () => {
  beforeEach(() => generateObject.mockReset());

  it('names a late payer, what they owe, and how late they are', async () => {
    const prompt = await promptFor({
      ...base,
      latePayers: [
        {
          name: "Dave's Landscaping",
          outstanding: '2400.00',
          daysPastDue: 31,
          lateCount: 3,
          paidCount: 4,
        },
      ],
    });

    expect(prompt).toContain("Dave's Landscaping");
    expect(prompt).toContain('$2,400.00 outstanding');
    expect(prompt).toContain('31 days past due');
    // The pitch sentence this ticket exists to make reachable.
    expect(prompt).toContain('paid late 3 of 4 times');
  });

  // One settled invoice is not a pattern. Asserting one from a single data point
  // is exactly the confident-and-wrong sentence this layer must not produce.
  it('omits the paid-late history when there is only one settled invoice', async () => {
    const prompt = await promptFor({
      ...base,
      latePayers: [
        {
          name: 'One Timer LLC',
          outstanding: '500.00',
          daysPastDue: 12,
          lateCount: 1,
          paidCount: 1,
        },
      ],
    });

    // Asserted as the whole rendered line. A bare not.toContain('paid late')
    // would pass or fail on the wording of the rules block above the data,
    // which mentions both phrases in its worked examples.
    expect(prompt).toContain('  One Timer LLC: $500.00 outstanding, 12 days past due');
  });

  // A contact listed for their history alone owes nothing overdue right now.
  it('omits days-past-due when there is no open overdue invoice', async () => {
    const prompt = await promptFor({
      ...base,
      latePayers: [
        {
          name: 'Slow But Settled',
          outstanding: '0.00',
          daysPastDue: null,
          lateCount: 2,
          paidCount: 5,
        },
      ],
    });

    // Whole line again, for the same reason as the test above.
    expect(prompt).toContain('  Slow But Settled: $0.00 outstanding, paid late 2 of 5 times');
  });

  it('renders category and vendor movement with direction and size', async () => {
    const prompt = await promptFor({
      ...base,
      categoryMovers: [{ label: 'Fuel', recent: '840.00', typical: '420.00', pctOver: 100 }],
      merchantMovers: [{ label: 'Home Depot', recent: '1200.00', typical: '300.00', pctOver: 300 }],
    });

    expect(prompt).toContain('Fuel: $840.00 in the last 30 days vs $420.00 typical (up 100%)');
    expect(prompt).toContain(
      'Home Depot: $1,200.00 in the last 30 days vs $300.00 typical (up 300%)',
    );
  });

  it('reports a fall as down rather than as a negative rise', async () => {
    const prompt = await promptFor({
      ...base,
      categoryMovers: [{ label: 'Fuel', recent: '210.00', typical: '420.00', pctOver: -50 }],
    });

    expect(prompt).toContain('(down 50%)');
    expect(prompt).not.toContain('-50%');
  });

  // An empty heading invites a sentence about nothing, which is the failure mode
  // the "fewer grounded nudges beat more vague ones" rule exists to prevent.
  it('omits a section entirely rather than printing an empty heading', async () => {
    const prompt = await promptFor(base);

    expect(prompt).not.toContain('Customers who owe you');
    expect(prompt).not.toContain('Vendors whose spend moved');
    // The always-present figures are still there.
    expect(prompt).toContain('$812.50');
  });

  // The dashboard beside the nudge can be switched to 30d or ytd while these
  // figures stay month-to-date, so the period has to be named or the two read as
  // contradicting each other.
  it('instructs the model to name the period a figure covers', async () => {
    const prompt = await promptFor(base);

    expect(prompt).toContain('SAY WHICH');
    expect(prompt).toContain('This month so far');
  });
});
