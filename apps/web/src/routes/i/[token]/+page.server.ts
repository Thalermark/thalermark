import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Direct fetch — the typed hc client from $lib/api.server stamps the
// session cookie + x-account-id which we deliberately don't have here.
// Public route is gated only by the URL token, so a bare fetch keeps the
// shape honest (no headers leaking from a stray hydration).
const apiUrl = () =>
  privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

export const load: PageServerLoad = async (event) => {
  const res = await event.fetch(`${apiUrl()}/api/public/invoices/${event.params.token}`);
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) throw error(res.status, 'failed to load invoice');
  const invoice = (await res.json()) as PublicInvoice;
  return { invoice };
};

// Pay action: lazy-mints a Stripe Embedded Checkout session when the
// recipient actually clicks Pay (vs. on every passive page load — saves
// Stripe API quota and keeps the dashboard free of abandoned sessions).
// The page POSTs here via use:enhance, gets back clientSecret +
// publishableKey, and hands them to stripe.js' initEmbeddedCheckout.
export const actions: Actions = {
  createSession: async (event) => {
    const res = await event.fetch(
      `${apiUrl()}/api/public/invoices/${event.params.token}/checkout-session`,
      { method: 'POST' },
    );
    if (res.status === 503) {
      return fail(503, { formError: 'Payment is not configured for this invoice.' });
    }
    if (res.status === 409) {
      // Race: invoice no longer in `sent` (already paid, voided). The
      // load() snapshot the user saw is stale; a refresh shows the right
      // state.
      return fail(409, { formError: 'This invoice is no longer payable. Refresh the page.' });
    }
    if (!res.ok) {
      return fail(res.status, { formError: 'Could not start payment. Please try again.' });
    }
    const body = (await res.json()) as { clientSecret: string; publishableKey: string };
    return { clientSecret: body.clientSecret, publishableKey: body.publishableKey };
  },
};

type PublicInvoiceLine = {
  id: string;
  position: number;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
};

type PublicInvoice = {
  number: string;
  status: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  notes: string | null;
  sentAt: string | null;
  paidAt: string | null;
  companyName: string | null;
  customerName: string | null;
  lineItems: PublicInvoiceLine[];
  payable: boolean;
  connectPending: boolean;
};
