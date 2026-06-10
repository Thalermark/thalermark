import { loadProfitLoss } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Profit & Loss — the full accrual income statement (revenue, expenses, net).
export const load: PageServerLoad = (event) => loadProfitLoss(event);
