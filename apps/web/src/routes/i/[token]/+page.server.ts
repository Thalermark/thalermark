import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

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
  companyAddress: string | null;
  companyPhone: string | null;
  companyLogoUrl: string | null;
  customerName: string | null;
  lineItems: PublicInvoiceLine[];
  payable: boolean;
  connectPending: boolean;
  offlinePayment: {
    cash: boolean;
    check: { payableTo: string | null; address: string | null } | null;
    venmo: string | null;
    zelle: string | null;
  } | null;
};
