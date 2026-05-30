import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { companyUpdateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// First-run wizard. Captures the operator's business type and (optionally)
// renames the default company from the email/full-name fallback the signup
// hook seeded. Lives in (app) so the auth gate + activeAccountId resolution
// from hooks.server.ts kick in for free; the (app) layout server load
// REDIRECTS users in here when any of their companies still has
// businessType=null, so a fresh signup lands here automatically.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) throw error(res.status, 'failed to load companies');
  const { companies } = await res.json();
  // First unset company drives the wizard. Multi-company accounts that
  // accumulate more null business_types (e.g. via a future multi-company
  // create flow) will return here on next nav until each is filled in.
  const target = companies.find((c) => c.businessType === null) ?? companies[0];
  if (!target) throw redirect(303, '/select-company');
  return {
    company: { id: target.id, name: target.name, businessType: target.businessType },
  };
};

export const actions: Actions = {
  default: async (event) => {
    const data = await event.request.formData();
    const companyId = String(data.get('companyId') ?? '');
    const businessType = String(data.get('businessType') ?? '');
    const nameRaw = data.get('name');
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';

    const values = { businessType, name };

    if (!companyId) return fail(400, { values, formError: 'company_required' });

    const payload: Record<string, string> = { businessType };
    if (name) payload.name = name;

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
    throw redirect(303, '/');
  },
};
