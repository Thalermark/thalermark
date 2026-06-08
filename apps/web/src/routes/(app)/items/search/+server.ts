import { serverApiClient } from '$lib/api.server';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';

// Same-origin browser proxy for the line-item type-ahead. The ItemPicker on
// the invoice / estimate / recurring forms calls this with `?q=...` and gets
// back catalog matches to prefill a line. Lives on the web app (not the Hono
// api) for the same reasons as locations/autocomplete: Caddy routes /api/* to
// the api service, and auth is already gated by hooks.server.ts so reaching
// this handler means a valid session. serverApiClient forwards the session
// cookie + x-account-id so the underlying GET /api/items is tenant-scoped
// and RLS-fenced; archived items are filtered out server-side by default.
export const GET: RequestHandler = async (event) => {
  const q = event.url.searchParams.get('q')?.trim();
  if (!q) return json({ items: [] });

  const client = serverApiClient(event);
  const res = await client.api.items.$get({ query: { q } });
  if (!res.ok) return json({ items: [] });
  const { items } = await res.json();

  // Trim to the fields the picker needs — id stamps the breadcrumb, the rest
  // prefill the line. account_id / company_id / timestamps stay server-side.
  return json({
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      unitPrice: i.unitPrice,
      unitLabel: i.unitLabel,
      defaultQuantity: i.defaultQuantity,
    })),
  });
};
