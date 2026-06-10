import { loadEstimateWinRate } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Estimate win rate — accepted vs declined/expired over the window.
export const load: PageServerLoad = (event) => loadEstimateWinRate(event);
