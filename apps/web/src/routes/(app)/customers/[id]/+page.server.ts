import { serverApiClient } from '$lib/api.server';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.customers[':id'].$get({ param: { id: event.params.id } });
  if (res.status === 404) throw error(404, 'customer not found');
  if (!res.ok) throw error(res.status, 'failed to load customer');
  const customer = await res.json();
  return { customer };
};
