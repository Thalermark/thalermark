import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Direct fetch (not the typed hc client) so no session cookie / x-account-id
// leaks from a stray hydration — same posture as the public invoice page.
// Public route is gated only by the URL token.
const apiUrl = () =>
  privateEnv.INTERNAL_API_URL || publicEnv.PUBLIC_API_URL || 'http://localhost:3000';

export const load: PageServerLoad = async (event) => {
  const res = await event.fetch(`${apiUrl()}/api/public/estimates/${event.params.token}`);
  if (res.status === 404) throw error(404, 'estimate not found');
  if (!res.ok) throw error(res.status, 'failed to load estimate');
  const estimate = (await res.json()) as PublicEstimate;
  return { estimate };
};

// Accept / decline actions POST to the public API endpoints. The API
// returns 409 if the estimate is no longer in `sent` (a stale tab racing
// itself) — surface as a refresh hint rather than a hard error.
async function respond(event: Parameters<Actions[string]>[0], decision: 'accept' | 'decline') {
  const res = await event.fetch(
    `${apiUrl()}/api/public/estimates/${event.params.token}/${decision}`,
    { method: 'POST' },
  );
  if (res.status === 404) throw error(404, 'estimate not found');
  if (res.status === 409) {
    return fail(409, {
      formError: 'This estimate is no longer awaiting a response. Refresh the page.',
    });
  }
  if (!res.ok) {
    return fail(res.status, { formError: 'Could not record your response. Please try again.' });
  }
  // Re-load the page so the freshly-stamped status renders without the
  // client having to merge the action payload.
  redirect(303, `/e/${event.params.token}`);
}

export const actions: Actions = {
  accept: (event) => respond(event, 'accept'),
  decline: (event) => respond(event, 'decline'),
};

type PublicEstimateLine = {
  id: string;
  position: number;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  unitLabel: string | null;
  taxable: boolean;
  taxRatePct: string;
  taxAmount: string;
};

type PublicEstimate = {
  number: string;
  status: string;
  // Pulled back by the business to be corrected, not yet resent (TMC-227).
  beingRevised: boolean;
  revisions: { revisedAt: string; previousTotal: string }[];
  issueDate: string;
  expiresOn: string | null;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  notes: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  companyName: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyLogoUrl: string | null;
  customerName: string | null;
  lineItems: PublicEstimateLine[];
  canRespond: boolean;
};
