import { serverApiClient } from '$lib/api.server';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Layout-level handler for the first-run consent prompt (TelemetryConsent.svelte).
// SvelteKit form actions are page-scoped, but the prompt lives in the (app)
// layout, so it posts here instead. "Yes, help" sends the `enabled` field;
// "No thanks" sends nothing → opt-out. Either way the API stamps
// telemetry_decided_at, so the prompt won't reappear. Redirects back to where
// the operator was (no-JS, no navigation away from their page).
export const POST: RequestHandler = async (event) => {
  const formData = await event.request.formData();
  const client = serverApiClient(event);
  // Best-effort: a failed PATCH (e.g. a race that dropped the capability) just
  // means the prompt shows again next load — never block the redirect.
  await client.api.account.telemetry
    .$patch({ json: { enabled: formData.has('enabled') } })
    .catch(() => {});
  const back = event.request.headers.get('referer') ?? '/';
  redirect(303, back);
};
