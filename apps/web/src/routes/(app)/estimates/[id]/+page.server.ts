import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const estimateRes = await client.api.estimates[':id'].$get({ param: { id: event.params.id } });
  if (estimateRes.status === 404) throw error(404, 'estimate not found');
  if (!estimateRes.ok) throw error(estimateRes.status, 'failed to load estimate');
  const estimate = await estimateRes.json();

  const contactRes = await client.api.contacts[':id'].$get({
    param: { id: estimate.contactId },
  });
  const contact = contactRes.ok ? await contactRes.json() : null;

  // After a successful send, the action redirects back with ?sent=<email>
  // so the success banner survives the post/redirect without a session
  // flash. Same pattern as the invoice detail page (8.5b).
  const sentTo = event.url.searchParams.get('sent');
  const sendUndelivered = event.url.searchParams.get('undelivered') === '1';

  // Audit trail (slice 8.8a). Best-effort: a non-OK response renders an
  // empty history rather than failing the whole page.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'estimate', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  // origin derives from the incoming request so the share URL works behind
  // any proxy. Same pattern as the invoice detail page (8.5a).
  return { estimate, contact, origin: event.url.origin, sentTo, sendUndelivered, auditEvents };
};

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};

// Status-transition actions. Each posts to the matching API endpoint and
// redirects back so the new status renders on the next load. Plain HTML
// POST — no use:enhance, in line with the rest of the app.
async function runTransition(
  event: Parameters<Actions[string]>[0],
  endpoint: 'mark-sent' | 'mark-accepted' | 'mark-declined',
) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res =
    endpoint === 'mark-sent'
      ? await client.api.estimates[':id']['mark-sent'].$post({ param: { id } })
      : endpoint === 'mark-accepted'
        ? await client.api.estimates[':id']['mark-accepted'].$post({ param: { id } })
        : await client.api.estimates[':id']['mark-declined'].$post({ param: { id } });
  if (res.status === 404) throw error(404, 'estimate not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(body?.error, 'That could not be changed. Try again.', body),
    });
  }
  redirect(303, `/estimates/${id}`);
}

// /send is the primary CTA for getting an estimate in front of the contact:
// it transitions draft → sent AND emails the recipient with the public
// /e/<token> link. /mark-sent stays for the "delivered out-of-band" case
// (handed off in person). Plain HTML POST with an optional `to` override.
async function runSend(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const toRaw = formData.get('to');
  const to = typeof toRaw === 'string' && toRaw.trim() ? toRaw.trim() : undefined;
  const res = await client.api.estimates[':id'].send.$post({
    param: { id },
    json: to ? { to } : {},
  });
  if (res.status === 404) throw error(404, 'estimate not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(body?.error, 'That could not be sent. Try again.', body),
    });
  }
  const body = (await res.json()) as { sentTo?: string; delivered?: boolean };
  // Only the negative case rides the URL, so an ordinary send is unchanged.
  // See the invoice send action for why this exists (TMC-212).
  const qs = body.sentTo
    ? `?sent=${encodeURIComponent(body.sentTo)}${body.delivered === false ? '&undelivered=1' : ''}`
    : '';
  redirect(303, `/estimates/${id}${qs}`);
}

// Convert is a link action, not a status transition — slice 8.7d. Gated to
// accepted estimates server-side; idempotent (a re-call returns the existing
// invoice id). On either 201 (new) or 200 (already converted) the API returns
// `{ id }` and we redirect straight to the new invoice's detail page.
async function runConvert(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res = await client.api.estimates[':id'].convert.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'estimate not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(
        body?.error,
        'That could not be turned into an invoice. Try again.',
        body,
      ),
    });
  }
  const { id: invoiceId } = (await res.json()) as { id: string };
  redirect(303, `/invoices/${invoiceId}`);
}

// Duplicate-as-template: clone this estimate into a fresh draft and land on its
// edit page so the user tweaks before sending. Available for any status.
async function runDuplicate(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const res = await client.api.estimates[':id'].duplicate.$post({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'estimate not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, {
      transitionError: apiErrorMessage(
        body?.error,
        'That could not be duplicated. Try again.',
        body,
      ),
    });
  }
  const { id } = (await res.json()) as { id: string };
  redirect(303, `/estimates/${id}/edit`);
}

export const actions: Actions = {
  send: runSend,
  markSent: (event) => runTransition(event, 'mark-sent'),
  markAccepted: (event) => runTransition(event, 'mark-accepted'),
  markDeclined: (event) => runTransition(event, 'mark-declined'),
  convert: (event) => runConvert(event),
  duplicate: runDuplicate,
};
