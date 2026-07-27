import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The worksheet lived here until TMC-162 generalised it to all four returns.
// Kept as a redirect because the page is print-and-hand-to-your-accountant —
// people bookmark it, and a sole proprietor's old link should still land on
// their form rather than a 404. Query string carries over so a bookmarked
// year/basis reproduces exactly.
export const load: PageServerLoad = async ({ url }) => {
  throw redirect(308, `/reports/tax-worksheet${url.search}`);
};
