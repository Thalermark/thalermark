import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Settings has no landing of its own — the dropdown link drops the user
// onto the Profile tab: a true, personal setting that every role can see.
// The target MUST stay un-gated (Profile/Activity/Items/Team) — a gated
// route would 403/redirect for low-privilege members.
export const load: PageServerLoad = () => {
  redirect(303, '/settings/profile');
};
