import { serverApiClient } from '$lib/api.server';
import { fail, redirect } from '@sveltejs/kit';
import { companyUpdateSchema } from '@thalermark/validation';
import type { Actions } from './$types';

// Step 2 — Getting paid. Optional: the manual methods (cash/check/Venmo/Zelle)
// that print as instructions on the public invoice. Stripe Connect is NOT here —
// it's a multi-minute external onboarding that would stall the wizard; we point
// at Settings for it instead. "Skip for now" is a plain link to Step 3, so this
// action only runs when the user actually saves.
export const actions: Actions = {
  default: async (event) => {
    const data = await event.request.formData();
    const companyId = String(data.get('companyId') ?? '');
    if (!companyId) return fail(400, { formError: 'company_required' });

    // Checkboxes arrive as 'on' / absent → coerce to real booleans. The text
    // fields go through as '' when blank so the schema clears them to null.
    const payload = {
      paymentCashEnabled: data.get('paymentCashEnabled') === 'on',
      paymentCheckEnabled: data.get('paymentCheckEnabled') === 'on',
      paymentCheckPayableTo: String(data.get('paymentCheckPayableTo') ?? '').trim(),
      paymentCheckAddress: String(data.get('paymentCheckAddress') ?? '').trim(),
      paymentVenmoHandle: String(data.get('paymentVenmoHandle') ?? '').trim(),
      paymentZelleContact: String(data.get('paymentZelleContact') ?? '').trim(),
    };

    const parsed = companyUpdateSchema.safeParse(payload);
    if (!parsed.success) return fail(400, { formError: 'invalid' });

    const client = serverApiClient(event);
    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: parsed.data,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { formError: body?.error ?? 'update_failed' });
    }
    throw redirect(303, '/welcome/brand');
  },
};
