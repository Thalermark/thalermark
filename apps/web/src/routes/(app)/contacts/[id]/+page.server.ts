import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.contacts[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'contact not found');
  if (!res.ok) throw error(res.status, 'failed to load contact');
  const contact = await res.json();

  // Audit trail (8.8a) + customer insights — both best-effort read-only
  // sidebars; a non-OK response degrades to empty/null rather than failing the
  // page. A slow aggregate must never take the contact page down with it.
  //
  // `insights` carries the reliability figures, so payment-reliability is no
  // longer fetched here — same object, same field names, produced by the same
  // code on the server.
  const [auditRes, insightsRes] = await Promise.all([
    client.api['audit-events'].$get({
      query: { entityType: 'contact', entityId: event.params.id },
    }),
    client.api.contacts[':id'].insights.$get({ param: { id: event.params.id } }),
  ]);
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];
  const insights = insightsRes.ok ? await insightsRes.json() : null;

  return { contact, auditEvents, insights, reliability: insights?.reliability ?? null };
};

// Archive / restore from the detail page. Redirects back to the same page
// rather than the list: the user is looking at this contact, and the change is
// reversible from the button that replaces the one they just pressed.
async function setArchived(event: Parameters<Actions[string]>[0], archived: boolean) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res = archived
    ? await client.api.contacts[':id'].archive.$post({ param: { id } })
    : await client.api.contacts[':id'].restore.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'contact not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      actionError: apiErrorMessage(body?.error, 'That did not work. Try again.', body),
    });
  }
  redirect(303, `/contacts/${id}`);
}

export const actions: Actions = {
  archive: (event) => setArchived(event, true),
  restore: (event) => setArchived(event, false),
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};
