import { Link, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../lib/api';
import { authClient } from '../../lib/auth-client';

type Status = 'loading-session' | 'no-token' | 'unauthed' | 'submitting' | 'error' | 'success';

// Mirror of apps/web's accept-invite. Lives outside (app) so unauthed users
// can land on it from a deep link (thalermark://accept-invite?token=...) and
// get pushed to sign-in / sign-up with the token preserved. After auth they
// come back here and the POST auto-fires.
export default function AcceptInvite() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [status, setStatus] = useState<Status>('loading-session');
  const [error, setError] = useState<string | null>(null);
  // Prevent the auto-accept from firing twice if the screen re-focuses
  // (useFocusEffect refires on focus regain — e.g. after a modal dismiss).
  const acceptedOnce = useRef(false);

  const accept = useCallback(async () => {
    if (!token) return;
    setStatus('submitting');
    setError(null);
    try {
      const res = await api.api.invitations[':token'].accept.$post({
        param: { token },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `accept failed (${res.status})`);
        setStatus('error');
        return;
      }
      setStatus('success');
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
      setStatus('error');
    }
  }, [token]);

  useEffect(() => {
    let active = true;
    if (!token) {
      setStatus('no-token');
      return;
    }
    authClient
      .getSession()
      .then((res) => {
        if (!active) return;
        if (res.data?.user) {
          if (acceptedOnce.current) return;
          acceptedOnce.current = true;
          accept();
        } else {
          setStatus('unauthed');
        }
      })
      .catch(() => {
        if (active) setStatus('unauthed');
      });
    return () => {
      active = false;
    };
  }, [token, accept]);

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          Invitation
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Accept invite</Text>

        <View className="mt-8">
          {status === 'no-token' ? (
            <Text className="text-sm text-ink/75">No invite token in the URL.</Text>
          ) : status === 'unauthed' ? (
            <View>
              <Text className="text-sm text-ink/75">
                Sign in or create an account to accept this invitation.
              </Text>
              <View className="mt-6 space-y-3">
                <Link href={{ pathname: '/sign-in', params: { invite: token } }} asChild>
                  <Pressable className="rounded-sm bg-ink px-3 py-3 active:bg-gold-deep">
                    <Text className="text-center text-sm font-medium text-cream">Sign in</Text>
                  </Pressable>
                </Link>
                <Link href={{ pathname: '/sign-up', params: { invite: token } }} asChild>
                  <Pressable className="rounded-sm border border-ink/30 px-3 py-3 active:bg-ink/5">
                    <Text className="text-center text-sm font-medium text-ink">Create account</Text>
                  </Pressable>
                </Link>
              </View>
            </View>
          ) : status === 'error' ? (
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                {error ?? 'Something went wrong.'}
              </Text>
              <Pressable
                onPress={accept}
                className="mt-6 rounded-sm bg-ink px-3 py-3 active:bg-gold-deep"
              >
                <Text className="text-center text-sm font-medium text-cream">Try again</Text>
              </Pressable>
            </View>
          ) : status === 'success' ? (
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              Invitation accepted. Redirecting…
            </Text>
          ) : (
            <View className="flex-row items-center">
              <ActivityIndicator color="#0f1626" />
              <Text className="ml-3 font-mono text-xs uppercase tracking-widest text-ink/60">
                Accepting invitation…
              </Text>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
