import { Stack } from 'expo-router';

// Mileage is a single screen — log and list in one place, because the whole
// point is that logging a trip takes seconds in a truck. Header hidden to match
// the other stacks; the screen renders its own title.
export default function MileageLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
