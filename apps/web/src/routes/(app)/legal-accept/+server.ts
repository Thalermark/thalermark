import { serverApiClient } from '$lib/api.server';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Layout-level handler for the legal-consent wall (LegalConsent.svelte). The
// wall lives in the (app) layout, and SvelteKit form actions are page-scoped, so
// it posts here instead. Records the acceptance via the API (idempotent — the
// unique index makes a repeat a no-op) and redirects back to where the operator
// was; the next (app) load re-fetches legal state, sees accepted:true, and the
// wall is gone. Best-effort: a failed accept just means the wall shows again on
// the next load, never a hard error or a stuck page.
export const POST: RequestHandler = async (event) => {
  // Drain the form body (the required `agree` checkbox) — the API accept takes no
  // payload; the session + active-account header the client stamps are enough.
  await event.request.formData();
  const client = serverApiClient(event);
  await client.api.legal.accept.$post().catch(() => {});
  const back = event.request.headers.get('referer') ?? '/';
  redirect(303, back);
};
