import { settlementErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { localToday } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const billRes = await client.api.bills[':id'].$get({ param: { id: event.params.id } });
  if (billRes.status === 404) throw error(404, 'bill not found');
  if (!billRes.ok) throw error(billRes.status, 'failed to load bill');
  const bill = await billRes.json();

  // Resolve the category (+ payment, if paid) account ids to labels.
  // Best-effort — a failed accounts fetch falls back to the raw id.
  const [catRes, assetRes] = await Promise.all([
    client.api.companies[':id'].accounts.$get({
      param: { id: bill.companyId },
      query: { type: 'expense' },
    }),
    // Money accounts rather than `type=asset`: a credit card is a liability, so
    // an asset query misses it and the label lookup below would print a raw
    // uuid for anything paid from a card — or for a card STATEMENT bill, whose
    // category is the card itself (TMC-207).
    //
    // includeArchived because this is a read of something already recorded: a
    // bill paid from an account since archived still has to name it.
    client.api['money-accounts'].$get({
      query: { companyId: bill.companyId, includeArchived: 'true' },
    }),
  ]);
  const labelById = new Map<string, string>();
  if (catRes.ok) {
    for (const a of (await catRes.json()).accounts) labelById.set(a.id, a.name);
  }
  if (assetRes.ok) {
    // Name only — the user picked "Chase Sapphire", not "2100 · Chase Sapphire".
    for (const a of (await assetRes.json()).moneyAccounts) labelById.set(a.id, a.name);
  }

  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'bill', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  // Payments + derived settlement (TMC-192). Best-effort like the audit trail:
  // losing the payments panel is better than 500ing the whole bill.
  const paymentsRes = await client.api.bills[':id'].payments.$get({
    param: { id: event.params.id },
  });
  const settlement = paymentsRes.ok ? await paymentsRes.json() : null;

  // Where the money can be paid FROM (TMC-207). ACTIVE accounts only — this is
  // the picker for new work, unlike the label map above which has to resolve
  // archived accounts too.
  const payFromRes = await client.api['money-accounts'].$get({
    query: { companyId: bill.companyId },
  });
  const moneyAccounts = payFromRes.ok ? (await payFromRes.json()).moneyAccounts : [];

  // Today as the company's calendar day, for the payment-date defaults
  // (TMC-303). This server runs UTC, so its own clock dates an evening
  // payment tomorrow. Best-effort like the labels above: a failed companies
  // fetch falls back to the UTC slice, the pre-TMC-303 behaviour.
  let today = new Date().toISOString().slice(0, 10);
  const companiesRes = await client.api.companies.$get();
  if (companiesRes.ok) {
    const company = (await companiesRes.json()).companies.find((c) => c.id === bill.companyId);
    if (company) today = localToday(company.timezone);
  }

  return {
    bill,
    moneyAccounts,
    today,
    // One key per render, so a double-click on Record payment sends the same
    // one twice and the server writes a single row (TMC-218). Minted here so it
    // survives hydration unchanged.
    paymentKey: crypto.randomUUID(),
    categoryLabel: labelById.get(bill.categoryAccountId) ?? bill.categoryAccountId,
    paymentLabel: bill.paymentAccountId
      ? (labelById.get(bill.paymentAccountId) ?? bill.paymentAccountId)
      : null,
    settlement,
    auditEvents,
  };
};

