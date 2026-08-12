import { estimates } from '@thalermark/db';
import { sql } from 'drizzle-orm';

// "This quote ran out without an answer" — in one place, because two surfaces
// ask it (TMC-255).
//
// `expired` is never a stored status. No transition writes it: the table has
// only mark-sent, mark-accepted and mark-declined, and there is no sweep. Expiry
// is advisory-at-read off expires_on, which is deliberate — a quote that has run
// out is still 'sent', so it can be pulled back and re-offered at a new price.
//
// The consequence, and the bug this fixes: anything that counted the `expired`
// STATUS was counting a column that cannot have a value. The estimate win-rate
// report divided by `accepted + declined + expired` and that last term was
// permanently zero, while the same report rendered an `expired: 0` row for a
// company whose quotes had in fact lapsed. Meanwhile the contact page derived
// its own lapsed count and got a different answer for the same customer.
//
// UTC, matching the two surfaces that already derive expiry this way rather
// than introducing a third basis. A quote's expiry is a calendar date the
// operator chose, so the worst a zone can cost is a few hours at a boundary —
// where resolving one caller through the company timezone and not the other
// would guarantee they disagree.
export function estimateTodayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

// Sent, unanswered, and past its expiry date.
export function estimateLapsed(todayYmd: string) {
  return sql`${estimates.status} = 'sent' and ${estimates.expiresOn} is not null and ${estimates.expiresOn} < ${todayYmd}`;
}

// Sent and still live — the complement of lapsed within 'sent', so the two can
// never both claim the same row or both disclaim it.
export function estimateStillOpen(todayYmd: string) {
  return sql`${estimates.status} = 'sent' and (${estimates.expiresOn} is null or ${estimates.expiresOn} >= ${todayYmd})`;
}

// A LAPSED QUOTE IS COUNTED BUT IS NOT A DECISION (owner call, 2026-08-11).
//
// It is not a "no": the customer said nothing. The expiry date was the
// operator's own choice, so folding it into the denominator would move a
// customer's accept rate because someone typed 30 days instead of 90. And it is
// not terminal the way declined is — people accept a January quote in March.
//
// So an accept rate is `accepted / (accepted + declined)`, and lapsed is
// reported beside it as its own figure. Both surfaces call this.
export function acceptRate(accepted: number, declined: number): string | null {
  const answered = accepted + declined;
  return answered > 0 ? (accepted / answered).toFixed(4) : null;
}
