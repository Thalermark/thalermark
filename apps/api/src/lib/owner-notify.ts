import { type Database, authUser, memberships } from '@thalermark/db';
import { getLogger } from '@thalermark/logger';
import { and, eq } from 'drizzle-orm';
import type { Mailer } from './mailer.js';

const log = getLogger(['api', 'owner-notify']);

// Telling the owner when something happens TO them (TMC-230).
//
// Everything the product emails today goes outward — to the customer. Nothing
// has ever come back the other way, and the gap is worst at the single most
// valuable moment in the product: a customer accepts an estimate, and it
// notifies nobody. The estimate also leaves the dashboard's open-estimates tile
// at that instant, because that tile counts 'sent'. So the one event that means
// "go do this work and bill for it" was the one event with no surface at all.
//
// Deliberately NOT used for send failures. Emailing someone to say their email
// is not working is a joke at the user's expense — that one surfaces in-app,
// via the delivery state (TMC-226).

export type OwnerNotice = {
  subject: string;
  body: string;
};

// A customer's name reaches this copy, and a customer's name is user input.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Best-effort by construction. This runs at the tail of a customer-facing
// action — a public estimate response, a Stripe webhook — and neither of those
// may fail because the operator's own notification could not go out. The
// customer's acceptance is recorded either way; the worst case is the owner
// finds out by opening the app, which is exactly where they are today.
export async function notifyOwner(
  db: Database,
  args: { accountId: string; mailer?: Mailer; emailFrom?: string; notice: OwnerNotice },
): Promise<boolean> {
  if (!args.mailer) return false;
  try {
    const [owner] = await db
      .select({ email: authUser.email, name: authUser.name })
      .from(memberships)
      .innerJoin(authUser, eq(authUser.id, memberships.userId))
      .where(and(eq(memberships.accountId, args.accountId), eq(memberships.role, 'owner')))
      .limit(1);
    if (!owner?.email) return false;

    await args.mailer.send({
      to: owner.email,
      subject: args.notice.subject,
      text: args.notice.body,
      // Deliberately unstyled, unlike the customer-facing templates. This is a
      // note to the operator about their own business, not a document their
      // customer sees, and it should read the same in a notification shade as
      // in a mail client.
      html: args.notice.body
        .split('\n\n')
        .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
        .join(''),
      from: args.emailFrom,
    });
    return true;
  } catch (err) {
    log.warn('owner notification failed for account {accountId}: {msg}', {
      accountId: args.accountId,
      msg: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// The copy. Plain sentences, an amount, and what to do next — the same voice
// the rest of the product uses, and short enough to be read on a phone lock
// screen, which is where most of these will actually be seen.
export function estimateAcceptedNotice(args: {
  customerName: string;
  number: string;
  total: string;
  currency: string;
}): OwnerNotice {
  return {
    subject: `${args.customerName} accepted estimate ${args.number}`,
    body: [
      `${args.customerName} accepted your estimate ${args.number} for ${args.total} ${args.currency}.`,
      '',
      'Open it in Thalermark to turn it into an invoice when the work is done.',
    ].join('\n'),
  };
}

export function invoicePaidNotice(args: {
  customerName: string;
  number: string;
  amount: string;
  currency: string;
}): OwnerNotice {
  return {
    subject: `${args.customerName} paid invoice ${args.number}`,
    body: [
      `${args.customerName} paid ${args.amount} ${args.currency} on invoice ${args.number}.`,
      '',
      'The payment is already on your books — nothing else to do.',
    ].join('\n'),
  };
}
