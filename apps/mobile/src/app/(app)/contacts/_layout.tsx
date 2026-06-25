import { Stack } from 'expo-router';

// Contacts tab is a stack: list → new → detail. Headers are hidden; each
// screen renders its own in-screen title + back affordance, matching the
// existing (auth)/Home screens.
export default function ContactsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
