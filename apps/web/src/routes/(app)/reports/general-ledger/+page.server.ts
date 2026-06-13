import { loadGeneralLedger } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// General ledger — the hidden double-entry made visible for an accountant. The
// loader hits the reports:export-gated export endpoint, so the API 403s any
// role that shouldn't see journal detail.
export const load: PageServerLoad = (event) => loadGeneralLedger(event);
