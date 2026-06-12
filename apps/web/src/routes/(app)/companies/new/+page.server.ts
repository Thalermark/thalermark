import { setActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { may } from '$lib/perms';
import { fail, redirect } from '@sveltejs/kit';
import { companyCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Guard the page itself to match the API gate (settings:manage = owner/admin),
// so a member never lands on a form whose submit would only 403. The API stays
// authoritative; this is UX so the control isn't a dead end.
export const load: PageServerLoad = async (event) => {
  if (!may(event.locals.role, 'settings:manage')) throw redirect(303, '/');
  return {};
};

export const actions: Actions = {
  default: async (event) => {
    const data = await event.request.formData();
    const name = String(data.get('name') ?? '').trim();
    const businessType = String(data.get('businessType') ?? '');
    const values = { name, businessType };

    const parsed = companyCreateSchema.safeParse({ name, businessType });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const client = serverApiClient(event);
    const res = await client.api.companies.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { values, formError: body?.error ?? 'create_failed' });
    }
    // Switch to the new company so the user lands inside it.
    const created = (await res.json()) as { id: string };
    setActiveCompany(event.cookies, created.id);
    throw redirect(303, '/');
  },
};
