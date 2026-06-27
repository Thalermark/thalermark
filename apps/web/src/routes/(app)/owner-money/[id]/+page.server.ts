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
  const res = await client.api['owner-money'][':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'not found');
  if (!res.ok) throw error(res.status, 'failed to load');
  const ev = await res.json();

  // Audit trail (slice 8.8a pattern). Best-effort — a non-OK response renders
  // an empty history rather than failing the whole page.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'owner_money_event', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return { event: ev, auditEvents };
};

export const actions: Actions = {
  // Soft delete (the API sets deleted_at + posts a reversal). Redirect to the
  // list, where the row no longer appears.
  delete: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api['owner-money'][':id'].$delete({ param: { id: event.params.id } });
    if (res.status === 404) throw error(404, 'not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { deleteError: body?.error ?? 'delete_failed' });
    }
    redirect(303, '/owner-money');
  },
};
