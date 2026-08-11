import { describe, expect, it } from 'vitest';
import { computeSendConcern } from './send-check.js';

// The typo catcher's threshold matrix (TMC-227, PR 2).
//
// Roughly half of these assert SILENCE, and that is the point. A check that
// fires on a bigger-than-usual job teaches the user to read past it, and then
// it is not there on the day the zero goes missing. The false positive is the
// expensive failure here, not the miss.

const D = (dollars: number) => Math.round(dollars * 100);

// A landscaper who mows the same street: five priors around $200.
const USUAL = [D(200), D(180), D(220), D(200), D(210)];

function check(totalDollars: number, over: Partial<Parameters<typeof computeSendConcern>[0]> = {}) {
  return computeSendConcern({
    totalCents: D(totalDollars),
    priorIssuedTotalsCents: USUAL,
    customerName: 'Mrs Patel',
    ...over,
  });
}

describe('computeSendConcern — the dropped zero', () => {
  it('names it when the invoice is ten times the usual', () => {
    const out = check(2000);
    expect(out?.signal).toBe('power_of_ten');
    // Naming the suspicion is what makes the sentence worth reading — the user
    // can confirm or dismiss it with one glance at the number.
    expect(out?.concern).toBe(
      "That's almost exactly ten times what you usually bill Mrs Patel — worth checking for a dropped zero.",
    );
  });

  it('names it in the other direction too', () => {
    const out = check(20);
    expect(out?.signal).toBe('power_of_ten');
    expect(out?.concern).toContain('a tenth of');
  });

  it('fires on a single prior — ten times is not a pattern claim', () => {
    const out = computeSendConcern({
      totalCents: D(4500),
      priorIssuedTotalsCents: [D(450)],
    });
    expect(out?.signal).toBe('power_of_ten');
    // No name supplied, so the sentence still has to read.
    expect(out?.concern).toContain('this customer');
  });

  // ±2% either side of exactly 10×. Outside that it is a big job, and the
  // dropped-zero claim would be a guess dressed as an observation.
  it('holds inside the tolerance and lets go outside it', () => {
    expect(check(2030)?.signal).toBe('power_of_ten'); // 10.15× → within 2%
    // 12× is not a keystroke. It falls through to the loose signal, which says
    // only what it knows.
    expect(check(2400)?.signal).toBe('median');
  });
});

describe('computeSendConcern — the loose signal', () => {
  it('states both figures and offers no theory', () => {
    const out = check(900);
    expect(out?.signal).toBe('median');
    expect(out?.concern).toBe('You usually bill Mrs Patel around $200.00 — this one is $900.00.');
  });

  it('fires under a quarter of the usual', () => {
    expect(check(45)?.signal).toBe('median');
  });

  it('needs three priors before a median means anything', () => {
    expect(
      computeSendConcern({ totalCents: D(2000), priorIssuedTotalsCents: [D(200), D(210)] }),
    ).toBeNull();
  });

  // The median, not the mean. One $9,000 job in a history of $200 mowings would
  // drag a mean far enough to make every later invoice look normal — which is
  // backwards, since that outlier is the shape of the thing being hunted.
  it('is not dragged by one outlier in the history', () => {
    const out = computeSendConcern({
      totalCents: D(900),
      priorIssuedTotalsCents: [D(200), D(180), D(9000), D(220), D(200)],
      customerName: 'Mrs Patel',
    });
    expect(out?.signal).toBe('median');
    expect(out?.concern).toContain('around $200.00');
  });
});

describe('computeSendConcern — money already spent on the job', () => {
  it('says so when the invoice is under what the job cost', () => {
    const out = check(300, { jobCostCents: D(800) });
    expect(out?.signal).toBe('job_cost');
    expect(out?.concern).toBe(
      "This invoice ($300.00) is less than the $800.00 you've recorded spending on this job.",
    );
  });

  // It wins because it is a FACT about this invoice rather than a pattern
  // across others — and because "you are losing money on this job" is more
  // useful than "this is bigger than usual", even when both are true.
  it('wins over the ratio signals when several could fire', () => {
    const out = check(45, { jobCostCents: D(800) });
    expect(out?.signal).toBe('job_cost');
  });

  it('says nothing when the job cost less than the invoice', () => {
    expect(check(300, { jobCostCents: D(120) })).toBeNull();
  });

  it('says nothing about an invoice with no job', () => {
    expect(check(300)).toBeNull();
  });
});

// Half the suite. Every one of these is a normal working day that must not be
// interrupted.
describe('computeSendConcern — silence', () => {
  it('an ordinary invoice for an ordinary customer', () => {
    expect(check(230)).toBeNull();
  });

  it('a job twice the usual size — that is a bigger yard, not a mistake', () => {
    expect(check(400)).toBeNull();
  });

  it('three times the usual, still under the loose bound', () => {
    expect(check(599)).toBeNull();
  });

  it('a brand-new customer with no history at all', () => {
    expect(computeSendConcern({ totalCents: D(4500), priorIssuedTotalsCents: [] })).toBeNull();
  });

  // Ratios are meaningless at small amounts. Nobody drops a zero on the price
  // of a bag of mulch, and $50 is where a mistake starts costing more than the
  // interruption does.
  it('a tiny invoice, whatever the ratio says', () => {
    expect(
      computeSendConcern({ totalCents: D(40), priorIssuedTotalsCents: [D(4), D(5), D(4)] }),
    ).toBeNull();
  });

  it('a job whose costs are only just above the invoice', () => {
    expect(check(300, { jobCostCents: D(340) })).toBeNull();
  });

  it('a zero-total invoice', () => {
    expect(check(0)).toBeNull();
  });

  it('a history of zeroes cannot make a ratio', () => {
    expect(
      computeSendConcern({ totalCents: D(500), priorIssuedTotalsCents: [0, 0, 0] }),
    ).toBeNull();
  });

  // Just under each bound, from both directions — the pairs that pin the
  // thresholds where they are rather than where a later edit drifts them.
  it('just inside the loose bounds, from both directions', () => {
    expect(check(799)).toBeNull(); // 3.995× — under 4
    expect(check(51)).toBeNull(); // 0.255× — over ¼
  });

  // Deliberately NOT silent, and worth pinning as the pair it forms with the
  // test above: 9.5× is too far off a power of ten to call a dropped zero, but
  // nowhere near ordinary. It falls through to the loose signal rather than out
  // of the check altogether.
  it('9.5× is not a dropped zero, but it is still not normal', () => {
    expect(check(1900)?.signal).toBe('median');
  });
});
