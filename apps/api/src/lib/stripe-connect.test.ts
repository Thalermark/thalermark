import { describe, expect, it } from 'vitest';
import { accountFacts, connectState, onboardingStage } from './stripe-connect.js';

// TMC-256. The bug these exist to prevent was not a crash — it was a sentence.
// "Your details are with Stripe, they're verifying everything, no further action
// needed" was shown to owners Stripe was actively blocked on, and to owners
// Stripe had rejected outright. Every case below is a distinct thing a human
// needs to be told; collapsing any two of them is the defect.

const NONE = { currently_due: [], past_due: [], disabled_reason: null };

describe('accountFacts', () => {
  it('reads the five facts off a live-looking account', () => {
    expect(
      accountFacts({
        charges_enabled: true,
        details_submitted: true,
        payouts_enabled: true,
        requirements: NONE,
      }),
    ).toEqual({
      chargesEnabled: true,
      detailsSubmitted: true,
      payoutsEnabled: true,
      requirementsDue: false,
      disabledReason: null,
    });
  });

  it('treats a missing requirements object as nothing due, not as unknown', () => {
    const facts = accountFacts({ charges_enabled: false, details_submitted: false });
    expect(facts.requirementsDue).toBe(false);
    expect(facts.disabledReason).toBeNull();
  });

  it('counts past_due as due — it is currently_due that blew its deadline', () => {
    expect(
      accountFacts({ requirements: { currently_due: [], past_due: ['individual.id_number'] } })
        .requirementsDue,
    ).toBe(true);
  });

  it('is false-by-absence rather than throwing on a sparse account', () => {
    expect(accountFacts({})).toEqual({
      chargesEnabled: false,
      detailsSubmitted: false,
      payoutsEnabled: false,
      requirementsDue: false,
      disabledReason: null,
    });
  });
});

describe('onboardingStage', () => {
  const base = {
    chargesEnabled: false,
    detailsSubmitted: false,
    payoutsEnabled: false,
    requirementsDue: false,
    disabledReason: null as string | null,
    connectAccountId: 'acct_1' as string | null,
  };

  it('is notStarted with no account, whatever else is set', () => {
    expect(onboardingStage({ ...base, connectAccountId: null })).toBe('notStarted');
  });

  it('is started when an account exists but nothing was submitted', () => {
    // The regression that shipped: this used to report inReview, so someone who
    // opened Stripe's form and backed out was told a review was underway.
    expect(onboardingStage(base)).toBe('started');
  });

  it('separates waiting-on-you from waiting-on-Stripe', () => {
    const submitted = { ...base, detailsSubmitted: true };
    expect(onboardingStage({ ...submitted, requirementsDue: true })).toBe('actionNeeded');
    expect(onboardingStage({ ...submitted, requirementsDue: false })).toBe('inReview');
  });

  it('is stopped when Stripe rejected the account, ahead of every other state', () => {
    // Rejection outranks the rest because it is the one state waiting does not
    // fix. Checked even against an otherwise complete-looking account.
    expect(
      onboardingStage({
        ...base,
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        disabledReason: 'rejected.fraud',
      }),
    ).toBe('stopped');
  });

  it('does NOT treat every disabled_reason as a rejection', () => {
    // requirements.past_due and pending_verification are stages the other
    // states already name — and name better. Only rejected.* is terminal.
    expect(
      onboardingStage({
        ...base,
        detailsSubmitted: true,
        requirementsDue: true,
        disabledReason: 'requirements.past_due',
      }),
    ).toBe('actionNeeded');
    expect(
      onboardingStage({
        ...base,
        detailsSubmitted: true,
        disabledReason: 'requirements.pending_verification',
      }),
    ).toBe('inReview');
  });

  it('flags charges-on-but-payouts-held rather than calling it live', () => {
    // Customers can pay; the money is not reaching the bank. Reporting this as
    // "Payments are live" is true about the charge and false about the money.
    expect(
      onboardingStage({
        ...base,
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: false,
      }),
    ).toBe('payoutsHeld');
  });

  it('is enabled only when charges and payouts are both on', () => {
    expect(
      onboardingStage({
        ...base,
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
      }),
    ).toBe('enabled');
  });
});

describe('connectState is unchanged by the richer facts', () => {
  // Payability is still charges_enabled and nothing else. payouts_enabled must
  // NOT gate the customer's Pay button — the money reaching the owner's bank is
  // between them and Stripe, and holding the button hostage to it would punish
  // the customer for someone else's paperwork.
  it('stays payable when payouts are held', () => {
    expect(
      connectState({
        requireConnectedAccount: true,
        stripeConfigured: true,
        connectAccountId: 'acct_1',
        chargesEnabled: true,
      }),
    ).toEqual({ connectReady: true, connectPending: false });
  });
});
