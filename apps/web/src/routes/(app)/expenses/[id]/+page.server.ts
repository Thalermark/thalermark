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
  const expenseRes = await client.api.expenses[':id'].$get({ param: { id: event.params.id } });
  if (expenseRes.status === 404) throw error(404, 'expense not found');
  if (!expenseRes.ok) throw error(expenseRes.status, 'failed to load expense');
  const expense = await expenseRes.json();

  // Resolve the category + payment account ids to human labels. Best-effort:
  // a failed accounts fetch falls back to the raw ids rather than blanking
  // the page.
  const [expenseAccRes, assetAccRes] = await Promise.all([
    client.api.companies[':id'].accounts.$get({
      param: { id: expense.companyId },
      query: { type: 'expense' },
    }),
    client.api.companies[':id'].accounts.$get({
      param: { id: expense.companyId },
      query: { type: 'asset' },
    }),
  ]);
  const labelById = new Map<string, string>();
  if (expenseAccRes.ok) {
    for (const a of (await expenseAccRes.json()).accounts)
      labelById.set(a.id, `${a.code} · ${a.name}`);
  }
  if (assetAccRes.ok) {
    for (const a of (await assetAccRes.json()).accounts)
      labelById.set(a.id, `${a.code} · ${a.name}`);
  }

  // Audit trail (slice 8.8a pattern). Best-effort — a non-OK response renders
  // an empty history rather than failing the whole page.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'expense', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return {
    expense,
    categoryLabel: labelById.get(expense.categoryAccountId) ?? expense.categoryAccountId,
    paymentLabel: labelById.get(expense.paymentAccountId) ?? expense.paymentAccountId,
    auditEvents,
  };
};

export const actions: Actions = {
  // Soft delete (the API sets deleted_at + posts a reversal). Redirect to the
  // list, where the row no longer appears.
  delete: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.expenses[':id'].$delete({ param: { id: event.params.id } });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { deleteError: body?.error ?? 'delete_failed' });
    }
    redirect(303, '/expenses');
  },
};
