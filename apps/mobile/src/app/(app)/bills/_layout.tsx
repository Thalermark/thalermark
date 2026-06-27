import { Stack } from 'expo-router';

// Bills (accounts payable) is a stack reached from the More hub + the dashboard
// "Owed by you" tile: list → new → detail → edit, plus the aging report.
// Mirrors invoices/, expenses/.
export default function BillsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
