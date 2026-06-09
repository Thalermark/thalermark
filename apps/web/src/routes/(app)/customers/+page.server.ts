import { serverApiClient } from '$lib/api.server';
import { PAGE_SIZE } from '$lib/load-more';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.customers.$get({ query: { limit: String(PAGE_SIZE) } });
  if (!res.ok) throw error(res.status, 'failed to load customers');
  const { customers, nextCursor } = await res.json();
  return { customers, nextCursor };
};
