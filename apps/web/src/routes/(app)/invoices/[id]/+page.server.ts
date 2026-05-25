import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const invoiceRes = await client.api.invoices[':id'].$get({ param: { id: event.params.id } });
  if (invoiceRes.status === 404) throw error(404, 'invoice not found');
  if (!invoiceRes.ok) throw error(invoiceRes.status, 'failed to load invoice');
  const invoice = await invoiceRes.json();

  const customerRes = await client.api.customers[':id'].$get({
    param: { id: invoice.customerId },
  });
  const customer = customerRes.ok ? await customerRes.json() : null;

  // After a successful send, the action redirects back with ?sent=<email>.
  // Read it here so the success banner survives the post/redirect without a
  // session flash; the URL stays one-shot (refresh clears it).
  const sentTo = event.url.searchParams.get('sent');

  // origin is what the recipient will see in the URL — derived from the
  // incoming request so it works behind any reverse-proxy / custom domain
  // without an extra env var. Passed alongside the invoice so the share
  // panel can render the full absolute URL the user copies.
  return { invoice, customer, origin: event.url.origin, sentTo };
};

// Status-transition actions. Each posts to the matching API endpoint and
// redirects back to the detail page so the new status renders on the next
// load. Action-failure surfaces a single `transitionError` so the page can
// banner it without needing per-action form state. Plain HTML POST — no
// use:enhance, in line with the rest of the app's no-JS path.
async function runTransition(
  event: Parameters<Actions[string]>[0],
  endpoint: 'mark-sent' | 'mark-paid' | 'void',
) {
  const client = serverApiClient(event);
  const id = event.params.id;
  const res =
    endpoint === 'mark-sent'
      ? await client.api.invoices[':id']['mark-sent'].$post({ param: { id } })
      : endpoint === 'mark-paid'
        ? await client.api.invoices[':id']['mark-paid'].$post({ param: { id } })
        : await client.api.invoices[':id'].void.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return fail(res.status, { transitionError: body?.error ?? 'transition_failed' });
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

export const actions: Actions = {
  send: runSend,
  markSent: (event) => runTransition(event, 'mark-sent'),
  markPaid: (event) => runTransition(event, 'mark-paid'),
  void: (event) => runTransition(event, 'void'),
};
