import { Stack } from 'expo-router';

// Estimates tab is a stack: list → new → detail. Mirrors invoices/.
export default function EstimatesLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
