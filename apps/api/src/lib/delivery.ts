import { type Database, type Transaction, estimates, invoices } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';

// Whether the email arrived (TMC-226).
//
// `sent_at` never answered this. It is stamped by the STATUS TRANSITION, and
// the send route deliberately commits that flip even when the mailer throws —
// correct, because a provider hiccup must not silently un-issue an invoice that
// already posted to A/R. But it left "issued" and "delivered" as one fact, and
// they come apart at exactly the moment the operator needs them separated.
//
// Four senders write through here — the invoice send route, the estimate send
// route, recurring generation and the reminder sweep — so a failure is recorded
// identically wherever it happens. The two background ones matter most: both
// caught the mailer error and logged a warning, so a month of auto-billing
// could deliver nothing at all while the dashboard looked clean.
export type DeliveryStatus = 'sent' | 'failed' | 'delivered' | 'bounced' | 'complained';

// The states that mean a human should look. Kept next to the partial index in
// migration 0037, which is defined on exactly this set.
export const DELIVERY_TROUBLE: DeliveryStatus[] = ['failed', 'bounced', 'complained'];

export function isDeliveryTrouble(status: string | null): boolean {
  return status !== null && (DELIVERY_TROUBLE as string[]).includes(status);
}

// A provider error is written for an operator, not a log reader: it goes on the
// row so it survives the request, and it is trimmed because some SMTP servers
// answer a rejection with a wall of diagnostic text.
function detailOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 297)}…` : collapsed;
}

type Scope = { accountId: string; documentId: string; kind: 'invoice' | 'estimate' };

// The two branches are spelled out rather than selecting the table into a
// variable: drizzle infers `.set()` from the table, and a union of two tables
// widens that inference until the shared columns stop existing on it. Three
// duplicated lines beats defeating the type checker with a cast.
async function write(
  tx: Database | Transaction,
  scope: Scope,
  status: DeliveryStatus,
  detail: string | null,
): Promise<void> {
  const patch = { deliveryStatus: status, deliveryDetail: detail, deliveryUpdatedAt: new Date() };
  if (scope.kind === 'invoice') {
    await tx
      .update(invoices)
      .set(patch)
      .where(and(eq(invoices.id, scope.documentId), eq(invoices.accountId, scope.accountId)));
    return;
  }
  await tx
    .update(estimates)
    .set(patch)
    .where(and(eq(estimates.id, scope.documentId), eq(estimates.accountId, scope.accountId)));
}

// The provider took it. Not proof it arrived — that needs a webhook — but it
// clears any failure from a previous attempt, which is what makes a re-send
// meaningful.
export function recordSendAccepted(tx: Database | Transaction, scope: Scope): Promise<void> {
  return write(tx, scope, 'sent', null);
}

// The provider refused it. Known immediately, no webhook involved, and true on
// a self-host with nothing but SMTP — which is why this half of TMC-226 is
// worth shipping ahead of the provider integration.
export function recordSendFailed(
  tx: Database | Transaction,
  scope: Scope,
  err: unknown,
): Promise<void> {
  return write(tx, scope, 'failed', detailOf(err));
}
