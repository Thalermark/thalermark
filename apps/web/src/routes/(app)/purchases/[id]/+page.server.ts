import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { loanPaymentSchema } from '@thalermark/validation';
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
  const res = await client.api.purchases[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'not found');
  if (!res.ok) throw error(res.status, 'failed to load');
  const purchase = await res.json();

  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'capital_purchase', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return { purchase, auditEvents, today: new Date().toISOString().slice(0, 10) };
};

export const actions: Actions = {
  recordPayment: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const amount = String(data.get('amount') ?? '').trim();
    const interest = String(data.get('interest') ?? '').trim();
    const paidOn = String(data.get('paidOn') ?? '').trim();

    const parsed = loanPaymentSchema.safeParse({
      amount,
      interest: interest === '' ? undefined : interest,
      paidOn,
    });
    if (!parsed.success) {
      return fail(400, { paymentError: parsed.error.issues[0]?.message ?? 'Invalid payment.' });
    }

    const res = await client.api.purchases[':id'].payments.$post({
      param: { id: event.params.id },
      json: parsed.data,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const message =
        body?.error === 'payment_exceeds_balance'
          ? "That's more than you still owe."
          : (body?.error ?? 'Could not record the payment.');
      return fail(res.status, { paymentError: message });
    }
    redirect(303, `/purchases/${event.params.id}`);
  },

  delete: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.purchases[':id'].$delete({ param: { id: event.params.id } });
    if (res.status === 404) throw error(404, 'not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const message =
        body?.error === 'has_payments'
          ? "You've already recorded payments on this, so it can't be removed."
          : (body?.error ?? 'delete_failed');
      return fail(res.status, { deleteError: message });
    }
    redirect(303, '/purchases');
  },
};
