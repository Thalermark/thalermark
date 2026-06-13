import type { PageServerLoad } from './$types';

// Surface the active workspace role so the hub can gate the General ledger card
// (reports:export — owner/admin/accountant only). Every other role-gated page
// has its own loader; without one here the hub is a prerender candidate and
// `data.role` would resolve to build-time `undefined`, hiding the card for
// everyone. The export endpoint stays the real authority either way.
export const load: PageServerLoad = ({ locals }) => ({ role: locals.role });
