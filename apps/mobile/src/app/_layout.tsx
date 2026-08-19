import '../global.css';
import '../lib/css-interop';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { hydrateServerUrl } from '../lib/server-url';
import { hydrateTheme } from '../lib/theme';

// Hydrate the persisted server URL and appearance before anything renders: the
// API + auth clients must build against the right server (SaaS default, or a
// self-hoster's override from the picker) rather than briefly hitting the
// default, and a pinned Light/Dark choice must be applied before first paint or
// the app flashes the system appearance and then snaps. Both are one-shot
// secure-store reads — effectively instant.
export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([hydrateServerUrl(), hydrateTheme()]).finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <ActivityIndicator className="text-ink" />
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
