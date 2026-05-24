import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const ACTIVE_COOKIE = 'active_account_id';

export const load: PageServerLoad = ({ locals }) => {
  return {
    memberships: locals.session?.memberships ?? [],
  };
};

export const actions: Actions = {
  default: async ({ request, cookies, locals }) => {
    const data = await request.formData();
    const target = data.get('accountId');
    if (typeof target !== 'string') throw error(400, 'accountId required');

    const memberships = locals.session?.memberships ?? [];
    if (!memberships.some((m) => m.accountId === target)) {
      throw error(403, 'not a member of that company');
    }

    cookies.set(ACTIVE_COOKIE, target, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });

    throw redirect(303, '/');
  },
};
