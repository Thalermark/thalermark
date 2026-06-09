import '../global.css';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { hydrateServerUrl } from '../lib/server-url';

// Hydrate the persisted server URL before anything renders, so the API + auth
// clients build against the right server (SaaS default, or a self-hoster's
// override from the picker) rather than briefly hitting the default. The gate
// is a one-shot secure-store read — effectively instant.
export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    hydrateServerUrl().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <ActivityIndicator color="#0f1626" />
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
