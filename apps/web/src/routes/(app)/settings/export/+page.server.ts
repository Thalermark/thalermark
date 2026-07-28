import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Export merged into Import & export — getting data in and getting it out are
// the same job seen from both ends. Kept as a redirect because the old page
// linked here from elsewhere and people bookmark settings pages.
//
// The /settings/export/download endpoint is UNTOUCHED — it still streams the
// ZIP, and the merged page still points at it.
export const load: PageServerLoad = async () => {
  throw redirect(308, '/settings/import');
};
