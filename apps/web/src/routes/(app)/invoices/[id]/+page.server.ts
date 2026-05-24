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

  return { invoice, customer };
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

export const actions: Actions = {
  markSent: (event) => runTransition(event, 'mark-sent'),
  markPaid: (event) => runTransition(event, 'mark-paid'),
  void: (event) => runTransition(event, 'void'),
};
