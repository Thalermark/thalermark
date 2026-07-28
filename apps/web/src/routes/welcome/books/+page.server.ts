import { loadOpeningBalance, openingBalanceActions } from '$lib/opening-balance.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => loadOpeningBalance(event);

// Saving finishes the wizard. Same actions the settings page and the owner-money
// route mount — see $lib/opening-balance.server.ts for why that sharing matters.
export const actions: Actions = openingBalanceActions('/');
