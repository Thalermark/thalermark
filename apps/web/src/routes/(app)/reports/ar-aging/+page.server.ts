import { loadArAging } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// A/R aging — outstanding invoices bucketed by how overdue they are.
export const load: PageServerLoad = (event) => loadArAging(event);
