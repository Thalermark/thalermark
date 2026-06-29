import { Stack } from 'expo-router';

// "Big purchases" (capital purchases: equipment + financing), reached from the
// Expenses-new branch. A stack: list → new → detail. Mirrors bills/ + owner-money/.
export default function PurchasesLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
