import { Stack } from 'expo-router';

// The "More" tab is a stack: hub → items (list / new / detail / edit) and the
// top-products report. Headers hidden; each screen renders its own title + back
// affordance, matching the other feature tabs.
export default function MoreLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
