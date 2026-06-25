import { loadSalesByCustomer } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Sales by contact — pre-tax sales per client over the window, biggest first.
export const load: PageServerLoad = (event) => loadSalesByCustomer(event);
