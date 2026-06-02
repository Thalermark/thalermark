import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.customers[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'customer not found');
  if (!res.ok) throw error(res.status, 'failed to load customer');
  const customer = await res.json();

  // Audit trail (8.8a) + payment reliability (late-payer detection) — both
  // best-effort read-only sidebars; a non-OK response degrades to empty/null
  // rather than failing the page.
  const [auditRes, reliabilityRes] = await Promise.all([
    client.api['audit-events'].$get({
      query: { entityType: 'customer', entityId: event.params.id },
    }),
    client.api.customers[':id']['payment-reliability'].$get({ param: { id: event.params.id } }),
  ]);
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];
  const reliability = reliabilityRes.ok ? await reliabilityRes.json() : null;

  return { customer, auditEvents, reliability };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};
