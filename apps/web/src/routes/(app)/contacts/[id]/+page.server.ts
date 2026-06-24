import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.contacts[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'contact not found');
  if (!res.ok) throw error(res.status, 'failed to load contact');
  const contact = await res.json();

  // Audit trail (8.8a) + payment reliability (late-payer detection) — both
  // best-effort read-only sidebars; a non-OK response degrades to empty/null
  // rather than failing the page.
  const [auditRes, reliabilityRes] = await Promise.all([
    client.api['audit-events'].$get({
      query: { entityType: 'contact', entityId: event.params.id },
    }),
    client.api.contacts[':id']['payment-reliability'].$get({ param: { id: event.params.id } }),
  ]);
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];
  const reliability = reliabilityRes.ok ? await reliabilityRes.json() : null;

  return { contact, auditEvents, reliability };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};
