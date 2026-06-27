import { Stack } from 'expo-router';

// Owner money (contributions + draws) is a stack reached from the More hub:
// list → new → detail → edit. Mirrors bills/, expenses/.
export default function OwnerMoneyLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
