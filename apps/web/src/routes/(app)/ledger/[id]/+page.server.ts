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
  const res = await client.api.ledger.entries[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'not found');
  if (!res.ok) throw error(res.status, 'failed to load');
  const entry = await res.json();

  // Audit trail (same pattern as the other detail pages). Best-effort — a
  // non-OK response renders an empty history rather than failing the page.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'manual_adjustment', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return { entry, auditEvents };
};

export const actions: Actions = {
  // Post the reversing entry. The API guards already-reversed (409) and a
  // non-manual id (404); on success we reload the page, now showing the
  // reversed state (the original is immutable — this is the only "undo").
  reverse: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.ledger.entries[':id'].reverse.$post({
      param: { id: event.params.id },
    });
    if (res.status === 404) throw error(404, 'not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        reverseError: apiErrorMessage(
          body?.error,
          'That entry could not be reversed. Try again.',
          body,
        ),
      });
    }
    redirect(303, `/ledger/${event.params.id}`);
  },
};
