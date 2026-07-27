import { loadTaxWorksheet } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => loadTaxWorksheet(event);
