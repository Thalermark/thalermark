import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api['tax-policies'][':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'tax policy not found');
  if (!res.ok) throw error(res.status, 'failed to load tax policy');
  const policy = await res.json();

  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'tax_policy', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return { policy, auditEvents };
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
    ? await client.api['tax-policies'][':id'].archive.$post({ param: { id } })
    : await client.api['tax-policies'][':id'].restore.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'tax policy not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      actionError: apiErrorMessage(body?.error, 'That did not work. Try again.', body),
    });
  }
  redirect(303, `/settings/tax-policies/${id}`);
}

export const actions: Actions = {
  archive: (event) => setArchived(event, true),
  restore: (event) => setArchived(event, false),
};
