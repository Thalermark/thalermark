import { TELEMETRY_REPORT_TYPES } from '@thalermark/validation';
import { useFocusEffect, usePathname } from 'expo-router';
import { useCallback } from 'react';
import { trackEvent } from './telemetry';

const REPORT_SLUGS: readonly string[] = TELEMETRY_REPORT_TYPES;

// Fire report_viewed when a report screen gains focus. Derives report_type from
// the route (/more/reports/<slug>), so a report screen just calls this with no
// args. Mirror of web's reports/+layout.svelte; shared so ReportScaffold covers
// every report that uses it and the odd screen out (top-products) opts in too.
export function useTrackReportView(): void {
  const pathname = usePathname();
  useFocusEffect(
    useCallback(() => {
      const slug = pathname.split('/').pop() ?? '';
      if (REPORT_SLUGS.includes(slug)) {
        trackEvent({
          name: 'report_viewed',
          report_type: slug as (typeof TELEMETRY_REPORT_TYPES)[number],
        });
      }
    }, [pathname]),
  );
}
