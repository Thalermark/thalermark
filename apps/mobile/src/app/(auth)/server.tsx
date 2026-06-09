import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getDefaultServerUrl,
  getServerUrl,
  normalizeUrl,
  probeServer,
  resetServerUrl,
  setServerUrl,
} from '../../lib/server-url';

// Pre-sign-in server picker — lets a self-hoster point the app at their own
// Thalermark server instead of the SaaS cloud. The clients (api.ts /
// auth-client.ts) rebuild against the new URL on the next call, so no restart
// is needed. Validates the candidate against the unauthed GET /health before
// saving so a typo can't strand the user on an unreachable server.
export default function ServerPicker() {
  const [url, setUrl] = useState(getServerUrl());
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDefault = normalizeUrl(url) === getDefaultServerUrl();

  async function onSave() {
    const candidate = normalizeUrl(url);
    if (!/^https?:\/\//.test(candidate)) {
      setError('Enter a full URL, including http:// or https://');
      return;
    }
    setChecking(true);
    setError(null);
    const ok = await probeServer(candidate);
    setChecking(false);
    if (!ok) {
      setError("Couldn't reach a Thalermark server at that address.");
      return;
    }
    await setServerUrl(candidate);
    router.back();
  }

  async function onReset() {
    await resetServerUrl();
    setUrl(getDefaultServerUrl());
    setError(null);
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 px-6 pt-6">
        <Pressable onPress={() => router.back()}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← Back</Text>
        </Pressable>

        <Text className="mt-6 font-mono text-xs uppercase tracking-widest text-gold-deep">
          Advanced
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Choose your server</Text>
        <Text className="mt-3 text-sm text-ink/70">
          Point the app at a different Thalermark server. Leave this alone unless you self-host.
        </Text>

        <View className="mt-8">
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
            Server address
          </Text>
          <TextInput
            value={url}
            onChangeText={(t) => {
              setUrl(t);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            keyboardType="url"
            placeholder="https://thalermark.example.com"
            className="mt-2 border-b border-ink/30 py-2 text-ink"
          />
          {error ? (
            <Text className="mt-3 font-mono text-xs uppercase tracking-widest text-oxblood">
              {error}
            </Text>
          ) : null}
        </View>

        <Pressable
          onPress={onSave}
          disabled={checking}
          className="mt-8 rounded-sm bg-ink px-3 py-3 active:bg-gold-deep disabled:opacity-50"
        >
          {checking ? (
            <ActivityIndicator color="#f4ede0" />
          ) : (
            <Text className="text-center text-sm font-medium text-cream">Save</Text>
          )}
        </Pressable>

        {!isDefault ? (
          <Pressable onPress={onReset} className="mt-4">
            <Text className="text-center text-sm text-ink/60 underline">Reset to default</Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
