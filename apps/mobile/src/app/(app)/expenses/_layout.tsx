import { Stack } from 'expo-router';

// Expenses tab is a stack: list → new → detail. Mirrors invoices/, estimates/.
export default function ExpensesLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
