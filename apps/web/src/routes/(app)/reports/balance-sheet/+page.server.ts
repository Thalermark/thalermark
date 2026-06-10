import { loadBalanceSheet } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Balance sheet — point-in-time assets / liabilities / equity (A = L + E).
export const load: PageServerLoad = (event) => loadBalanceSheet(event);
