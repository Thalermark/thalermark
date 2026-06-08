import { Stack } from 'expo-router';

// Customers tab is a stack: list → new → detail. Headers are hidden; each
// screen renders its own in-screen title + back affordance, matching the
// existing (auth)/Home screens.
export default function CustomersLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
