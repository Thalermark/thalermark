import { serverApiClient } from '$lib/api.server';
import type { PageServerLoad } from './$types';

// About had no loader at all — everything on it (product name, links) was
// compiled in. It gains one for two deployment facts: whether the legal consent
// gate is agreeing people to the EXAMPLE Terms and Privacy this repo ships
// (TMC-214), and which build the API is running.
//
// This page rather than a new one because About is already the "what is this
// installation" surface, and both belong next to the version and the licence
// rather than in a settings tab about something else.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  // Best-effort, like the layout's telemetry and legal reads: a failed fetch
  // renders the page without the notice rather than 500ing an informational
  // screen. Defaults to "not on templates" so a transient error never accuses a
  // correctly-configured install.
  //
  // Both reads are independent, so they go out together rather than in series.
  const [legalRes, buildRes] = await Promise.all([
    client.api.legal.$get(),
    client.api['build-info'].$get(),
  ]);
  const legal = legalRes.ok ? await legalRes.json() : null;
  // Same best-effort posture. Null when the API is unreachable or errors, and
  // the page then shows only the version compiled into this web build — an
  // absent number reads as "couldn't ask", which is honest. Never a guess: the
  // whole point is to expose a MISMATCH, so inventing web's version as the
  // API's would defeat the feature precisely when it matters.
  const apiVersion = buildRes.ok ? ((await buildRes.json()).version ?? null) : null;
  return { usingBundledTemplates: legal?.usingBundledTemplates ?? false, apiVersion };
};
