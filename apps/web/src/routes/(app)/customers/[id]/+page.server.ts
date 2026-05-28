import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.customers[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'customer not found');
  if (!res.ok) throw error(res.status, 'failed to load customer');
  const customer = await res.json();

  // Audit trail (slice 8.8a). Best-effort: a non-OK response renders an
  // empty history rather than failing the whole page — the trail is a
  // read-only sidebar to the record, not load-bearing for editing.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'customer', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return { customer, auditEvents };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};
