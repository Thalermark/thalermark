import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error, fail } from '@sveltejs/kit';
import {
  MAX_REMINDER_OFFSET,
  MAX_REMINDER_STAGES,
  MIN_REMINDER_OFFSET,
} from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();

  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // Split the stored signed offsets into the two groups the screen shows. The
  // user never sees a minus sign — "before it's due" and "after it's due" carry
  // the sign, the same way the refund control offers a direction rather than
  // asking anyone to type a negative number.
  const offsets = company.reminderOffsets ?? [];
  return {
    company,
    before: offsets.filter((d) => d < 0).map((d) => Math.abs(d)),
    after: offsets.filter((d) => d >= 0),
    limits: {
      maxStages: MAX_REMINDER_STAGES,
      minOffset: MIN_REMINDER_OFFSET,
      maxOffset: MAX_REMINDER_OFFSET,
    },
  };
};

// Re-joins the two groups into the signed array the API stores. Days are read as
// positive numbers from both groups and the sign comes from which group they
// were in — so "5" under "before it's due" becomes -5.
function toOffsets(form: FormData): number[] {
  const read = (key: string, sign: number) =>
    form
      .getAll(key)
      .map((v) => Number.parseInt(String(v), 10))
      .filter((n) => Number.isFinite(n))
      .map((n) => sign * Math.abs(n));
  return [...read('before', -1), ...read('after', 1)];
}

export const actions: Actions = {
  save: async (event) => {
    const client = serverApiClient(event);
    const form = await event.request.formData();
    const companyId = String(form.get('companyId') ?? '');
    if (!companyId) return fail(400, { saveError: 'missing_company_id' });

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: {
        remindersEnabled: form.get('remindersEnabled') === 'on',
        reminderOffsets: toOffsets(form),
      },
    });
    if (!res.ok) {
      // The API is the authority on the caps — a duplicate day, too many
      // stages, or one out of range all land here rather than being
      // re-validated in two places that can disagree.
      return fail(res.status, { saveError: 'save_failed' });
    }
    return { saved: true };
  },
};
