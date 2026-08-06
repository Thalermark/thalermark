import { Stack } from 'expo-router';

// Jobs tab is a stack: list → new → detail. Headers hidden; each screen renders
// its own in-screen title + back affordance, matching the other stacks.
export default function JobsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
