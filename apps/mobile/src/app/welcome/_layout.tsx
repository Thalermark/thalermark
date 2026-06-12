import { Stack } from 'expo-router';

// The welcome wizard lives OUTSIDE the (app) Tabs — focused chrome, no nav bar —
// the native mirror of web's /welcome group sitting outside (app). The (app)
// gate redirects a fresh signup here when its company has no business type yet;
// finishing (or skipping to the end) sets the type and bounces back into (app).
export default function WelcomeLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
