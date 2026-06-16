<script lang="ts">
  import { page } from '$app/state';
  import { trackEvent } from '$lib/telemetry';
  import { TELEMETRY_REPORT_TYPES } from '@thalermark/validation';

  let { children } = $props();

  const REPORT_SLUGS: readonly string[] = TELEMETRY_REPORT_TYPES;

  // Fire report_viewed when a specific report is shown. The slug after
  // /reports/ maps 1:1 to the report_type enum; the /reports hub (no slug) and
  // any unknown slug don't track. Runs client-side only (trackEvent no-ops on
  // the server) and re-fires on navigation between reports.
  $effect(() => {
    const slug = page.url.pathname.replace(/^\/reports\/?/, '').replace(/\/$/, '');
    if (REPORT_SLUGS.includes(slug)) {
      trackEvent({
        name: 'report_viewed',
        report_type: slug as (typeof TELEMETRY_REPORT_TYPES)[number],
      });
    }
  });
</script>

{@render children()}
