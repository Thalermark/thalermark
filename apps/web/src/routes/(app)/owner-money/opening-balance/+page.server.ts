import { loadOpeningBalance, openingBalanceActions } from '$lib/opening-balance.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => loadOpeningBalance(event);

export const actions: Actions = openingBalanceActions('/owner-money');
