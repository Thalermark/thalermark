import { loadRevenueOverTime } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Revenue over time — pre-tax sales per month across the window (gaps filled).
export const load: PageServerLoad = (event) => loadRevenueOverTime(event);
