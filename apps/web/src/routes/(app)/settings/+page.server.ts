import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Settings has no landing of its own — the dropdown link drops the user
// onto the Activity tab, which is the broadest secondary view. New tabs
// can override the default later by changing this redirect.
export const load: PageServerLoad = () => {
  redirect(303, '/settings/activity');
};
