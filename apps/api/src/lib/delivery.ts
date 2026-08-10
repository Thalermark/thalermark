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
  extra: { deliveryMessageId?: string | null; deliveryUpdatedAt?: Date } = {},
): Promise<void> {
  const patch = {
    deliveryStatus: status,
    deliveryDetail: detail,
    deliveryUpdatedAt: new Date(),
    ...extra,
  };
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
// `messageId` is the provider's id for the mail, kept because it is the only
// thing a later webhook carries that can find this row again. Optional: the
// console driver reports none, and SMTP will not either, so the whole webhook
// half of this feature is simply inert on those installs rather than broken.
export function recordSendAccepted(
  tx: Database | Transaction,
  scope: Scope,
  messageId?: string | null,
): Promise<void> {
  // Written even when absent, so a re-send through a driver that reports no id
  // clears the previous attempt's id rather than leaving a stale one pointed at
  // a message this row is no longer waiting on.
  return write(tx, scope, 'sent', null, { deliveryMessageId: messageId ?? null });
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

// What the far end did with it, reported later by the provider.
export type ProviderDeliveryEvent = {
  messageId: string;
  status: DeliveryStatus;
  detail: string | null;
  // When it happened at the PROVIDER, not when we received it. Load-bearing —
  // see the ordering guard below.
  occurredAt: Date;
};

export type ApplyOutcome = 'applied' | 'unknown_message' | 'stale';

// Apply a provider's delivery report to whichever document it belongs to.
//
// Runs with no tenant context: a webhook arrives from the internet carrying a
// verified signature and a message id, and nothing else. So the lookup is by
// message id alone, against a db handle that can see across accounts, and the
// account is discovered rather than supplied.
export async function applyProviderEvent(
  db: Database,
  event: ProviderDeliveryEvent,
): Promise<ApplyOutcome> {
  const [invoice] = await db
    .select({
      id: invoices.id,
      accountId: invoices.accountId,
      deliveryUpdatedAt: invoices.deliveryUpdatedAt,
    })
    .from(invoices)
    .where(eq(invoices.deliveryMessageId, event.messageId))
    .limit(1);

  const [estimate] = invoice
    ? []
    : await db
        .select({
          id: estimates.id,
          accountId: estimates.accountId,
          deliveryUpdatedAt: estimates.deliveryUpdatedAt,
        })
        .from(estimates)
        .where(eq(estimates.deliveryMessageId, event.messageId))
        .limit(1);

  const row = invoice ?? estimate;
  // Not ours to act on, and that is the ordinary case rather than an error: the
  // same provider account sends verification mail, password resets and
  // statements, none of which are documents with a delivery state. Acknowledged
  // by the caller so the provider stops retrying.
  if (!row) return 'unknown_message';

  // ORDERING GUARD. Webhook delivery is not ordered, and this is not
  // theoretical — while capturing fixtures for this work, `email.delivered`
  // for one message arrived before that message's own `email.sent`. Without
  // this, the late `sent` would overwrite `delivered` and the document would
  // report less than we actually know.
  //
  // `<` rather than `<=`: the send-time write and a provider event can land on
  // the same millisecond, and in that case the provider's word is the newer
  // fact.
  if (row.deliveryUpdatedAt && event.occurredAt < row.deliveryUpdatedAt) return 'stale';

  await write(
    db,
    {
      accountId: row.accountId,
      documentId: row.id,
      kind: invoice ? 'invoice' : 'estimate',
    },
    event.status,
    event.detail,
    // Stamped with the provider's clock, so the comparison above is between two
    // values from the same timeline on every subsequent event.
    { deliveryUpdatedAt: event.occurredAt },
  );
  return 'applied';
}
