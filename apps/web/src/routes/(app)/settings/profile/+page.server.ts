import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Personal profile: the signed-in user's own display name + email, read straight
// from the session (no tenant scope — this is the user, not a workspace). Email
// is display-only; changing it would need re-verification, which is out of scope.
export const load: PageServerLoad = ({ locals }) => {
  const user = locals.session?.user;
  if (!user) throw error(401, 'Not signed in');
  return { profile: { name: user.name, email: user.email } };
};
