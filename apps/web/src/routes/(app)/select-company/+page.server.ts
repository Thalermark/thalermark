import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const ACTIVE_COOKIE = 'active_account_id';

export const load: PageServerLoad = async (event) => {
  // Pending invitations addressed to this user (bootstrap route) → accept /
  // decline banners alongside the workspace list. Best-effort: a non-OK
  // degrades to no banners rather than failing the picker.
  const invitesRes = await serverApiClient(event).api.me.invitations.$get();
  const invitations = invitesRes.ok ? (await invitesRes.json()).invitations : [];
  return {
    memberships: event.locals.session?.memberships ?? [],
    invitations,
  };
};

// Maps the invitation accept/decline error codes to a human banner line.
const INVITE_ACTION_ERRORS: Record<string, string> = {
  invite_not_found: 'That invitation is no longer valid.',
  invite_expired: 'That invitation has expired.',
  invite_email_mismatch: 'That invitation was sent to a different email address.',
  invite_already_accepted: "You've already accepted that invitation.",
};

export const actions: Actions = {
  // Switch the active workspace (the page's former default action).
  switch: async ({ request, cookies, locals }) => {
    const data = await request.formData();
    const target = data.get('accountId');
    if (typeof target !== 'string') throw error(400, 'accountId required');

    const memberships = locals.session?.memberships ?? [];
    if (!memberships.some((m) => m.accountId === target)) {
      throw error(403, 'not a member of that workspace');
    }

    cookies.set(ACTIVE_COOKIE, target, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });

    throw redirect(303, '/');
  },

  // Accept an invitation, then switch into the joined workspace. Raw fetch with
  // serverApiHeaders matches the invite action — these routes are bootstrap
  // (no tenant scope), so x-account-id is carried but ignored server-side.
  accept: async (event) => {
    const token = String((await event.request.formData()).get('token') ?? '');
    if (!token) return fail(400, { error: 'That invitation is no longer valid.' });

    const res = await fetch(`${apiBaseUrl()}/api/invitations/${token}/accept`, {
      method: 'POST',
      headers: serverApiHeaders(event),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        error: INVITE_ACTION_ERRORS[body?.error ?? ''] ?? 'Could not accept the invitation.',
      });
    }
    const { accountId } = (await res.json()) as { accountId: string };
    event.cookies.set(ACTIVE_COOKIE, accountId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
    throw redirect(303, '/');
  },

  // Decline an invitation; the picker reloads (its load re-runs) without it.
  decline: async (event) => {
    const token = String((await event.request.formData()).get('token') ?? '');
    if (!token) return fail(400, { error: 'That invitation is no longer valid.' });

    const res = await fetch(`${apiBaseUrl()}/api/invitations/${token}/decline`, {
      method: 'POST',
      headers: serverApiHeaders(event),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        error: INVITE_ACTION_ERRORS[body?.error ?? ''] ?? 'Could not decline the invitation.',
      });
    }
    return { declined: true };
  },
};
