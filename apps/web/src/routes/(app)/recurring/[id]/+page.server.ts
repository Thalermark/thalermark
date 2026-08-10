import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const scheduleRes = await client.api['recurring-invoices'][':id'].$get({
    param: { id: event.params.id },
  });
  if (scheduleRes.status === 404) throw error(404, 'recurring schedule not found');
  if (!scheduleRes.ok) throw error(scheduleRes.status, 'failed to load recurring schedule');
  const schedule = await scheduleRes.json();

  const contactRes = await client.api.contacts[':id'].$get({
    param: { id: schedule.contactId },
  });
  const contact = contactRes.ok ? await contactRes.json() : null;

  // After run-now, the action redirects back with ?ran=<invoiceId> so the
  // success banner survives the post/redirect (same pattern as invoice ?sent).
  const ranInvoiceId = event.url.searchParams.get('ran');

  // Audit trail (best-effort) — the per-entity history for this schedule.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'recurring_invoice', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  return { schedule, contact, ranInvoiceId, auditEvents };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};

// Status transitions. Each posts to the matching endpoint and redirects back so
// the new status renders on the next load. Plain HTML POST, no use:enhance — in
// line with the rest of the app.
async function runTransition(
  event: Parameters<Actions[string]>[0],
  endpoint: 'pause' | 'resume' | 'end',
) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res =
    endpoint === 'pause'
      ? await client.api['recurring-invoices'][':id'].pause.$post({ param: { id } })
      : endpoint === 'resume'
        ? await client.api['recurring-invoices'][':id'].resume.$post({ param: { id } })
        : await client.api['recurring-invoices'][':id'].end.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'recurring schedule not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(body?.error, 'That could not be changed. Try again.', body),
    });
  }
  redirect(303, `/recurring/${id}`);
}

// Generate the next invoice now. On success the API returns { invoiceId };
// redirect back with ?ran=<id> so the banner links to the new invoice.
async function runNow(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res = await client.api['recurring-invoices'][':id']['run-now'].$post({ param: { id } });
  if (res.status === 404) throw error(404, 'recurring schedule not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(body?.error, 'That could not be run. Try again.', body),
    });
  }
  const { invoiceId } = (await res.json()) as { invoiceId: string };
  redirect(303, `/recurring/${id}?ran=${encodeURIComponent(invoiceId)}`);
}

export const actions: Actions = {
  pause: (event) => runTransition(event, 'pause'),
  resume: (event) => runTransition(event, 'resume'),
  end: (event) => runTransition(event, 'end'),
  runNow,
};
