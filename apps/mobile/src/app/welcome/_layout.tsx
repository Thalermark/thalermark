import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { flushTelemetry, trackEvent } from '../../lib/telemetry';
import { readWelcomeProgress, resetWelcomeProgress } from '../../lib/welcome-progress';

// The welcome wizard lives OUTSIDE the (app) Tabs — focused chrome, no nav bar —
// the native mirror of web's /welcome group sitting outside (app). The (app)
// gate redirects a fresh signup here when its company has no business type yet;
// finishing (or skipping to the end) sets the type and bounces back into (app).
export default function WelcomeLayout() {
  // onboarding_abandoned: this group unmounts when the user leaves the wizard.
  // brand.tsx (the only in-app exit) marks it finished first; any other exit
  // (Android back, an edge bounce) is an abandonment. App-kill won't run this
  // cleanup — best-effort, like web's beforeunload.
  useEffect(() => {
    resetWelcomeProgress();
    return () => {
      const { finished, lastCompletedStep } = readWelcomeProgress();
      if (finished) return;
      trackEvent({ name: 'onboarding_abandoned', last_completed_step: lastCompletedStep });
      void flushTelemetry();
    };
  }, []);

  return <Stack screenOptions={{ headerShown: false }} />;
}
