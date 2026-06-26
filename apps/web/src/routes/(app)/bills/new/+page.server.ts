import { pickActiveCompany } from '$lib/active-company';
import { serverApiClient, serverBillsApiClient } from '$lib/api.server';
import { NEW_CONTACT_SENTINEL, findEmailDupe } from '$lib/contact-dupes';
import { error, fail, redirect } from '@sveltejs/kit';
import { billCreateSchema, contactCreateSchema } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

type Account = { id: string; code: string; name: string };

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  const catRes = await client.api.companies[':id'].accounts.$get({
    param: { id: company.id },
    query: { type: 'expense' },
  });
  if (!catRes.ok) throw error(catRes.status, 'failed to load categories');
  const categories = (await catRes.json()).accounts.map((a: Account) => ({
    id: a.id,
    label: `${a.code} · ${a.name}`,
  }));

  return {
    categories,
    today: new Date().toISOString().slice(0, 10),
  };
};

type FormValues = {
  contactId: string;
  contactName: string;
  newContactName: string;
  newContactEmail: string;
  categoryAccountId: string;
  amount: string;
  billDate: string;
  dueDate: string;
  reference: string;
  memo: string;
};

function readForm(data: FormData): FormValues {
  return {
    contactId: String(data.get('contactId') ?? '').trim(),
    contactName: String(data.get('contactName') ?? '').trim(),
    newContactName: String(data.get('newContactName') ?? '').trim(),
    newContactEmail: String(data.get('newContactEmail') ?? '').trim(),
    categoryAccountId: String(data.get('categoryAccountId') ?? '').trim(),
    amount: String(data.get('amount') ?? '').trim(),
    billDate: String(data.get('billDate') ?? '').trim(),
    dueDate: String(data.get('dueDate') ?? '').trim(),
    reference: String(data.get('reference') ?? '').trim(),
    memo: String(data.get('memo') ?? '').trim(),
  };
}

function formErrorFor(code: string): string {
  switch (code) {
    case 'invalid_category_account':
      return 'That category is no longer a valid expense account. Pick another.';
    case 'contact_not_found':
      return 'That vendor could not be found. Pick another.';
    case 'company_not_found':
      return 'No company in this workspace.';
    default:
      return code;
  }
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const billsClient = serverBillsApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // companyId is resolved server-side (never trusted from the form).
    const companiesRes = await client.api.companies.$get();
    if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
    const { companies } = await companiesRes.json();
    const companyId = pickActiveCompany(event.cookies, companies)?.id;
    if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

    // Inline-create branch: the ContactPicker posts the sentinel when the user
    // chose "+ Add new contact". Create the vendor (is_vendor) first, then use
    // its id. Mirrors the invoice new-contact flow, with isVendor set.
    let resolvedContactId = values.contactId;
    let createdName: string | undefined;
    if (values.contactId === NEW_CONTACT_SENTINEL) {
      const parsedContact = contactCreateSchema.safeParse({
        companyId,
        name: values.newContactName,
        email: values.newContactEmail === '' ? undefined : values.newContactEmail,
        isVendor: true,
      });
      if (!parsedContact.success) {
        const contactErrors: Record<string, string> = {};
        for (const issue of parsedContact.error.issues) {
          const key = String(issue.path[0] ?? '_');
          if (!contactErrors[key]) contactErrors[key] = issue.message;
        }
        return fail(400, { values, contactErrors });
      }
      // Hard-block on an exact email dupe (same as the invoice flow).
      if (parsedContact.data.email) {
        const listRes = await client.api.contacts.$get({
          query: { companyId, q: parsedContact.data.email },
        });
        if (listRes.ok) {
          const { contacts: list } = await listRes.json();
          const emailDupe = findEmailDupe(parsedContact.data.email, list);
          if (emailDupe) {
            return fail(409, {
              values,
              contactErrors: { email: 'email_dupe' },
              dupeContact: { id: emailDupe.id, name: emailDupe.name },
            });
          }
        }
      }
      const custRes = await client.api.contacts.$post({ json: parsedContact.data });
      if (!custRes.ok) {
        const body = (await custRes.json().catch(() => null)) as { error?: string } | null;
        return fail(custRes.status, {
          values,
          contactErrors: { _: body?.error ?? 'contact_create_failed' },
        });
      }
      const created = await custRes.json();
      resolvedContactId = created.id;
      createdName = created.name;
    }

    const parsed = billCreateSchema.safeParse({
      companyId,
      contactId: resolvedContactId,
      categoryAccountId: values.categoryAccountId,
      amount: values.amount,
      billDate: values.billDate,
      dueDate: values.dueDate,
      reference: values.reference === '' ? undefined : values.reference,
      memo: values.memo === '' ? undefined : values.memo,
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      // Re-seed the picker with the freshly-created contact so a validation
      // bounce doesn't drop it.
      return fail(400, {
        values: createdName
          ? { ...values, contactId: resolvedContactId, contactName: createdName }
          : values,
        fieldErrors,
      });
    }

    const res = await billsClient.api.bills.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values: createdName
          ? { ...values, contactId: resolvedContactId, contactName: createdName }
          : values,
        formError: formErrorFor(body?.error ?? 'create_failed'),
      });
    }
    const created = await res.json();
    redirect(303, `/bills/${created.id}`);
  },
};
