import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { fail, redirect } from '@sveltejs/kit';
import { companyUpdateSchema } from '@thalermark/validation';
import type { Actions } from './$types';

// Step 1 — Your business. Name + business type are required (they replace the
// signup fallback that named the company after the person); address, phone and
// email are optional. Setting businessType here satisfies the (app) first-run
// gate, so the rest of the wizard is genuinely optional.
//
// businessEmail earns its place here rather than staying buried in settings
// (TMC-225): it is where a customer's reply to an invoice goes, and until it is
// set those replies land on the platform's address instead of the business's.
// Asking once, at the only moment everyone passes through, is what keeps the
// fallback chain from ever mattering.
export const actions: Actions = {
  default: async (event) => {
    const data = await event.request.formData();
    const companyId = String(data.get('companyId') ?? '');
    const businessType = String(data.get('businessType') ?? '');
    const name = String(data.get('name') ?? '').trim();
    const businessAddress = String(data.get('businessAddress') ?? '').trim();
    const businessPhone = String(data.get('businessPhone') ?? '').trim();
    const businessEmail = String(data.get('businessEmail') ?? '').trim();

    const values = { name, businessType, businessAddress, businessPhone, businessEmail };
    if (!companyId) return fail(400, { values, formError: 'Choose a business first.' });

    // Sparse payload, same idiom as the settings PATCH: only send keys we mean
    // to set. name + businessType are always present (required); the optional
    // contact fields are sent as '' when blank so the schema coerces them to
    // null (clearing a previously-typed value if the user backs up and edits).
    const payload = { name, businessType, businessAddress, businessPhone, businessEmail };
    const parsed = companyUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const client = serverApiClient(event);
    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: parsed.data,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    throw redirect(303, '/welcome/paid');
  },
};
