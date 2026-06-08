import { Stack } from 'expo-router';

// Invoices tab is a stack: list → new → detail. Headers hidden; each screen
// renders its own in-screen title + back, matching customers/.
export default function InvoicesLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
