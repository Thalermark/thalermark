import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage, settlementErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const invoiceRes = await client.api.invoices[':id'].$get({ param: { id: event.params.id } });
  if (invoiceRes.status === 404) throw error(404, 'invoice not found');
  if (!invoiceRes.ok) throw error(invoiceRes.status, 'failed to load invoice');
  const invoice = await invoiceRes.json();

  const contactRes = await client.api.contacts[':id'].$get({
    param: { id: invoice.contactId },
  });
  const contact = contactRes.ok ? await contactRes.json() : null;

  // Just-in-time prompt: a draft invoice is the moment a missing business
  // address actually costs the user something (it won't show on what the
  // contact sees). State-driven like the dashboard nudge — surfaces while
  // the address is unset, resolves itself once filled. Best-effort: a failed
  // companies fetch just drops the prompt rather than blocking the page.
  const companiesRes = await client.api.companies.$get();
  const companies = companiesRes.ok ? (await companiesRes.json()).companies : [];
  const company =
    companies.find((c) => c.id === invoice.companyId) ??
    pickActiveCompany(event.cookies, companies) ??
    null;
  const needsBusinessDetails = !!company && !company.businessAddress;
  const businessCompanyId = company?.id ?? null;

  // Whether this company's invoices can be paid by card yet. The recipient's
  // page is deliberately silent about unfinished Stripe onboarding — telling a
  // customer their supplier hasn't sorted its admin is not the customer's
  // problem — so the owner has to learn it here, on the invoice they just sent.
  // Best-effort like the prompts above: a failed fetch drops the banner.
  // Where a receipt can land (TMC-207). Bank accounts only — nothing is ever
  // deposited into a credit card.
  const moneyRes = await client.api['money-accounts'].$get({
    query: { companyId: invoice.companyId },
  });
  const moneyAccounts = moneyRes.ok
    ? (await moneyRes.json()).moneyAccounts.filter((a) => a.kind !== 'credit_card')
    : [];

  let paymentsNotLive = false;
  if (company) {
    const connectRes = await client.api.companies[':id']['stripe-connect'].status.$get({
      param: { id: company.id },
    });
    if (connectRes.ok) paymentsNotLive = (await connectRes.json()).connectPending;
  }

  // After a successful send, the action redirects back with ?sent=<email>.
  // Read it here so the success banner survives the post/redirect without a
  // session flash; the URL stays one-shot (refresh clears it).
  const sentTo = event.url.searchParams.get('sent');
  const sendUndelivered = event.url.searchParams.get('undelivered') === '1';

  // Audit trail (slice 8.8a). Best-effort: a non-OK response renders an
  // empty history rather than failing the whole page.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'invoice', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  // Receipts against this invoice (TMC-187), with the derived settlement.
  // Best-effort like the audit trail: a failed fetch renders the page without
  // the payments panel rather than 500ing the whole invoice.
  const paymentsRes = await client.api.invoices[':id'].payments.$get({
    param: { id: event.params.id },
  });
  const settlement = paymentsRes.ok ? await paymentsRes.json() : null;

  // origin is what the recipient will see in the URL — derived from the
  // incoming request so it works behind any reverse-proxy / custom domain
  // without an extra env var. Passed alongside the invoice so the share
  // panel can render the full absolute URL the user copies.
  return {
    invoice,
    contact,
    origin: event.url.origin,
    sentTo,
    sendUndelivered,
    // One key per render of the payment forms, so a double-click sends the same
    // one twice and the server records a single receipt (TMC-218). Minted here
    // rather than in the component because the value has to survive hydration
    // unchanged — a client-side crypto.randomUUID() would disagree with the one
    // already rendered into the HTML. A genuine second payment happens on a
    // later render and therefore carries a different key, which is the whole
    // point: two $50 cash instalments on one day are two receipts, not a
    // mistake.
    paymentKey: crypto.randomUUID(),
    auditEvents,
    needsBusinessDetails,
    businessCompanyId,
    paymentsNotLive,
    moneyAccounts,
    settlement,
    // Whether the BUSINESS has automatic reminders switched on. The per-invoice
    // control is meaningless without it — "stop reminding about this invoice"
    // on a company that never reminds anyone reads as a setting that does
    // nothing, so the section says which of the two levels is off (TMC-189).
    companyRemindersEnabled: company?.remindersEnabled ?? false,
  };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};

// Status-transition actions. Each posts to the matching API endpoint and
// redirects back to the detail page so the new status renders on the next
// load. Action-failure surfaces a single `transitionError` so the page can
// banner it without needing per-action form state. Plain HTML POST — no
// use:enhance, in line with the rest of the app's no-JS path.
async function runTransition(
  event: Parameters<Actions[string]>[0],
  endpoint: 'mark-sent' | 'void' | 'revise',
) {
  const client = serverApiClient(event);
  const id = event.params.id;
  // Branched rather than a dynamic index so the typed client keeps its
  // per-route signatures.
  const res =
    endpoint === 'mark-sent'
      ? await client.api.invoices[':id']['mark-sent'].$post({ param: { id } })
      : endpoint === 'revise'
        ? await client.api.invoices[':id'].revise.$post({ param: { id } })
        : await client.api.invoices[':id'].void.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: settlementErrorMessage(
        body?.error,
        'invoice',
        'That could not be changed. Try again.',
        body,
      ),
    });
  }
  redirect(303, `/invoices/${id}`);
}

