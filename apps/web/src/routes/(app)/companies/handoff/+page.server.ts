import { pickActiveCompany, setActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { BUSINESS_TYPES } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Setting up a new business that takes over from this one — a sole proprietor
// incorporating. Reached from Settings → Business, after the user confirms they
// registered a new entity with its own EIN.
//
// One page rather than a multi-route wizard: the whole thing is a preview plus
// three decisions, and everything is written by ONE atomic POST at the end. A
// draft spanning routes would need server-side state for no gain, and nothing
// exists until the user commits.

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);

  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');
  // A business that has already stopped trading has nothing to hand over.
  if (company.retiredAt) throw redirect(303, '/settings/business');

  const effectiveDate = event.url.searchParams.get('on') ?? new Date().toISOString().slice(0, 10);

  const previewRes = await client.api['entity-transfers'].preview.$get({
    query: { companyId: company.id, effectiveDate },
  });
  if (!previewRes.ok) throw error(previewRes.status, 'failed to work out what would move');
  const preview = await previewRes.json();

  // The type the user picked on the settings page, carried through so they don't
  // answer the same question twice. Validated rather than trusted.
  const requested = event.url.searchParams.get('type');
  const suggestedType =
    requested && (BUSINESS_TYPES as readonly string[]).includes(requested) ? requested : 's_corp';

  return {
    company: { id: company.id, name: company.name },
    suggestedType,
    effectiveDate,
    preview,
  };
};

export const actions: Actions = {
  handoff: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();

    const name = String(data.get('name') ?? '').trim();
    const businessType = String(data.get('businessType') ?? '');
    const effectiveDate = String(data.get('effectiveDate') ?? '').trim();
    const openInvoicesDisposition = String(data.get('openInvoicesDisposition') ?? 'stay');
    // Unchecked boxes simply don't appear in FormData, so presence is the answer.
    const include = {
      contacts: data.get('include.contacts') !== null,
      items: data.get('include.items') !== null,
      taxPolicies: data.get('include.taxPolicies') !== null,
      recurringInvoices: data.get('include.recurringInvoices') !== null,
      emailTemplates: data.get('include.emailTemplates') !== null,
      profile: data.get('include.profile') !== null,
      branding: data.get('include.branding') !== null,
    };
    const transferAssetIds = data.getAll('transferAssetIds').map(String);
    const values = { name, businessType, effectiveDate, openInvoicesDisposition };

    if (!name) return fail(400, { values, formError: 'Give the new business a name.' });
    if (!(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
      return fail(400, { values, formError: 'Pick how the new business is set up.' });
    }

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

    const res = await client.api['entity-transfers'].$post({
      json: {
        predecessorCompanyId: companyId,
        name,
        businessType: businessType as (typeof BUSINESS_TYPES)[number],
        effectiveDate,
        openInvoicesDisposition: openInvoicesDisposition === 'transfer' ? 'transfer' : 'stay',
        transferAssetIds,
        include,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        values,
        formError: apiErrorMessage(body?.error, handoffErrorMessage(body?.error), body),
      });
    }

    // Land on the new business, not the one that just stopped trading.
    const created = (await res.json()) as { successorCompanyId: string };
    setActiveCompany(event.cookies, created.successorCompanyId);
    redirect(303, '/?handoff=done');
  },
};

function handoffErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'already_retired':
      return 'This business has already been handed over.';
    case 'nothing_to_transfer':
      return "There's nothing on this business's books to hand over yet.";
    case 'transfer_account_unmapped':
      return "The new business's categories can't hold everything this one has. Contact support.";
    case 'target_not_empty':
      return 'The new business already has records in it.';
    default:
      return 'Could not set up the new business.';
  }
}
