import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Customer statement — a send-to-contact account document (printable + emailable).
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.contacts[':id'].statement.$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'contact not found');
  if (!res.ok) throw error(res.status, 'failed to load statement');
  return { statement: await res.json() };
};

export const actions: Actions = {
  // Email the statement to the contact (or a `to` override). Plain FormData
  // POST so it works with JS off; on success redirect with ?sent=<address> for
  // the success banner (same pattern as invoice send).
  email: async (event) => {
    const client = serverApiClient(event);
    const id = event.params.id;
    const formData = await event.request.formData();
    const toRaw = formData.get('to');
    const to = typeof toRaw === 'string' && toRaw.trim() ? toRaw.trim() : undefined;
    const res = await client.api.contacts[':id'].statement.send.$post({
      param: { id },
      json: { to },
    });
    if (res.status === 404) throw error(404, 'contact not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { emailError: body?.error ?? 'send_failed' });
    }
    const body = (await res.json()) as { sentTo?: string; delivered?: boolean };
    // See the invoice send action (TMC-212) — only the undelivered case is
    // carried, so the ordinary success URL is unchanged.
    const qs = body.sentTo
      ? `?sent=${encodeURIComponent(body.sentTo)}${body.delivered === false ? '&undelivered=1' : ''}`
      : '';
    redirect(303, `/contacts/${id}/statement${qs}`);
  },
};
