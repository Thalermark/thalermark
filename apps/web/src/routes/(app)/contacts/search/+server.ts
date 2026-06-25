import { cookieCompanyId } from '$lib/active-company';
import { serverApiClient } from '$lib/api.server';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';

// Same-origin browser proxy for the expense Vendor type-ahead (VendorPicker).
// Mirrors items/search: Caddy routes /api/* to the Hono api, auth is already
// gated by hooks.server.ts, and serverApiClient forwards the session cookie +
// x-account-id so the underlying GET /api/contacts stays tenant- + RLS-scoped.
//
// Searches ALL contacts (no role filter) on purpose: linking an expense to an
// existing customer is how that contact also becomes a vendor — the buy-from
// half of the unified relationship. The picker only surfaces {id, name} for the
// suggestion list.
export const GET: RequestHandler = async (event) => {
  const q = event.url.searchParams.get('q')?.trim();
  if (!q) return json({ contacts: [] });

  const client = serverApiClient(event);
  // Scope to the active company so the picker never offers another company's
  // contacts. The cookie is kept healed by the (app) layout load.
  const companyId = cookieCompanyId(event.cookies);
  const query: Record<string, string> = { q, limit: '10' };
  if (companyId) query.companyId = companyId;
  const res = await client.api.contacts.$get({ query });
  if (!res.ok) return json({ contacts: [] });
  const { contacts } = await res.json();

  return json({
    contacts: contacts.map((c) => ({ id: c.id, name: c.name })),
  });
};
