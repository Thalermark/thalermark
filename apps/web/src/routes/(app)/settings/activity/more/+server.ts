import { serverApiClient } from '$lib/api.server';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// "Load more" proxy for the account-wide activity feed. Keeps the 50/page
// chunk the loader uses and forwards the cursor to the keyset-paginated
// GET /api/audit-events (feed mode — no entity filter).
export const GET: RequestHandler = async (event) => {
  const cursor = event.url.searchParams.get('cursor') ?? undefined;
  const client = serverApiClient(event);
  const query: Record<string, string> = { limit: '50' };
  if (cursor) query.cursor = cursor;
  const res = await client.api['audit-events'].$get({ query });
  if (!res.ok) return json({ rows: [], nextCursor: null }, { status: res.status });
  const { events, nextCursor } = await res.json();
  return json({ rows: events, nextCursor });
};
