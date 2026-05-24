import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.customers.$get();
  if (!res.ok) throw error(res.status, 'failed to load customers');
  const { customers } = await res.json();
  return { customers };
};
