import { pickActiveCompany, setActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { apiBaseUrl, apiFetch, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { BUSINESS_TYPES, timezoneOptions } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const companiesRes = await client.api.companies.$get();
  if (!companiesRes.ok) throw error(companiesRes.status, 'failed to load companies');
  const { companies } = await companiesRes.json();

  // The active company within this workspace (cookie-backed switcher), same
  // pick as the other settings tabs; falls back to the first for single-company.
  const company = pickActiveCompany(event.cookies, companies);
  if (!company) throw error(500, 'no company in this workspace');

  // Signed URL for the logo preview (same best-effort pattern as the expense
  // receipt). A 404 (no logo) or any failure simply renders the empty state.
  let logo: { url: string; contentType: string } | null = null;
  const logoRes = await client.api.companies[':id'].logo.$get({ param: { id: company.id } });
  if (logoRes.ok) logo = (await logoRes.json()) as { url: string; contentType: string };

  // Built server-side from the same tz database Node ships, so SSR and the
  // client can't disagree about which zones exist. ~400 entries is chunky HTML
  // for one settings page, but it beats a hand-curated list going stale and
  // rejecting somebody's real zone.
  // Must contain the stored value or the select silently shows Africa/Abidjan
  // for every company still on the 'UTC' default (TMC-258 follow-up).
  const timezones = timezoneOptions(company.timezone);

  // Did this business take over from another, and can that still be undone?
  // Asked here because Business settings is where someone who has just realised
  // the handoff was a mistake will go looking for the way back.
  let handoff: {
    id: string;
    effectiveDate: string;
    predecessorName: string | null;
    reversible: boolean;
  } | null = null;
  const handoffRes = await client.api['entity-transfers'].current.$get({
    query: { companyId: company.id },
  });
  if (handoffRes.ok) {
    const body = await handoffRes.json();
    handoff = body.transfer;
  }

  return { company, logo, timezones, handoff };
};

export const actions: Actions = {
  // Saves the business address / phone / email shown in the invoice "from"
  // block, plus the per-field "show on invoices" defaults (each a checkbox →
  // present only when checked). Empty text inputs clear the columns (API
  // coerces '' → null → the public invoice drops that line). Plain HTML form
  // action, matching the rest of settings.
  save: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const businessAddress = String(formData.get('businessAddress') ?? '').trim();
    const businessPhone = String(formData.get('businessPhone') ?? '').trim();
    const businessEmail = String(formData.get('businessEmail') ?? '').trim();
    // Unchecked boxes don't submit at all, so absence = false. The form always
    // renders all three, so we always send an explicit boolean for each.
    const showAddressOnInvoice = formData.get('showAddressOnInvoice') === 'on';
    const showPhoneOnInvoice = formData.get('showPhoneOnInvoice') === 'on';
    const showEmailOnInvoice = formData.get('showEmailOnInvoice') === 'on';
    const showAddressOnEstimate = formData.get('showAddressOnEstimate') === 'on';
    const showPhoneOnEstimate = formData.get('showPhoneOnEstimate') === 'on';
    const showEmailOnEstimate = formData.get('showEmailOnEstimate') === 'on';
    if (!companyId) return fail(400, { error: 'missing_company_id' });

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: {
        businessAddress,
        businessPhone,
        businessEmail,
        showAddressOnInvoice,
        showPhoneOnInvoice,
        showEmailOnInvoice,
        showAddressOnEstimate,
        showPhoneOnEstimate,
        showEmailOnEstimate,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        error: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
        businessAddress,
        businessPhone,
        businessEmail,
        showAddressOnInvoice,
        showPhoneOnInvoice,
        showEmailOnInvoice,
        showAddressOnEstimate,
        showPhoneOnEstimate,
        showEmailOnEstimate,
      });
    }
    return {
      saved: true,
      businessAddress,
      businessPhone,
      businessEmail,
      showAddressOnInvoice,
      showPhoneOnInvoice,
      showEmailOnInvoice,
      showAddressOnEstimate,
      showPhoneOnEstimate,
      showEmailOnEstimate,
    };
  },

  // How the business is set up (TMC-124). Asked once during onboarding, but it
  // genuinely changes — a sole proprietor incorporates, a solo operator takes on
  // a partner — and this is the only place to say so afterwards. The server
  // re-maps the company's categories to match; past records keep the wording
  // they were filed under.
  saveBusinessType: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const businessType = String(formData.get('businessType') ?? '');
    if (!companyId) return fail(400, { businessTypeError: 'missing_company_id' });
    if (!BUSINESS_TYPES.includes(businessType as (typeof BUSINESS_TYPES)[number])) {
      return fail(400, { businessTypeError: 'invalid_business_type' });
    }

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { businessType: businessType as (typeof BUSINESS_TYPES)[number] },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        businessTypeError: apiErrorMessage(
          body?.error,
          'That could not be saved. Try again.',
          body,
        ),
      });
    }
    return { businessTypeSaved: true };
  },

  // Saves the reply-to address shown to the contact's mail client. Empty input
  // clears it (API coerces '' → null, dropping the Reply-To header from outbound
  // invoice/estimate emails). Distinct replyToSaved/replyToError flags keep this
  // from tripping the contact form's status (both POST to this page).
  // When the business counts income. Framed in plain words in the UI ("when
  // you get paid" / "when you send the invoice") because the product principle
  // is that users never pick accounting concepts — the wire value is still
  // cash/accrual. Deliberately its own action + section: it's a standing tax
  // election, not a display preference, and shouldn't ride along with an
  // address edit.
  saveAccountingMethod: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const accountingMethod = String(formData.get('accountingMethod') ?? '');
    if (!companyId) return fail(400, { accountingError: 'missing_company_id' });
    if (accountingMethod !== 'cash' && accountingMethod !== 'accrual') {
      return fail(400, { accountingError: 'invalid_accounting_method' });
    }

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { accountingMethod },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        accountingError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    return { accountingSaved: true };
  },

  // How much of a big purchase's yearly write-off lands in the year it was
  // bought (TMC-123). Its own action + section for the same reason as the
  // accounting method: it's an accountant's correction to a standing tax
  // treatment, not a display preference. The person who bought the thing never
  // comes here — they answered "deduct it all this year" vs "spread it out" at
  // the point of purchase and that's the whole of their involvement.
  saveDepreciationConvention: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const depreciationConvention = String(formData.get('depreciationConvention') ?? '');
    if (!companyId) return fail(400, { depreciationError: 'missing_company_id' });
    if (depreciationConvention !== 'half_year' && depreciationConvention !== 'full_year') {
      return fail(400, { depreciationError: 'invalid_depreciation_convention' });
    }

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { depreciationConvention },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        depreciationError: apiErrorMessage(
          body?.error,
          'That could not be saved. Try again.',
          body,
        ),
      });
    }
    return { depreciationSaved: true };
  },

  // Standard mileage vs actual vehicle expenses (TMC-179). Its own action for
  // the same reason as the two above: it is a standing tax election that
  // silently changes what lands on the return, not a display preference.
  saveVehicleExpenseMethod: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const vehicleExpenseMethod = String(formData.get('vehicleExpenseMethod') ?? '');
    if (!companyId) return fail(400, { vehicleMethodError: 'missing_company_id' });
    if (vehicleExpenseMethod !== 'standard' && vehicleExpenseMethod !== 'actual') {
      return fail(400, { vehicleMethodError: 'invalid_vehicle_expense_method' });
    }

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { vehicleExpenseMethod },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        vehicleMethodError: apiErrorMessage(
          body?.error,
          'That could not be saved. Try again.',
          body,
        ),
      });
    }
    return { vehicleMethodSaved: true };
  },

  // The zone every report's day boundaries resolve in (TMC-157). Its own
  // action for the same reason as the accounting method: it silently changes
  // which period figures land in, so it shouldn't ride along with an address
  // edit. The API re-validates against the tz database — this check only keeps
  // an obviously-empty submit from making a round trip.
  saveTimezone: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const timezone = String(formData.get('timezone') ?? '').trim();
    if (!companyId) return fail(400, { timezoneError: 'missing_company_id' });
    if (!timezone) return fail(400, { timezoneError: 'invalid_timezone' });

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { timezone },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        timezoneError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
      });
    }
    return { timezoneSaved: true };
  },

  saveReplyTo: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const replyToEmail = String(formData.get('replyToEmail') ?? '').trim();
    if (!companyId) return fail(400, { replyToError: 'missing_company_id' });

    const res = await client.api.companies[':id'].$patch({
      param: { id: companyId },
      json: { replyToEmail },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        replyToError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
        replyToEmail,
      });
    }
    return { replyToSaved: true, replyToEmail };
  },

  // Forward the multipart logo to the api. Raw fetch (not the typed client),
  // same pattern as the expense receipt upload — FormData sets its own
  // content-type and serverApiHeaders carries the session + account.
  uploadLogo: async (event) => {
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    const file = formData.get('logo');
    if (!companyId) return fail(400, { logoError: 'missing_company_id' });
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, { logoError: 'Choose an image to upload.' });
    }
    const fd = new FormData();
    fd.set('file', file);
    const res = await apiFetch(
      `${apiBaseUrl()}/api/companies/${companyId}/logo`,
      {
        method: 'POST',
        headers: serverApiHeaders(event),
        body: fd,
      },
      event.fetch,
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = apiErrorMessage(
        body?.error,
        'That file could not be uploaded. Try again.',
        body,
      );
      const msg =
        code === 'unsupported_media_type'
          ? 'Logo must be a PNG, JPEG, or WebP.'
          : code === 'file_too_large'
            ? 'Logo must be under 2 MB.'
            : code === 'storage_not_configured'
              ? 'Logo storage is not configured on this server.'
              : code;
      return fail(res.status, { logoError: msg });
    }
    redirect(303, '/settings/business');
  },

  removeLogo: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    if (!companyId) return fail(400, { logoError: 'missing_company_id' });
    const res = await client.api.companies[':id'].logo.$delete({ param: { id: companyId } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        logoError: apiErrorMessage(body?.error, 'That could not be removed. Try again.', body),
      });
    }
    redirect(303, '/settings/business');
  },

  // Retire / bring back a business that has stopped trading.
  //
  // Not a delete and not reversible-by-accident: the books stay readable and
  // reportable forever (a business that closes still files a final return), and
  // the only thing that changes is that the ledger stops accepting new work.
  // Settling what was already owed keeps working — see lib/company-lock.ts.
  retire: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    if (!companyId) return fail(400, { retireError: 'Could not tell which business to close.' });

    const res = await client.api.companies[':id'].retire.$post({ param: { id: companyId } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { retireError: retireErrorMessage(body?.error) });
    }
    redirect(303, '/settings/business');
  },

  // Undo a handoff. Everything is one API call — the endpoint does both
  // companies in one transaction — so there is nothing to sequence here.
  undoHandoff: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const transferId = String(data.get('transferId') ?? '');
    if (!transferId) return fail(400, { handoffError: 'Could not tell which handover to undo.' });

    const res = await client.api['entity-transfers'][':id'].reverse.$post({
      param: { id: transferId },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { handoffError: undoErrorMessage(body?.error) });
    }
    // Land on the business that is trading again, not the one just closed.
    const { predecessorCompanyId } = (await res.json()) as { predecessorCompanyId: string };
    setActiveCompany(event.cookies, predecessorCompanyId);
    redirect(303, '/settings/business');
  },

  unretire: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const companyId = String(formData.get('companyId') ?? '');
    if (!companyId) return fail(400, { retireError: 'Could not tell which business to reopen.' });

    const res = await client.api.companies[':id'].unretire.$post({ param: { id: companyId } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { retireError: retireErrorMessage(body?.error) });
    }
    redirect(303, '/settings/business');
  },
};

// Server error codes are mechanical; the user reads plain sentences.
function retireErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'last_active_company':
      return "This is your only open business, so it can't be closed. Add another one first.";
    case 'already_retired':
      return 'This business is already closed.';
    case 'not_retired':
      return 'This business is already open.';
    default:
      return 'Could not change this business.';
  }
}

function undoErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'successor_has_activity':
      return "You've already recorded work against this business, so the handover can't be undone. Nothing has changed.";
    case 'already_reversed':
      return 'This handover has already been undone.';
    case 'period_closed':
      return "The handover falls in a year you've already closed. Reopen that year first.";
    default:
      return 'Could not undo the handover.';
  }
}
