import { loadJobMargin } from '$lib/reports.server';
import type { PageServerLoad } from './$types';

// Job margin — billed minus the costs the user attributed to each job.
export const load: PageServerLoad = (event) => loadJobMargin(event);
