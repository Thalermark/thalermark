import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
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

  const [catRes, moneyRes] = await Promise.all([
    client.api.companies[':id'].accounts.$get({
      param: { id: company.id },
      query: { type: 'expense' },
    }),
    client.api['money-accounts'].$get({ query: { companyId: company.id } }),
  ]);
  if (!catRes.ok) throw error(catRes.status, 'failed to load categories');
  const categories = (await catRes.json()).accounts.map((a: Account) => ({
    id: a.id,
    label: `${a.code} · ${a.name}`,
  }));

  // Credit-card accounts join the category list (TMC-207) — a card STATEMENT is
  // a bill, and its category is the card, not an expense.
  //
  // This is the double-count guard, not a convenience. The charges on that
  // statement were already expensed when they were made on the card; filing the
  // statement itself under an expense category books the same cost twice, which
  // is the single most common small-business bookkeeping error. Pointing it at
  // the card instead pays down what the card owes and leaves the original cost
  // counted once.
  const cardAccounts = moneyRes.ok
    ? (await moneyRes.json()).moneyAccounts.filter((a) => a.kind === 'credit_card')
    : [];

  return {
    categories,
    cardAccounts: cardAccounts.map((a) => ({ id: a.id, label: a.name })),
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

// Returns undefined for anything it does not handle, so the caller falls
// through to the shared catalogue: `formErrorFor(x) ?? apiErrorMessage(x, …)`.
// This used to end in `default: return code`, which is how an unmapped code
// reached a user's screen (TMC-219). Route-specific copy still wins — it is
// just no longer the only thing standing between them and an identifier.
function formErrorFor(code: string | undefined): string | undefined {
  switch (code) {
    case 'invalid_category_account':
      return 'That category is no longer a valid expense account. Pick another.';
    case 'contact_not_found':
      return 'That vendor could not be found. Pick another.';
    case 'company_not_found':
      return 'No company in this workspace.';
    default:
      return undefined;
  }
}

export const actions: Actions = {
  default: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const values = readForm(data);

    // companyId is resolved server-side (never trusted from the form).
    const companiesRes = await client.api.companies.$get();
    // A lookup this action needs, not the thing the user asked for. Throwing
    // here renders the error page and discards the form, which is the very
    // loss TMC-248 is about — so it fails the action instead, keeping the
    // values on screen with a sentence saying why.
    if (!companiesRes.ok) {
      const body = (await companiesRes.json().catch(() => null)) as { error?: string } | null;
      return fail(companiesRes.status, {
        values,
        formError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
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
          contactErrors: {
            _: apiErrorMessage(body?.error, 'That customer could not be created. Try again.', body),
          },
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

    const res = await client.api.bills.$post({ json: parsed.data });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values: createdName
          ? { ...values, contactId: resolvedContactId, contactName: createdName }
          : values,
        formError:
          formErrorFor(body?.error) ??
          apiErrorMessage(body?.error, 'That could not be created. Try again.', body),
      });
    }
    const created = await res.json();
    redirect(303, `/bills/${created.id}`);
  },
};
