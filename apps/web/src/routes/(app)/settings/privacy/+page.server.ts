import { serverApiClient } from '$lib/api.server';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

// Privacy → Usage data. The single per-account telemetry consent toggle
// (TELEMETRY.md). The API gates this settings:manage, matching the tab's `cap`.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.account.telemetry.$get();
  if (!res.ok) throw error(res.status, 'failed to load privacy settings');
  return { telemetry: await res.json() };
};

export const actions: Actions = {
  // Plain HTML form, no use:enhance — matches the rest of settings. The lone
  // checkbox decides enabled; an unchecked box submits nothing, so `has()` is
  // the opt-out. The API stamps telemetry_decided_at either way, so flipping it
  // here also silences the first-run prompt.
  default: async (event) => {
    const client = serverApiClient(event);
    const formData = await event.request.formData();
    const res = await client.api.account.telemetry.$patch({
      json: { enabled: formData.has('enabled') },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { saveError: body?.error ?? 'save_failed' });
    }
    return { telemetry: await res.json(), saved: true };
  },
};
