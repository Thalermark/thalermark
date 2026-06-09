import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Account-wide audit feed (slice 8.8b). Pulls the same endpoint the
// per-entity History sections use, but with no entity filter — the API
// returns up to `limit` rows desc by createdAt and enriches each with an
// `entityLabel` so the page can render "Invoice INV-0042" without
// per-row lookups.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api['audit-events'].$get({ query: { limit: '50' } });
  if (!res.ok) throw error(res.status, 'failed to load activity');
  const { events, nextCursor } = (await res.json()) as {
    events: AuditEvent[];
    nextCursor: string | null;
  };
  return { events, nextCursor };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
  entityType?: string;
  entityId?: string;
  entityLabel?: string | null;
};
