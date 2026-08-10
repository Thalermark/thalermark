import { serverApiClient } from '$lib/api.server';
import type { PageServerLoad } from './$types';

// About had no loader at all — everything on it (version, product name, links)
// is compiled in. It gains one for a single deployment fact: whether the legal
// consent gate is agreeing people to the EXAMPLE Terms and Privacy this repo
// ships (TMC-214).
//
// This page rather than a new one because About is already the "what is this
// installation" surface, and the warning belongs next to the version and the
// licence rather than in a settings tab about something else.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // Best-effort, like the layout's telemetry and legal reads: a failed fetch
  // renders the page without the notice rather than 500ing an informational
  // screen. Defaults to "not on templates" so a transient error never accuses a
  // correctly-configured install.
  const res = await client.api.legal.$get();
  const legal = res.ok ? await res.json() : null;
  return { usingBundledTemplates: legal?.usingBundledTemplates ?? false };
};
