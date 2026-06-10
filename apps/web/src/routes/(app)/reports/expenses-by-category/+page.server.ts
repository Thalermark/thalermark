import { loadProfitLoss } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Expenses by category — the expense section of the P&L, rendered with each
// category's share of the total (a tax-prep / where-did-it-go lens).
export const load: PageServerLoad = (event) => loadProfitLoss(event);
