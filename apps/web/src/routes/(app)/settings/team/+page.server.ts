import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const ACTIVE_COOKIE = 'active_account_id';

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

const MEMBER_ERRORS: Record<string, string> = {
  cannot_remove_owner: "The workspace owner can't be removed.",
  cannot_change_owner: "The owner's role can't be changed — transfer ownership instead.",
  member_not_found: 'That person is no longer a member.',
  invalid_role: 'That is not a valid role.',
  forbidden: "You don't have permission to do that.",
  already_owner: 'That person is already the owner.',
};

export const actions: Actions = {
  // Sends an invite. POST /api/invitations has no json validator on the API
  // side, so it can't go through the typed hc client — use the documented
  // raw-fetch escape hatch with the same auth headers serverApiClient stamps.
  // Plain HTML form action (no use:enhance), matching the rest of settings.
  invite: async (event) => {
    const formData = await event.request.formData();
    const email = String(formData.get('email') ?? '').trim();
    const role = String(formData.get('role') ?? '').trim();
    if (!email) return fail(400, { error: 'invalid_email', email });

    const res = await fetch(`${apiBaseUrl()}/api/invitations`, {
      method: 'POST',
      headers: { ...serverApiHeaders(event), 'content-type': 'application/json' },
      body: JSON.stringify(role ? { email, role } : { email }),
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

  // Remove another member from the active workspace. The API enforces the owner
  // guard (cannot_remove_owner); the removed user loses access on their next
  // request. Raw fetch + serverApiHeaders (carries cookie + x-account-id),
  // matching the invite action — DELETE /api/team/:userId has no typed body.
  remove: async (event) => {
    const userId = String((await event.request.formData()).get('userId') ?? '');
    if (!userId) return fail(400, { memberError: 'Missing member.' });

    const res = await fetch(`${apiBaseUrl()}/api/team/${userId}`, {
      method: 'DELETE',
      headers: serverApiHeaders(event),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        memberError: MEMBER_ERRORS[body?.error ?? ''] ?? 'Could not remove that member.',
      });
    }
    return { removed: true };
  },

  // Change another member's role. team:manage on the API; the owner's role is
  // fixed (use transfer). Raw fetch like the other team actions.
  changeRole: async (event) => {
    const fd = await event.request.formData();
    const userId = String(fd.get('userId') ?? '');
    const role = String(fd.get('role') ?? '');
    if (!userId || !role) return fail(400, { memberError: 'Missing member or role.' });

    const res = await fetch(`${apiBaseUrl()}/api/team/${userId}/role`, {
      method: 'PATCH',
      headers: { ...serverApiHeaders(event), 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        memberError: MEMBER_ERRORS[body?.error ?? ''] ?? 'Could not change that role.',
      });
    }
    return { roleChanged: true };
  },

  // Transfer workspace ownership to another member (owner-only on the API).
  // The current owner becomes an admin; the page reloads to reflect both rows.
  transfer: async (event) => {
    const userId = String((await event.request.formData()).get('userId') ?? '');
    if (!userId) return fail(400, { memberError: 'Missing member.' });

    const res = await fetch(`${apiBaseUrl()}/api/team/${userId}/transfer-ownership`, {
      method: 'POST',
      headers: serverApiHeaders(event),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        memberError: MEMBER_ERRORS[body?.error ?? ''] ?? 'Could not transfer ownership.',
      });
    }
    return { transferred: true };
  },

  // Leave the active workspace (self-removal; blocked for the owner). On
  // success we're no longer a member, so drop the active cookie and bounce —
  // hooks.server.ts re-resolves to a remaining workspace or the picker.
  leave: async (event) => {
    const userId = event.locals.session?.user.id;
    if (!userId) return fail(401, { memberError: 'You are not signed in.' });

    const res = await fetch(`${apiBaseUrl()}/api/team/${userId}`, {
      method: 'DELETE',
      headers: serverApiHeaders(event),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        memberError: MEMBER_ERRORS[body?.error ?? ''] ?? 'Could not leave the workspace.',
      });
    }
    event.cookies.delete(ACTIVE_COOKIE, { path: '/' });
    throw redirect(303, '/');
  },
};
