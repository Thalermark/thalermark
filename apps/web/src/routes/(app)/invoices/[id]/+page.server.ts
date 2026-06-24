import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const invoiceRes = await client.api.invoices[':id'].$get({ param: { id: event.params.id } });
  if (invoiceRes.status === 404) throw error(404, 'invoice not found');
  if (!invoiceRes.ok) throw error(invoiceRes.status, 'failed to load invoice');
  const invoice = await invoiceRes.json();

  const contactRes = await client.api.contacts[':id'].$get({
    param: { id: invoice.contactId },
  });
  const contact = contactRes.ok ? await contactRes.json() : null;

  // Just-in-time prompt: a draft invoice is the moment a missing business
  // address actually costs the user something (it won't show on what the
  // contact sees). State-driven like the dashboard nudge — surfaces while
  // the address is unset, resolves itself once filled. Best-effort: a failed
  // companies fetch just drops the prompt rather than blocking the page.
  const companiesRes = await client.api.companies.$get();
  const companies = companiesRes.ok ? (await companiesRes.json()).companies : [];
  const company =
    companies.find((c) => c.id === invoice.companyId) ??
    pickActiveCompany(event.cookies, companies) ??
    null;
  const needsBusinessDetails = !!company && !company.businessAddress;
  const businessCompanyId = company?.id ?? null;

  // After a successful send, the action redirects back with ?sent=<email>.
  // Read it here so the success banner survives the post/redirect without a
  // session flash; the URL stays one-shot (refresh clears it).
  const sentTo = event.url.searchParams.get('sent');

  // Audit trail (slice 8.8a). Best-effort: a non-OK response renders an
  // empty history rather than failing the whole page.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'invoice', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  // origin is what the recipient will see in the URL — derived from the
  // incoming request so it works behind any reverse-proxy / custom domain
  // without an extra env var. Passed alongside the invoice so the share
  // panel can render the full absolute URL the user copies.
  return {
    invoice,
    contact,
    origin: event.url.origin,
    sentTo,
    auditEvents,
    needsBusinessDetails,
    businessCompanyId,
  };
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
// redirects back to the detail page so the new status renders on the next
// load. Action-failure surfaces a single `transitionError` so the page can
// banner it without needing per-action form state. Plain HTML POST — no
// use:enhance, in line with the rest of the app's no-JS path.
async function runTransition(
  event: Parameters<Actions[string]>[0],
  endpoint: 'mark-sent' | 'void',
) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res =
    endpoint === 'mark-sent'
      ? await client.api.invoices[':id']['mark-sent'].$post({ param: { id } })
      : await client.api.invoices[':id'].void.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { transitionError: body?.error ?? 'transition_failed' });
  }
  redirect(303, `/invoices/${id}`);
}

// mark-paid (fresh) and edit-payment (on an already-paid invoice) share the
// same payload from PaymentFields — method + optional reference + optional
// paidOn — and differ only in endpoint. The $post call is branched (not a
// dynamic index) so the typed client keeps its per-route signatures; the
// method set is fixed by the markup so the enum cast is safe.
async function postPayment(
  event: Parameters<Actions[string]>[0],
  endpoint: 'mark-paid' | 'edit-payment',
) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const method = String(formData.get('method') ?? 'cash') as
    | 'cash'
    | 'check'
    | 'venmo'
    | 'zelle'
    | 'other';
  const referenceRaw = formData.get('reference');
  const reference =
    typeof referenceRaw === 'string' && referenceRaw.trim() ? referenceRaw.trim() : undefined;
  const paidOnRaw = formData.get('paidOn');
  const paidOn = typeof paidOnRaw === 'string' && paidOnRaw.trim() ? paidOnRaw.trim() : undefined;
  const json = { method, reference, paidOn };
  const res =
    endpoint === 'mark-paid'
      ? await client.api.invoices[':id']['mark-paid'].$post({ param: { id }, json })
      : await client.api.invoices[':id']['edit-payment'].$post({ param: { id }, json });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { transitionError: body?.error ?? `${endpoint}_failed` });
  }
  redirect(303, `/invoices/${id}`);
}

// /send is the primary CTA — it transitions draft → sent AND emails the
// recipient. /mark-sent stays for the "sent out-of-band" case (paper /
// in-person handoff). Action posts FormData so the no-JS path works; we
// extract the optional `to` override and pass it to the typed RPC client.
// On success we redirect with ?sent=<address> so the detail page can
// banner the success without persisting state.
async function runSend(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const toRaw = formData.get('to');
  const to = typeof toRaw === 'string' && toRaw.trim() ? toRaw.trim() : undefined;
  const res = await client.api.invoices[':id'].send.$post({
    param: { id },
    json: to ? { to } : {},
  });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { transitionError: body?.error ?? 'send_failed' });
  }
  const body = (await res.json()) as { sentTo?: string };
  const qs = body.sentTo ? `?sent=${encodeURIComponent(body.sentTo)}` : '';
  redirect(303, `/invoices/${id}${qs}`);
}

// Duplicate-as-template: clone this invoice into a fresh draft and land on its
// edit page so the user tweaks before sending. Available for any status.
async function runDuplicate(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const res = await client.api.invoices[':id'].duplicate.$post({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { transitionError: body?.error ?? 'duplicate_failed' });
  }
  const { id } = (await res.json()) as { id: string };
  redirect(303, `/invoices/${id}/edit`);
}

// Just-in-time business details: saves the address (+ optional phone) the
// draft prompt collects, then redirects back to the invoice so the user
// continues straight to sending. PATCHes the same company endpoint Settings →
// Business uses; empty input is a no-op clear (the prompt simply persists).
async function runAddBusinessDetails(event: Parameters<Actions[string]>[0]) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const formData = await event.request.formData();
  const companyId = String(formData.get('companyId') ?? '');
  const businessAddress = String(formData.get('businessAddress') ?? '').trim();
  const businessPhone = String(formData.get('businessPhone') ?? '').trim();
  if (!companyId) return fail(400, { transitionError: 'missing_company_id' });

  const res = await client.api.companies[':id'].$patch({
    param: { id: companyId },
    json: { businessAddress, businessPhone },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { transitionError: body?.error ?? 'save_failed' });
  }
  redirect(303, `/invoices/${id}`);
}

export const actions: Actions = {
  send: runSend,
  addBusinessDetails: runAddBusinessDetails,
  markSent: (event) => runTransition(event, 'mark-sent'),
  markPaid: (event) => postPayment(event, 'mark-paid'),
  void: (event) => runTransition(event, 'void'),
  editPayment: (event) => postPayment(event, 'edit-payment'),
  duplicate: runDuplicate,
};
