import { COPY } from '@thalermark/brand';
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authClient } from '../../lib/auth-client';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit() {
    setError(null);
    setSubmitting(true);
    const result = await authClient.signIn.email({ email, password });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message ?? 'Sign-in failed');
      return;
    }
    router.replace('/');
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          Welcome back
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">{COPY.signIn.title}</Text>

        <View className="mt-8 space-y-5">
          <View>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              inputMode="email"
              keyboardType="email-address"
              className="mt-2 border-b border-ink/30 py-2 text-ink"
            />
          </View>
          <View>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              Password
            </Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              className="mt-2 border-b border-ink/30 py-2 text-ink"
            />
          </View>
          {error ? (
            <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
              {error}
            </Text>
          ) : null}
          <Pressable
            onPress={onSubmit}
            disabled={submitting}
            className="mt-2 rounded-sm bg-ink px-3 py-3 active:bg-gold-deep disabled:opacity-50"
          >
            {submitting ? (
              <ActivityIndicator color="#f4ede0" />
            ) : (
              <Text className="text-center text-sm font-medium text-cream">
                {COPY.signIn.submit}
              </Text>
            )}
          </Pressable>
        </View>

        <View className="mt-8 flex-row justify-center">
          <Text className="text-sm text-ink/70">No account? </Text>
          <Link href="/sign-up" className="text-sm text-gold-deep underline">
            Sign up
          </Link>
        </View>
      </View>
    </SafeAreaView>
  );
}