// mark-paid (fresh) and edit-payment (on an already-paid invoice) share the
// same payload from PaymentFields — method + optional reference + optional
// paidOn — and differ only in endpoint. The $post call is branched (not a
// dynamic index) so the typed client keeps its per-route signatures; the
// method set is fixed by the markup so the enum cast is safe.
async function postPayment(
  event: Parameters<Actions[string]>[0],
  endpoint: 'mark-paid' | 'edit-payment',
) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const method = String(formData.get('method') ?? 'cash') as
    | 'cash'
    | 'check'
    | 'venmo'
    | 'zelle'
    | 'other';
  const referenceRaw = formData.get('reference');
  const reference =
    typeof referenceRaw === 'string' && referenceRaw.trim() ? referenceRaw.trim() : undefined;
  const paidOnRaw = formData.get('paidOn');
  const paidOn = typeof paidOnRaw === 'string' && paidOnRaw.trim() ? paidOnRaw.trim() : undefined;
  // Which account the money banked into (TMC-207). Omitted → the primary, which
  // is where every receipt taken before there was a choice went.
  //
  // edit-payment does NOT take it: that endpoint moves a payment's DATE, and
  // re-banking it into a different account is a different decision the ledger
  // would have to reverse and repost for. Sending it there would be silently
  // ignored, which is worse than not offering it.
  const depositRaw = formData.get('depositAccountId');
  const depositAccountId = typeof depositRaw === 'string' && depositRaw ? depositRaw : undefined;
  const res =
    endpoint === 'mark-paid'
      ? await client.api.invoices[':id']['mark-paid'].$post({
          param: { id },
          json: { method, reference, paidOn, depositAccountId },
        })
      : await client.api.invoices[':id']['edit-payment'].$post({
          param: { id },
          json: { method, reference, paidOn },
        });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: settlementErrorMessage(body?.error, 'invoice', `${endpoint}_failed`, body),
    });
  }
  redirect(303, `/invoices/${id}`);
}

// /send is the primary CTA — it transitions draft → sent AND emails the
// recipient. /mark-sent stays for the "sent out-of-band" case (paper /
// in-person handoff). Action posts FormData so the no-JS path works; we
// extract the optional `to` override and pass it to the typed RPC client.
// On success we redirect with ?sent=<address> so the detail page can
// banner the success without persisting state.
async function runSend(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const toRaw = formData.get('to');
  const to = typeof toRaw === 'string' && toRaw.trim() ? toRaw.trim() : undefined;
  const res = await client.api.invoices[':id'].send.$post({
    param: { id },
    json: to ? { to } : {},
  });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(body?.error, 'That could not be sent. Try again.', body),
    });
  }
  const body = (await res.json()) as { sentTo?: string; delivered?: boolean };
  // `undelivered` rides along because the server may have logged the message
  // rather than sent it — the console mailer resolves successfully having done
  // nothing (TMC-212). Only the negative case is carried, so an ordinary send
  // keeps the URL it always had.
  const qs = body.sentTo
    ? `?sent=${encodeURIComponent(body.sentTo)}${body.delivered === false ? '&undelivered=1' : ''}`
    : '';
  redirect(303, `/invoices/${id}${qs}`);
}

// Duplicate-as-template: clone this invoice into a fresh draft and land on its
// edit page so the user tweaks before sending. Available for any status.
async function runDuplicate(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const res = await client.api.invoices[':id'].duplicate.$post({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(
        body?.error,
        'That could not be duplicated. Try again.',
        body,
      ),
    });
  }
  const { id } = (await res.json()) as { id: string };
  redirect(303, `/invoices/${id}/edit`);
}

// Just-in-time business details: saves the address (+ optional phone) the
// draft prompt collects, then redirects back to the invoice so the user
// continues straight to sending. PATCHes the same company endpoint Settings →
// Business uses; empty input is a no-op clear (the prompt simply persists).
async function runAddBusinessDetails(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const companyId = String(formData.get('companyId') ?? '');
  const businessAddress = String(formData.get('businessAddress') ?? '').trim();
  const businessPhone = String(formData.get('businessPhone') ?? '').trim();
  if (!companyId) return fail(400, { transitionError: 'missing_company_id' });

  const res = await client.api.companies[':id'].$patch({
    param: { id: companyId },
    json: { businessAddress, businessPhone },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
    });
  }
  redirect(303, `/invoices/${id}`);
}

