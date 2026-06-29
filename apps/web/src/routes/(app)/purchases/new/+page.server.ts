import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { capitalPurchaseCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');
  return { today: new Date().toISOString().slice(0, 10) };
};

type FormValues = {
  description: string;
  amount: string;
  purchaseDate: string;
  funding: string;
  downPayment: string;
  taxTreatment: string;
  vendorContactId: string;
};

function readForm(data: FormData): FormValues {
  return {
    description: String(data.get('description') ?? '').trim(),
    amount: String(data.get('amount') ?? '').trim(),
    purchaseDate: String(data.get('purchaseDate') ?? '').trim(),
    funding: String(data.get('funding') ?? '').trim(),
    downPayment: String(data.get('downPayment') ?? '').trim(),
    taxTreatment: String(data.get('taxTreatment') ?? '').trim(),
    vendorContactId: String(data.get('vendorContactId') ?? '').trim(),
  };
}

export const actions: Actions = {
  save: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

    // Down payment only matters when financed; the vendor link is optional. A
    // financed purchase with no down payment sends nothing (the API treats it
    // as 0).
    const financed = values.funding === 'financed';
    const parsed = capitalPurchaseCreateSchema.safeParse({
      companyId,
      description: values.description,
      amount: values.amount,
      purchaseDate: values.purchaseDate,
      funding: values.funding,
      downPayment: financed && values.downPayment !== '' ? values.downPayment : undefined,
      taxTreatment: values.taxTreatment,
      vendorContactId: values.vendorContactId !== '' ? values.vendorContactId : undefined,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return fail(400, { values, fieldErrors });
    }

    const res = await client.api.purchases.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { values, formError: body?.error ?? 'save_failed' });
    }
    const created = await res.json();
    redirect(303, `/purchases/${created.id}`);
  },
};
