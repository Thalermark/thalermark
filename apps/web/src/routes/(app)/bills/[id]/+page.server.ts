import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
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
    client.api.companies[':id'].accounts.$get({
      param: { id: bill.companyId },
      query: { type: 'asset' },
    }),
  ]);
  const labelById = new Map<string, string>();
  if (catRes.ok) {
    for (const a of (await catRes.json()).accounts) labelById.set(a.id, `${a.code} · ${a.name}`);
  }
  if (assetRes.ok) {
    for (const a of (await assetRes.json()).accounts) labelById.set(a.id, `${a.code} · ${a.name}`);
  }

  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'bill', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return {
    bill,
    categoryLabel: labelById.get(bill.categoryAccountId) ?? bill.categoryAccountId,
    paymentLabel: bill.paymentAccountId
      ? (labelById.get(bill.paymentAccountId) ?? bill.paymentAccountId)
      : null,
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
      json: { method, reference, paidOn },
    });
    if (res.status === 404) throw error(404, 'bill not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        transitionError: apiErrorMessage(body?.error, 'mark_paid_failed', body),
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
        transitionError: apiErrorMessage(body?.error, 'void_failed', body),
      });
    }
    redirect(303, `/bills/${id}`);
  },
};
