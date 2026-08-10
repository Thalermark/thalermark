import { pickActiveCompany } from '$lib/active-company';
import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import type { OpeningBalanceAccount, OpeningBalanceData } from '$lib/opening-balance';
import { may } from '$lib/perms';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { error, fail, redirect } from '@sveltejs/kit';
import { openingBalanceFullUpsertSchema, openingBalanceUpsertSchema } from '@thalermark/validation';

// Loader + actions for starting balances, lifted out of the owner-money route so
// the settings page and the welcome wizard can mount the same thing.
//
// Sharing this is not tidiness — it's the one guard against a real hazard. There
// is exactly ONE opening-balance record per company, stored as either the three
// simple answers or a full trial balance, and whichever saves last wins. Two
// independent implementations would eventually let one silently wipe the other.
//
// The wizard already demonstrates the failure mode we're avoiding: step 3
// "Getting paid" duplicates Settings → Payments as two separate forms.
//
// `redirectTo` is the only thing that varies between hosts.

async function activeCompanyId(event: RequestEvent): Promise<string | null> {
  const client = serverApiClient(event);
  const res = await client.api.companies.$get();
  if (!res.ok) throw error(res.status, 'failed to load companies');
  const { companies } = await res.json();
  return pickActiveCompany(event.cookies, companies)?.id ?? null;
}

export async function loadOpeningBalance(event: RequestEvent): Promise<OpeningBalanceData> {
  const client = serverApiClient(event);
  const companyId = await activeCompanyId(event);
  if (!companyId) throw error(500, 'no company in this workspace');

  const res = await client.api['owner-money']['opening-balance'].$get({ query: { companyId } });
  const body = res.ok ? await res.json() : null;

  // The chart, for the full trial balance. Only fetched for roles that can post
  // adjustments — it's ~30 accounts of payload the three-question path never
  // reads, and an empty list is how the component knows not to offer it.
  let accounts: OpeningBalanceAccount[] = [];
  if (may(event.locals.role, 'ledger:adjust')) {
    const accRes = await client.api.companies[':id'].accounts.$get({
      param: { id: companyId },
      query: { type: undefined },
    });
    if (accRes.ok) {
      accounts = (await accRes.json()).accounts.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        accountType: a.accountType,
      }));
    }
  }

  return {
    current: (body?.openingBalance ?? null) as OpeningBalanceData['current'],
    lines: body?.lines ?? [],
    accounts,
    today: new Date().toISOString().slice(0, 10),
  };
}

type FormValues = { asOfDate: string; cash: string; receivables: string; payables: string };

function readForm(data: FormData): FormValues {
  return {
    asOfDate: String(data.get('asOfDate') ?? '').trim(),
    cash: String(data.get('cash') ?? '').trim(),
    receivables: String(data.get('receivables') ?? '').trim(),
    payables: String(data.get('payables') ?? '').trim(),
  };
}

export function openingBalanceActions(redirectTo: string): Actions {
  return {
    save: async (event) => {
      const client = serverApiClient(event);
      const values = readForm(await event.request.formData());

      // companyId is resolved server-side (never trusted from the form).
      const companyId = await activeCompanyId(event);
      if (!companyId) return fail(400, { values, formError: 'No company in this workspace.' });

      // Blank fields collapse to undefined so the schema applies its "0" default.
      const parsed = openingBalanceUpsertSchema.safeParse({
        companyId,
        asOfDate: values.asOfDate,
        cash: values.cash === '' ? undefined : values.cash,
        receivables: values.receivables === '' ? undefined : values.receivables,
        payables: values.payables === '' ? undefined : values.payables,
      });
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? '_');
          if (!fieldErrors[key]) fieldErrors[key] = issue.message;
        }
        return fail(400, { values, fieldErrors });
      }

      const res = await client.api['owner-money']['opening-balance'].$put({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return fail(res.status, {
          values,
          formError: apiErrorMessage(body?.error, 'That could not be saved. Try again.', body),
        });
      }
      redirect(303, redirectTo);
    },

    // The full opening trial balance. A separate action rather than a mode flag
    // on `save`, so the plain three-question form keeps its exact shape and
    // error handling — the two paths only converge at the API.
    saveFull: async (event) => {
      const client = serverApiClient(event);
      const data = await event.request.formData();
      const asOfDate = String(data.get('asOfDate') ?? '').trim();
      // The variable-length line list is serialized to a hidden field by the
      // client, the same way the ledger portal's entry form does it.
      const linesRaw = String(data.get('lines') ?? '');

      const companyId = await activeCompanyId(event);
      if (!companyId) return fail(400, { fullError: 'No company in this workspace.' });

      let lines: unknown = [];
      try {
        lines = JSON.parse(linesRaw);
      } catch {
        return fail(400, { fullError: 'Could not read the opening balances.' });
      }

      const parsed = openingBalanceFullUpsertSchema.safeParse({ companyId, asOfDate, lines });
      if (!parsed.success) {
        // The client disables submit until it balances, so a failure here is an
        // edge case — surface the first issue rather than a field map.
        return fail(400, {
          fullError: parsed.error.issues[0]?.message ?? 'Invalid opening balances.',
        });
      }

      const res = await client.api['owner-money']['opening-balance'].$put({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return fail(res.status, {
          fullError: apiErrorMessage(body?.error, 'Could not save these opening balances.', body),
        });
      }
      redirect(303, redirectTo);
    },

    clear: async (event) => {
      const client = serverApiClient(event);
      const companyId = await activeCompanyId(event);
      if (!companyId) return fail(400, { formError: 'No company in this workspace.' });

      const res = await client.api['owner-money']['opening-balance'].$delete({
        query: { companyId },
      });
      if (!res.ok && res.status !== 404) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return fail(res.status, {
          formError: apiErrorMessage(body?.error, 'That could not be cleared. Try again.', body),
        });
      }
      redirect(303, redirectTo);
    },
  };
}
