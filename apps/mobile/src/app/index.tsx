import { COPY, PRODUCT_NAME, TAGLINE } from '@thalermark/brand';
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authClient, signOut } from '../lib/auth-client';

type Session =
  | { status: 'loading' }
  | { status: 'authed'; email: string; name: string | null }
  | { status: 'anon' };

// Phase 6.2 home: still a placeholder, but now auth-aware. Shows links into
// the (auth) flow when there's no stored bearer token, and "signed in as X"
// + a sign-out button when there is. Tab nav + the (app)/ route group land
// in 6.3 — at that point this file moves under (app)/ and gets the real
// dashboard treatment.
export default function Home() {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  // useFocusEffect re-checks the session whenever this screen regains focus
  // (returning from sign-in/sign-up, or app foregrounded). The cleanup flag
  // prevents a stale "you signed out" render from racing the next mount.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      authClient.getSession().then((res) => {
        if (!active) return;
        if (res.data?.user) {
          setSession({
            status: 'authed',
            email: res.data.user.email,
            name: res.data.user.name ?? null,
          });
        } else {
          setSession({ status: 'anon' });
        }
      });
      return () => {
        active = false;
      };
    }, []),
  );

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 items-center justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          — Mobile shell
        </Text>
        <Text className="mt-4 font-serif text-4xl font-light text-ink">{PRODUCT_NAME}</Text>
        <Text className="mt-3 max-w-xs text-center text-ink/70">{TAGLINE}</Text>

        <View className="mt-12 w-full max-w-xs">
          {session.status === 'loading' ? (
            <ActivityIndicator color="#1a1a1a" />
          ) : session.status === 'authed' ? (
            <View className="items-center space-y-4">
              <Text className="text-center text-sm text-ink/70">
                Signed in as{' '}
                <Text className="font-medium text-ink">{session.name ?? session.email}</Text>
              </Text>
              <Pressable
                onPress={async () => {
                  await signOut();
                  setSession({ status: 'anon' });
                }}
                className="rounded-sm border border-ink/30 px-4 py-2 active:bg-ink/5"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-ink">
                  {COPY.signOut}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View className="space-y-3">
              <Link href="/sign-in" asChild>
                <Pressable className="rounded-sm bg-ink px-3 py-3 active:bg-gold-deep">
                  <Text className="text-center text-sm font-medium text-cream">
                    {COPY.signIn.submit}
                  </Text>
                </Pressable>
              </Link>
              <Link href="/sign-up" asChild>
                <Pressable className="rounded-sm border border-ink/30 px-3 py-3 active:bg-ink/5">
                  <Text className="text-center text-sm font-medium text-ink">
                    {COPY.signUp.submit}
                  </Text>
                </Pressable>
              </Link>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
