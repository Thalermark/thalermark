import { Link, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../lib/api';
import { apiErrorMessage } from '../../lib/api-errors';
import { authClient } from '../../lib/auth-client';

// Mirror of apps/web's accept-invite. Lives outside (app) so unauthed users can
// land here from a deep link (thalermark://accept-invite?token=...) and get
// pushed to sign-in / sign-up with the token preserved. Reworked from auto-
// firing accept on mount to an explicit prompt: show who's inviting + which
// workspace, then Accept / Decline. (The in-app path — Home notice → Workspace
// screen banners — covers already-signed-in users.)
type Preview = { accountName: string; inviterName: string | null };
type Status =
  | 'loading'
  | 'no-token'
  | 'unauthed'
  | 'invalid'
  | 'ready'
  | 'working'
  | 'declined'
  | 'error';

export default function AcceptInvite() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [status, setStatus] = useState<Status>('loading');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!token) {
      setStatus('no-token');
      return;
    }
    authClient
      .getSession()
      .then(async (res) => {
        if (!active) return;
        if (!res.data?.user) {
          setStatus('unauthed');
          return;
        }
        // Authed: load the preview so we can name the inviter + workspace.
        const r = await api.api.invitations[':token'].$get({ param: { token } });
        if (!active) return;
        if (!r.ok) {
          setStatus('invalid');
          return;
        }
        const body = await r.json();
        if (body.expired || body.accepted) {
          setStatus('invalid');
          return;
        }
        setPreview({ accountName: body.accountName, inviterName: body.inviterName });
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('unauthed');
      });
    return () => {
      active = false;
    };
  }, [token]);

  async function respond(decision: 'accept' | 'decline') {
    if (!token) return;
    setStatus('working');
    setError(null);
    try {
      const res =
        decision === 'accept'
          ? await api.api.invitations[':token'].accept.$post({ param: { token } })
          : await api.api.invitations[':token'].decline.$post({ param: { token } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // The first screen a new team member ever sees. A raw code or an HTTP
        // status here is the product's first impression (TMC-220).
        setError(
          apiErrorMessage(body.error, 'That invitation could not be accepted. Ask for a new one.'),
        );
        setStatus('error');
        return;
      }
      if (decision === 'accept') {
        router.replace('/');
      } else {
        setStatus('declined');
      }
    } catch (err) {
      // `err.message` is whatever the runtime threw — "Network request failed"
      // is the common one, and it is not copy.
      setError('Could not reach Thalermark. Check your connection and try again.');
      setStatus('error');
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          Invitation
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Workspace invite</Text>

        <View className="mt-8">
          {status === 'no-token' || status === 'invalid' ? (
            <Text className="text-sm text-ink/75">That invitation link is no longer valid.</Text>
          ) : status === 'unauthed' ? (
            <View>
              <Text className="text-sm text-ink/75">
                Sign in or create an account to respond to this invitation.
              </Text>
              <View className="mt-6 gap-3">
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
          ) : status === 'declined' ? (
            <View>
              <Text className="text-sm text-ink/75">You've declined this invitation.</Text>
              <Pressable
                onPress={() => router.replace('/')}
                className="mt-6 rounded-sm bg-ink px-3 py-3 active:bg-gold-deep"
              >
                <Text className="text-center text-sm font-medium text-cream">Go to Thalermark</Text>
              </Pressable>
            </View>
          ) : status === 'ready' || status === 'working' || status === 'error' ? (
            <View>
              {preview ? (
                <Text className="text-sm text-ink/75">
                  {preview.inviterName ? `${preview.inviterName} invited` : "You've been invited"}{' '}
                  you to join <Text className="font-medium text-ink">{preview.accountName}</Text>.
                </Text>
              ) : null}
              {status === 'error' ? (
                <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-oxblood">
                  {error ?? 'Something went wrong.'}
                </Text>
              ) : null}
              <View className="mt-6 flex-row items-center gap-3">
                <Pressable
                  onPress={() => respond('accept')}
                  disabled={status === 'working'}
                  className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-cream">Accept</Text>
                </Pressable>
                <Pressable
                  onPress={() => respond('decline')}
                  disabled={status === 'working'}
                  className="rounded-sm border border-ink/30 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-ink">Decline</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View className="flex-row items-center">
              <ActivityIndicator color="#0f1626" />
              <Text className="ml-3 font-mono text-xs uppercase tracking-widest text-ink/60">
                Loading invitation…
              </Text>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
