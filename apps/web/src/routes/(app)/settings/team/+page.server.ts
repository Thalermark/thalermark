import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.team.$get();
  if (!res.ok) throw error(res.status, 'failed to load team');
  const { members, invitations } = await res.json();
  return { members, invitations };
};

// Maps the API's error codes to a human-readable line for the form.
const INVITE_ERRORS: Record<string, string> = {
  invalid_email: "That doesn't look like a valid email address.",
  mailer_not_configured: 'Email is not configured on this server, so the invite could not be sent.',
  mailer_send_failed: "The invite was saved but the email couldn't be sent. Try again.",
};

export const actions: Actions = {
  // Sends an invite. POST /api/invitations has no json validator on the API
  // side, so it can't go through the typed hc client — use the documented
  // raw-fetch escape hatch with the same auth headers serverApiClient stamps.
  // Plain HTML form action (no use:enhance), matching the rest of settings.
  invite: async (event) => {
    const formData = await event.request.formData();
    const email = String(formData.get('email') ?? '').trim();
    if (!email) return fail(400, { error: 'invalid_email', email });

    const res = await fetch(`${apiBaseUrl()}/api/invitations`, {
      method: 'POST',
      headers: { ...serverApiHeaders(event), 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'send_failed';
      return fail(res.status, {
        error: INVITE_ERRORS[code] ?? 'Could not send the invite.',
        email,
      });
    }
    return { invited: email };
  },
};
