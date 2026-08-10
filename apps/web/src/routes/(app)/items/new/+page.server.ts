import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { itemCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Optional fields whose empty string collapses to undefined before zod parsing
// — a blank unit price / quantity means "use the default", not "fail the
// money regex". The API then defaults unit_price to '0' and quantity to '1'.
const OPTIONAL_FIELDS = ['description', 'unitPrice', 'unitLabel', 'defaultQuantity'] as const;

// Active tax policies for the taxable-item policy picker. Scoped to the active
// company; archived policies are filtered out server-side.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const { activeCompanyId } = await event.parent();
  const query: Record<string, string> = { limit: '100' };
  if (activeCompanyId) query.companyId = activeCompanyId;
  const res = await client.api['tax-policies'].$get({ query });
  const taxPolicies = res.ok ? (await res.json()).taxPolicies : [];
  return { taxPolicies };
};

function readForm(data: FormData): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  out.name = String(data.get('name') ?? '').trim();
  for (const k of OPTIONAL_FIELDS) {
    const raw = data.get(k);
    if (typeof raw === 'string' && raw.trim() !== '') out[k] = raw.trim();
  }
  // Product vs service. The select always submits one of the two; anything else
  // collapses to undefined so the DB default ('service') applies.
  const type = String(data.get('type') ?? '');
  if (type === 'product' || type === 'service') out.type = type;
  // Taxable + its policy. A non-taxable item carries no policy; only attach the
  // selected policy when taxable so the data can't disagree with the toggle.
  out.taxable = data.get('taxable') === 'on';
  const policyId = String(data.get('taxPolicyId') ?? '');
  if (out.taxable && policyId) out.taxPolicyId = policyId;
  return out;
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // Auto-pick the only company for MVP single-company users — same pattern
    // as /contacts/new. The multi-company picker UX is deferred.
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const first = pickActiveCompany(event.cookies, companies);
    if (!first) return fail(400, { values, formError: 'No company in this workspace.' });

    const parsed = itemCreateSchema.safeParse({ companyId: first.id, ...values });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.items.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be created. Try again.', body),
      });
    }
    const created = await res.json();
    redirect(303, `/items/${created.id}`);
  },
};