export const actions: Actions = {
  // open -> paid. Posts the settlement (Dr AP / Cr payment asset). method +
  // optional reference + optional paidOn from PaymentFields; the asset defaults
  // to Cash server-side.
  markPaid: async (event) => {
    const client = serverApiClient(event);
    const id = event.params.id;
    const data = await event.request.formData();
    const method = String(data.get('method') ?? 'cash') as
      | 'cash'
      | 'check'
      | 'venmo'
      | 'zelle'
      | 'other';
    const referenceRaw = data.get('reference');
    const reference =
      typeof referenceRaw === 'string' && referenceRaw.trim() ? referenceRaw.trim() : undefined;
    const paidOnRaw = data.get('paidOn');
    const paidOn = typeof paidOnRaw === 'string' && paidOnRaw.trim() ? paidOnRaw.trim() : undefined;

    const res = await client.api.bills[':id']['mark-paid'].$post({
      param: { id },
      // Which account the money left. Omitted → the server's primary.
      json: {
        method,
        reference,
        paidOn,
        paymentAccountId: (() => {
          const raw = data.get('paymentAccountId');
          return typeof raw === 'string' && raw ? raw : undefined;
        })(),
      },
    });
    if (res.status === 404) throw error(404, 'bill not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        transitionError: settlementErrorMessage(
          body?.error,
          'bill',
          'That could not be marked paid. Try again.',
          body,
        ),
      });
    }
    redirect(303, `/bills/${id}`);
  },

  // One payment against the bill (TMC-192) — the vendor-deposit path. Direction
  // is a separate control rather than asking the user to type a minus sign: a
  // refund from the vendor is stored as a negative payment, but nobody thinks
  // of it that way.
  recordPayment: async (event) => {
    const client = serverApiClient(event);
    const id = event.params.id;
    const formData = await event.request.formData();
    const amountRaw = String(formData.get('amount') ?? '').trim();
    if (!amountRaw) return fail(400, { transitionError: 'Enter an amount.' });
    const direction = String(formData.get('direction') ?? 'out');
    const amount = direction === 'in' ? `-${amountRaw.replace(/^-/, '')}` : amountRaw;

    const paidOn = String(formData.get('paidOn') ?? '').trim();
    if (!paidOn) return fail(400, { transitionError: 'Enter the date the money left.' });

    const method = String(formData.get('method') ?? 'cash') as
      | 'cash'
      | 'check'
      | 'venmo'
      | 'zelle'
      | 'other';
    const referenceRaw = formData.get('reference');
    const reference =
      typeof referenceRaw === 'string' && referenceRaw.trim() ? referenceRaw.trim() : undefined;
    const keyRaw = formData.get('idempotencyKey');
    const idempotencyKey = typeof keyRaw === 'string' && keyRaw ? keyRaw : undefined;
    // Which account the money left. Omitted → the server resolves the primary,
    // which is what a company with one account has always done.
    const accRaw = formData.get('paymentAccountId');
    const paymentAccountId = typeof accRaw === 'string' && accRaw ? accRaw : undefined;
    const res = await client.api.bills[':id'].payments.$post({
      param: { id },
      // Forwarded from the hidden field the form rendered with; the partial
      // unique index on bill_payments is what actually stops the second row.
      json: { amount, paidOn, method, reference, idempotencyKey, paymentAccountId },
    });
    if (res.status === 404) throw error(404, 'bill not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        transitionError: settlementErrorMessage(
          body?.error,
          'bill',
          'That payment could not be recorded. Try again.',
          body,
        ),
      });
    }
    redirect(303, `/bills/${id}`);
  },

  // Remove a payment recorded in error. Posts a reversing entry dated at the
  // original — the ledger is append-only, so this never erases history.
  removePayment: async (event) => {
    const client = serverApiClient(event);
    const id = event.params.id;
    const formData = await event.request.formData();
    const paymentId = String(formData.get('paymentId') ?? '');
    if (!paymentId) return fail(400, { transitionError: 'missing_payment_id' });

    const res = await client.api.bills[':id'].payments[':paymentId'].$delete({
      param: { id, paymentId },
    });
    if (res.status === 404) throw error(404, 'payment not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        transitionError: settlementErrorMessage(
          body?.error,
          'bill',
          'That payment could not be removed. Try again.',
          body,
        ),
      });
    }
    redirect(303, `/bills/${id}`);
  },

  // open -> voided. Reverses the open posting.
  void: async (event) => {
    const client = serverApiClient(event);
    const id = event.params.id;
    const res = await client.api.bills[':id'].void.$post({ param: { id } });
    if (res.status === 404) throw error(404, 'bill not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        transitionError: settlementErrorMessage(
          body?.error,
          'bill',
          'That could not be voided. Try again.',
          body,
        ),
      });
    }
    redirect(303, `/bills/${id}`);
  },
};
