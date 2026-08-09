import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Direct fetch (no hc client) for the same reason as the public invoice view:
// this route is gated only by the URL token, so we deliberately send no session
// cookie or x-account-id.
const apiUrl = () =>
  privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

export const load: PageServerLoad = async (event) => {
  const { token } = event.params;

  const res = await event.fetch(`${apiUrl()}/api/public/invoices/${token}`);
  if (res.status === 404) throw error(404, 'invoice not found');
  if (!res.ok) throw error(res.status, 'failed to load invoice');
  const invoice = (await res.json()) as PublicInvoice;

  // Not payable (already paid, voided, Stripe unconfigured, or Connect still
  // onboarding) — bounce to the invoice view, which renders the right state.
  if (!invoice.payable) throw redirect(303, `/i/${token}`);

  // Mint the PaymentIntent now. Landing on /pay is the click-equivalent the old
  // embedded flow gated on, so this stays lazy vs. minting on every invoice view.
  const piRes = await event.fetch(`${apiUrl()}/api/public/invoices/${token}/payment-intent`, {
    method: 'POST',
  });
  // 409 (no longer sent) / 503 (Stripe or Connect not ready): the load() snapshot
  // is stale or the company isn't payable after all — fall back to the invoice view.
  if (!piRes.ok) throw redirect(303, `/i/${token}`);
  const pi = (await piRes.json()) as {
    clientSecret: string;
    publishableKey: string;
    stripeAccountId: string | null;
    amount: string;
    currency: string;
  };

  return {
    token,
    invoice,
    clientSecret: pi.clientSecret,
    publishableKey: pi.publishableKey,
    stripeAccountId: pi.stripeAccountId,
    // What the intent will actually charge — the outstanding balance, not the
    // invoice total. Taken from the mint response so the page can never print a
    // different number than the one Stripe is about to take (TMC-210).
    amount: pi.amount,
    currency: pi.currency,
  };
};

type PublicInvoice = {
  number: string;
  currency: string;
  total: string;
  paid: string;
  outstanding: string;
  companyName: string | null;
  customerName: string | null;
  payable: boolean;
};
