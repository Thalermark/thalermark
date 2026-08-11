import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// "Accounts" — the places this business's money sits (TMC-207).
//
// The user is adding the bank account and card they actually have. That these
// become chart-of-accounts rows, and that a card is a liability while checking
// is an asset, is the system's business and appears nowhere on this screen.
//
// Archived accounts are hidden by default, same as items and tax policies;
// `?archived=1` flips the toggle.
export const load: PageServerLoad = async (event) => {
  const showArchived = event.url.searchParams.get('archived') === '1';
  const client = serverApiClient(event);
  const { activeCompanyId } = await event.parent();
  if (!activeCompanyId) return { moneyAccounts: [], showArchived, companyId: null };

  const query: Record<string, string> = { companyId: activeCompanyId };
  if (showArchived) query.includeArchived = 'true';
  const res = await client.api['money-accounts'].$get({ query });
  if (!res.ok) throw error(res.status, 'failed to load accounts');
  const { moneyAccounts } = await res.json();
  return { moneyAccounts, showArchived, companyId: activeCompanyId };
};

function failure(res: Response, body: { error?: string } | null) {
  return fail(res.status, {
    actionError: apiErrorMessage(body?.error, 'That did not work. Try again.', body),
  });
}

export const actions: Actions = {
  create: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const companyId = String(data.get('companyId') ?? '');
    const name = String(data.get('name') ?? '').trim();
    const kind = String(data.get('kind') ?? '');
    if (!companyId || !name || !kind) {
      return fail(400, { actionError: 'Give the account a name and pick what kind it is.' });
    }

    const res = await client.api['money-accounts'].$post({
      json: { companyId, name, kind: kind as 'checking' | 'savings' | 'cash' | 'credit_card' },
    });
    if (!res.ok) return failure(res, (await res.json().catch(() => null)) as { error?: string });
    redirect(303, `/settings/accounts${event.url.search}`);
  },

  rename: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    const name = String(data.get('name') ?? '').trim();
    if (!id || !name) return fail(400, { actionError: 'Give the account a name.' });

    const res = await client.api['money-accounts'][':id'].$patch({ param: { id }, json: { name } });
    if (res.status === 404) throw error(404, 'account not found');
    if (!res.ok) return failure(res, (await res.json().catch(() => null)) as { error?: string });
    redirect(303, `/settings/accounts${event.url.search}`);
  },

  archive: async (event) => setActive(event, false),
  restore: async (event) => setActive(event, true),
};

async function setActive(event: Parameters<Actions[string]>[0], active: boolean) {
  const client = serverApiClient(event);
  const data = await event.request.formData();
  const id = String(data.get('id') ?? '');
  if (!id) {
    return fail(400, {
      actionError: 'Could not tell which account that was — reload the page and try again.',
    });
  }

  const res = active
    ? await client.api['money-accounts'][':id'].restore.$post({ param: { id } })
    : await client.api['money-accounts'][':id'].archive.$post({ param: { id } });
  if (res.status === 404) throw error(404, 'account not found');
  if (!res.ok) return failure(res, (await res.json().catch(() => null)) as { error?: string });
  redirect(303, `/settings/accounts${event.url.search}`);
}
