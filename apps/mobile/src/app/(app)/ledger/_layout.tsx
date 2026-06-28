import { Stack } from 'expo-router';

// "The Ledger" — the gated manual-journal-adjustment portal, reached from the
// More hub (Accounting). A stack: airlock+list → new → detail. Mirrors
// owner-money/ and bills/.
export default function LedgerLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
