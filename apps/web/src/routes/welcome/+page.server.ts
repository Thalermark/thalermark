import { serverApiClient } from '$lib/api.server';
import { fail, redirect } from '@sveltejs/kit';
import { companyUpdateSchema } from '@thalermark/validation';
import type { Actions } from './$types';

// Step 1 — Your business. Name + business type are required (they replace the
// signup fallback that named the company after the person); address + phone are
// optional and only show on invoices. Setting businessType here satisfies the
// (app) first-run gate, so the rest of the wizard is genuinely optional.
export const actions: Actions = {
  default: async (event) => {
    const data = await event.request.formData();
    const companyId = String(data.get('companyId') ?? '');
    const businessType = String(data.get('businessType') ?? '');
    const name = String(data.get('name') ?? '').trim();
    const businessAddress = String(data.get('businessAddress') ?? '').trim();
    const businessPhone = String(data.get('businessPhone') ?? '').trim();

    const values = { name, businessType, businessAddress, businessPhone };
    if (!companyId) return fail(400, { values, formError: 'company_required' });

    // Sparse payload, same idiom as the settings PATCH: only send keys we mean
    // to set. name + businessType are always present (required); the optional
    // contact fields are sent as '' when blank so the schema coerces them to
    // null (clearing a previously-typed value if the user backs up and edits).
    const payload = { name, businessType, businessAddress, businessPhone };
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
      return fail(res.status, { values, formError: body?.error ?? 'update_failed' });
    }
    throw redirect(303, '/welcome/paid');
  },
};
