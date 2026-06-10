import { loadSalesTax } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Sales tax collected — Sales Tax Payable movement over the window.
export const load: PageServerLoad = (event) => loadSalesTax(event);
