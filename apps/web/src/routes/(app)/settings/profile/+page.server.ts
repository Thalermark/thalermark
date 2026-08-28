import { apiBaseUrl, apiFetch, serverApiHeaders } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Personal profile: the signed-in user's own display name + email, read straight
// from the session (no tenant scope — this is the user, not a workspace). Email
// is display-only; changing it would need re-verification, which is out of scope.
export const load: PageServerLoad = ({ locals }) => {
  const user = locals.session?.user;
  if (!user) throw error(401, 'Not signed in');
  return { profile: { name: user.name, email: user.email } };
};

export const actions: Actions = {
  // Delete my profile (TMC-268). The door for someone who was invited to help
  // and is now done: it removes THEM, from everywhere, and touches nobody's
  // business. Lives here rather than under Team because it is about the person,
  // not about any one workspace.
  deleteProfile: async (event) => {
    const res = await apiFetch(`${apiBaseUrl()}/api/me/profile/delete`, {
      method: 'POST',
      headers: serverApiHeaders(event),
    });
    if (res.status === 409) {
      // Owner of a workspace someone else is in. Named, so the next step is
      // obvious rather than a flat refusal.
      const body = (await res.json().catch(() => null)) as {
        workspaces?: { name: string }[];
      } | null;
      const names = (body?.workspaces ?? []).map((w) => w.name);
      return fail(409, { ownedWorkspaces: names });
    }
    if (!res.ok) return fail(res.status, { deleteError: 'That could not be done. Try again.' });
    // The API already dropped every session server-side, so the cookie in hand is
    // dead. Clearing it here too keeps the browser from carrying a token that
    // resolves to nothing and bouncing through a confusing 401 first.
    event.cookies.delete('better-auth.session_token', { path: '/' });
    // Also the active-workspace pointer, which now names a workspace this person
    // is no longer in.
    event.cookies.delete('active_account_id', { path: '/' });
    redirect(303, '/sign-in?deleted=1');
  },
};
