import { apiErrorMessage } from '$lib/api-errors';
import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const res = await client.api.settings.ai.$get();
  // 403 → not an admin (the tab is hidden for them, but a direct hit lands here).
  if (res.status === 403) throw error(403, 'You need admin access to manage AI.');
  // 503 → no store wired (an embedder build); render an unavailable state.
  if (res.status === 503) return { unavailable: true as const };
  if (!res.ok) throw error(res.status, 'failed to load AI settings');
  const { connection, presets, allowPrivate, allowedEndpoints } = await res.json();
  return { unavailable: false as const, connection, presets, allowPrivate, allowedEndpoints };
};

// Endpoint-rejection reasons → copy. private_address gets a pointer to the
// operator flag, since a self-hoster is often also the admin reading this.
function endpointMessage(reason: string): string {
  switch (reason) {
    case 'private_address':
      return 'That looks like a private/LAN address. Your server administrator can allow it by adding it to AI_ALLOWED_ENDPOINTS (or open all private ranges with AI_ALLOW_PRIVATE_ENDPOINTS).';
    case 'blocked_address':
      return 'That address is blocked for safety (link-local / cloud metadata) and can never be used.';
    case 'unsupported_scheme':
      return 'The endpoint URL must start with http:// or https://.';
    case 'dns_failed':
      return "Couldn't resolve that endpoint's host. Check the URL.";
    default:
      return 'That endpoint URL is not valid.';
  }
}

export const actions: Actions = {
  // Store (or replace) the connection. Always lands UNVERIFIED — the health gate
  // keeps AI off until the Verify action passes.
  save: async (event) => {
    const client = serverApiClient(event);
    const fd = await event.request.formData();
    const provider = String(fd.get('provider') ?? '').trim();
    const baseUrl = String(fd.get('baseUrl') ?? '').trim();
    const apiKey = String(fd.get('apiKey') ?? '');
    const modelVision = String(fd.get('modelVision') ?? '').trim();
    const modelReasoning = String(fd.get('modelReasoning') ?? '').trim();
    const modelFast = String(fd.get('modelFast') ?? '').trim();
    if (!provider) return fail(400, { error: 'Choose a provider.' });

    // Timeout override (Advanced). Blank = the built-in defaults; a value is
    // whole seconds, bounds mirroring the schema so a typo fails here with a
    // sentence instead of a Zod issue list.
    const timeoutRaw = String(fd.get('timeoutSeconds') ?? '').trim();
    const timeoutSeconds = timeoutRaw === '' ? null : Number(timeoutRaw);
    if (
      timeoutSeconds !== null &&
      (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300)
    ) {
      return fail(400, { error: 'Timeout must be a whole number between 30 and 300 seconds.' });
    }

    const res = await client.api.settings.ai.$put({
      json: {
        provider,
        baseUrl: baseUrl || null,
        // Omit the key when the field is blank so the stored one is kept — the
        // form shows a masked hint and only replaces on a real retype.
        ...(apiKey ? { apiKey } : {}),
        modelVision: modelVision || null,
        modelReasoning: modelReasoning || null,
        modelFast: modelFast || null,
        timeoutSeconds,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        reason?: string;
      } | null;
      const code = apiErrorMessage(body?.error, 'That could not be saved. Try again.', body);
      const message =
        code === 'endpoint_rejected'
          ? endpointMessage(body?.reason ?? '')
          : code === 'unknown_provider'
            ? 'That provider is not available.'
            : code === 'base_url_required'
              ? 'This provider needs an endpoint URL.'
              : 'Could not save. Check the fields and try again.';
      return fail(res.status, { error: message });
    }
    return { saved: true };
  },

  // Authenticate the stored connection (the mark). Runs one probe and reports
  // inline; on success the connection goes live for the next AI call.
  verify: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.settings.ai.verify.$post();
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        verify: {
          ok: false as const,
          error:
            body?.error === 'no_connection'
              ? 'Save a connection first.'
              : 'Verification could not run.',
        },
      });
    }
    // `vision` is the second verify stage (TMC-296): null when the fast probe
    // already failed, otherwise the vision-role result so the page can say
    // "text works, receipt reading doesn't" instead of a blanket green.
    const { result, vision } = await res.json();
    return { verify: result, vision };
  },

  remove: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.settings.ai.$delete();
    if (!res.ok) return fail(res.status, { error: 'Could not remove the connection.' });
    redirect(303, '/settings/ai');
  },
};
