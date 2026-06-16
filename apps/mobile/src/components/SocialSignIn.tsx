import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { type SocialProvider, signInWithProvider } from '../lib/auth-client';
import { getLastAuthMethod } from '../lib/secure-store';
import { useSocialProviders } from '../lib/social-providers';

// Native mirror of web's SocialSignIn.svelte. Renders a button per provider the
// api reports as configured (GET /api/social-providers — a public route), in a
// fixed order so the buttons are stable. On press the expo OAuth flow runs and,
// on success, bridges into the bearer session (see signInWithProvider), then we
// land in the app the same as an email sign-in. Hidden during an invite flow by
// the parent (invites are email-anchored, so a mismatched social account would
// create a stray account instead of joining).
const ORDER: SocialProvider[] = ['google', 'facebook', 'twitter'];
const LABELS: Record<SocialProvider, string> = {
  google: 'Continue with Google',
  facebook: 'Continue with Facebook',
  twitter: 'Continue with X',
};
const ICONS: Record<SocialProvider, keyof typeof Ionicons.glyphMap> = {
  google: 'logo-google',
  facebook: 'logo-facebook',
  twitter: 'logo-twitter',
};

export function SocialSignIn() {
  const router = useRouter();
  const providers = useSocialProviders();
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // This device's last sign-in method — the matching button gets a "Last used"
  // badge (a hint, never a reorder; ORDER stays fixed).
  const [lastUsed, setLastUsed] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getLastAuthMethod().then((m) => {
      if (active) setLastUsed(m);
    });
    return () => {
      active = false;
    };
  }, []);

  const shown = ORDER.filter((p) => providers.includes(p));
  if (shown.length === 0) return null;

  async function onPress(provider: SocialProvider) {
    setBusy(provider);
    setError(null);
    const result = await signInWithProvider(provider);
    if (!result.ok) {
      setBusy(null);
      setError(result.error);
      return;
    }
    router.replace('/');
  }

  return (
    <View className="mt-8">
      <View className="flex-row items-center gap-4">
        <View className="h-px flex-1 bg-ink/15" />
        <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">or</Text>
        <View className="h-px flex-1 bg-ink/15" />
      </View>
      <View className="mt-6 gap-3">
        {shown.map((provider) => (
          <Pressable
            key={provider}
            onPress={() => onPress(provider)}
            disabled={busy !== null}
            className="flex-row items-center justify-center gap-3 rounded-sm border border-ink/25 bg-cream px-3 py-3 active:border-ink disabled:opacity-50"
          >
            {busy === provider ? (
              <ActivityIndicator color="#0f1626" />
            ) : (
              <>
                <Ionicons name={ICONS[provider]} size={18} color="#0f1626" />
                <Text className="text-sm font-medium text-ink">{LABELS[provider]}</Text>
              </>
            )}
            {provider === lastUsed ? (
              <View className="absolute right-3 rounded-full bg-ink/10 px-2 py-0.5">
                <Text className="font-mono text-[10px] uppercase tracking-wider text-ink/55">
                  Last used
                </Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </View>
      {error ? (
        <Text className="mt-3 font-mono text-xs uppercase tracking-widest text-oxblood">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
