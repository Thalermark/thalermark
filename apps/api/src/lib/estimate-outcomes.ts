import { estimates } from '@thalermark/db';
import { sql } from 'drizzle-orm';
import { companyToday } from './company-today.js';

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
// Measured against the quote's OWN company clock (TMC-258). This used to be
// UTC, chosen deliberately: with the date passed in as a string, the risk worth
// designing against was the two callers passing DIFFERENT strings, and one
// shared basis — even a slightly wrong one — beat two right-ish ones that
// disagreed. That reasoning was sound and its conclusion is now obsolete,
// because the basis no longer travels as an argument. The predicates carry it
// themselves, so the callers cannot diverge by construction, which is what the
// original comment actually wanted.
//
// The cost of UTC was not theoretical: a quote expiring today read as expired
// from 7pm US Central the evening before it ran out, and since the win rate
// counts lapsed quotes, the headline metric moved with it.
export function estimateLapsed() {
  return sql`${estimates.status} = 'sent' and ${estimates.expiresOn} is not null and ${estimates.expiresOn} < ${companyToday(estimates.companyId)}`;
}

// Sent and still live — the complement of lapsed within 'sent', so the two can
// never both claim the same row or both disclaim it.
export function estimateStillOpen() {
  return sql`${estimates.status} = 'sent' and (${estimates.expiresOn} is null or ${estimates.expiresOn} >= ${companyToday(estimates.companyId)})`;
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