// Record one receipt against an issued invoice (TMC-187) — the deposit path.
// Distinct from markPaid above, which settles the whole outstanding balance in
// one shot and stays the one-click option for "they paid it all".
//
// `amount` is signed on the wire so a refund or credit note is the same form
// with a negative number; the UI offers it as an explicit choice rather than
// asking anyone to type a minus sign.
async function runRecordPayment(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const amountRaw = String(formData.get('amount') ?? '').trim();
  const direction = String(formData.get('direction') ?? 'in');
  if (!amountRaw) return fail(400, { transitionError: 'Enter an amount.' });
  const amount = direction === 'out' ? `-${amountRaw.replace(/^-/, '')}` : amountRaw;

  const method = String(formData.get('method') ?? 'cash') as
    | 'cash'
    | 'check'
    | 'venmo'
    | 'zelle'
    | 'other';
  const referenceRaw = formData.get('reference');
  const reference =
    typeof referenceRaw === 'string' && referenceRaw.trim() ? referenceRaw.trim() : undefined;
  const receivedOn = String(formData.get('receivedOn') ?? '').trim();
  if (!receivedOn) return fail(400, { transitionError: 'Enter the date the money arrived.' });
  const keyRaw = formData.get('idempotencyKey');
  const idempotencyKey = typeof keyRaw === 'string' && keyRaw ? keyRaw : undefined;

  const res = await client.api.invoices[':id'].payments.$post({
    param: { id },
    // Forwarded straight through from the hidden field the form rendered with.
    // The server's partial unique index is what actually prevents the second
    // receipt; this is the client keeping its half of the bargain (TMC-218).
    json: {
      amount,
      receivedOn,
      method,
      reference,
      idempotencyKey,
      depositAccountId: (() => {
        const raw = formData.get('depositAccountId');
        return typeof raw === 'string' && raw ? raw : undefined;
      })(),
    },
  });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: settlementErrorMessage(
        body?.error,
        'invoice',
        'That payment could not be recorded. Try again.',
        body,
      ),
    });
  }
  redirect(303, `/invoices/${id}`);
}

// Remove a receipt recorded in error. Posts a reversing entry dated at the
// original — the ledger is append-only, so this never erases history.
// Silence (or resume) automated chasing for this one invoice — TMC-189. Its own
// endpoint rather than the invoice PATCH, which is draft-only and would reject
// every SENT invoice, i.e. every invoice reminders apply to.
// One-step deposit on a draft (TMC-199). The server issues the invoice and
// records the payment in a single transaction — the client sends one number.
async function runTakeDeposit(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const amount = String(formData.get('amount') ?? '').trim();
  if (!amount) return fail(400, { transitionError: 'Enter how much they paid.' });
  const keyRaw = formData.get('idempotencyKey');
  const idempotencyKey = typeof keyRaw === 'string' && keyRaw ? keyRaw : undefined;

  // This path issues the invoice AND records the deposit in one transaction, so
  // a double-click books the money twice and re-runs a state transition. Same
  // key, same guard as the plain payment path (TMC-218).
  const res = await client.api.invoices[':id'].deposit.$post({
    param: { id },
    json: { amount, idempotencyKey },
  });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: settlementErrorMessage(
        body?.error,
        'invoice',
        'That deposit could not be recorded. Try again.',
        body,
      ),
    });
  }
  redirect(303, `/invoices/${id}`);
}

async function runSetReminders(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const optedOut = String(formData.get('optedOut') ?? '') === 'true';

  const res = await client.api.invoices[':id'].reminders.$post({
    param: { id },
    json: { optedOut },
  });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(
        body?.error,
        'Those reminder settings could not be saved. Try again.',
        body,
      ),
    });
  }
  redirect(303, `/invoices/${id}`);
}

async function runRemovePayment(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const paymentId = String(formData.get('paymentId') ?? '');
  if (!paymentId) return fail(400, { transitionError: 'missing_payment_id' });

  const res = await client.api.invoices[':id'].payments[':paymentId'].$delete({
    param: { id, paymentId },
  });
  if (res.status === 404) throw error(404, 'payment not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: settlementErrorMessage(
        body?.error,
        'invoice',
        'That payment could not be removed. Try again.',
        body,
      ),
    });
  }
  redirect(303, `/invoices/${id}`);
}

export const actions: Actions = {
  send: runSend,
  addBusinessDetails: runAddBusinessDetails,
  markSent: (event) => runTransition(event, 'mark-sent'),
  markPaid: (event) => postPayment(event, 'mark-paid'),
  void: (event) => runTransition(event, 'void'),
  // "Fix this invoice" (TMC-227). period_closed, invoice_paid and
  // revision_in_progress all arrive as plain error codes and are turned into
  // sentences by the shared api-messages map, like every other refusal here.
  revise: (event) => runTransition(event, 'revise'),
  editPayment: (event) => postPayment(event, 'edit-payment'),
  recordPayment: runRecordPayment,
  removePayment: runRemovePayment,
  setReminders: runSetReminders,
  takeDeposit: runTakeDeposit,
  duplicate: runDuplicate,
};
