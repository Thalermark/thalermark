import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.items[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'item not found');
  if (!res.ok) throw error(res.status, 'failed to load item');
  const item = await res.json();

  // Resolve the item's tax-policy name for display (best-effort — a deleted or
  // unreadable policy degrades to null and the detail shows "Company default").
  let taxPolicy: { name: string; ratePct: string } | null = null;
  if (item.taxPolicyId) {
    const polRes = await client.api['tax-policies'][':id'].$get({
      param: { id: item.taxPolicyId },
    });
    if (polRes.ok) {
      const p = await polRes.json();
      taxPolicy = { name: p.name, ratePct: p.ratePct };
    }
  }

  // Per-entity history sidebar — best-effort; a non-OK degrades to empty.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'item', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return { item, taxPolicy, auditEvents };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};

async function setArchived(event: Parameters<Actions[string]>[0], archived: boolean) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res = archived
    ? await client.api.items[':id'].archive.$post({ param: { id } })
    : await client.api.items[':id'].restore.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'item not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      actionError: apiErrorMessage(body?.error, 'That did not work. Try again.', body),
    });
  }
  redirect(303, `/items/${id}`);
}

export const actions: Actions = {
  archive: (event) => setArchived(event, true),
  restore: (event) => setArchived(event, false),
};
