import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { sendInvite } from '../../../lib/invitations';

// Mirror of apps/web's /settings/team. Everyone on an account shares full
// access in MVP (no roles), so this is just: who's here + invite by email +
// pending invitations. The invite goes through lib/invitations.ts (raw fetch —
// the API route has no json validator the typed hc client can carry).
type Member = {
  userId: string;
  name: string | null;
  email: string;
  joinedAt: string;
  isYou: boolean;
};
type Invitation = {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};
type TeamState =
  | { state: 'loading' }
  | { state: 'ready'; members: Member[]; invitations: Invitation[] }
  | { state: 'error' };

const fmtDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);

// Maps the API error codes to a human line, matching web's INVITE_ERRORS.
const INVITE_ERRORS: Record<string, string> = {
  invalid_email: "That doesn't look like a valid email address.",
  mailer_not_configured: 'Email is not configured on this server, so the invite could not be sent.',
  mailer_send_failed: "The invite was saved but the email couldn't be sent. Try again.",
  network: "Couldn't reach the server. Check your connection and try again.",
};

export default function Team() {
  const router = useRouter();
  const [team, setTeam] = useState<TeamState>({ state: 'loading' });
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((active: () => boolean) => {
    api.api.team
      .$get()
      .then(async (res) => {
        if (!active()) return;
        if (!res.ok) {
          setTeam({ state: 'error' });
          return;
        }
        const { members, invitations } = await res.json();
        setTeam({ state: 'ready', members, invitations });
      })
      .catch(() => {
        if (active()) setTeam({ state: 'error' });
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load(() => alive);
      return () => {
        alive = false;
      };
    }, [load]),
  );

  async function onInvite() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError(INVITE_ERRORS.invalid_email);
      return;
    }
    setSending(true);
    setError(null);
    setSentTo(null);
    const result = await sendInvite(trimmed);
    setSending(false);
    if (result.ok) {
      setSentTo(trimmed);
      setEmail('');
      load(() => true); // refresh pending list
    } else {
      setError(INVITE_ERRORS[result.error] ?? 'Could not send the invite.');
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.push('/more')}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← More</Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Team</Text>
          <Text className="mt-3 text-sm text-ink/60">
            Everyone here shares full access to this account. Invite a teammate by email — they'll
            get a link to join.
          </Text>

          {team.state === 'loading' ? (
            <View className="mt-12 items-center">
              <ActivityIndicator color="#0f1626" />
            </View>
          ) : team.state === 'error' ? (
            <Text className="mt-8 text-sm text-oxblood">Couldn't load your team.</Text>
          ) : (
            <>
              {/* Members */}
              <Text className="mt-8 font-mono text-xs uppercase tracking-widest text-gold-deep">
                Members
              </Text>
              <View className="mt-3 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
                {team.members.map((m, i) => (
                  <View
                    key={m.userId}
                    className={`px-5 py-4 ${i > 0 ? 'border-t border-ink/10' : ''}`}
                  >
                    <View className="flex-row items-center gap-2">
                      <Text className="font-serif text-lg text-ink">{m.name ?? m.email}</Text>
                      {m.isYou ? (
                        <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
                          You
                        </Text>
                      ) : null}
                    </View>
                    <Text className="mt-0.5 text-sm text-ink/60">{m.email}</Text>
                    <Text className="mt-0.5 text-xs text-ink/40">Joined {fmtDate(m.joinedAt)}</Text>
                  </View>
                ))}
              </View>

              {/* Invite */}
              <Text className="mt-8 font-mono text-xs uppercase tracking-widest text-gold-deep">
                Invite a teammate
              </Text>
              <TextInput
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  setSentTo(null);
                  setError(null);
                }}
                placeholder="teammate@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                className="mt-3 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
              />
              <Pressable
                onPress={onInvite}
                disabled={sending || email.trim().length === 0}
                className="mt-3 self-start rounded-sm bg-ink px-4 py-2.5 active:bg-gold-deep disabled:opacity-50"
              >
                {sending ? (
                  <ActivityIndicator color="#f4ede0" size="small" />
                ) : (
                  <Text className="text-sm font-medium text-cream">Send invite</Text>
                )}
              </Pressable>
              {sentTo ? (
                <Text className="mt-3 text-sm text-ink/60">Invite sent to {sentTo}.</Text>
              ) : error ? (
                <Text className="mt-3 text-sm text-oxblood">{error}</Text>
              ) : null}

              {/* Pending */}
              {team.invitations.length > 0 ? (
                <>
                  <Text className="mt-8 font-mono text-xs uppercase tracking-widest text-gold-deep">
                    Pending invitations
                  </Text>
                  <View className="mt-3 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
                    {team.invitations.map((inv, i) => (
                      <View
                        key={inv.id}
                        className={`flex-row items-center justify-between px-5 py-4 ${
                          i > 0 ? 'border-t border-ink/10' : ''
                        }`}
                      >
                        <View className="flex-1">
                          <Text className="text-sm text-ink">{inv.email}</Text>
                          <Text className="mt-0.5 text-xs text-ink/40">
                            Sent {fmtDate(inv.createdAt)}
                          </Text>
                        </View>
                        {inv.expired ? (
                          <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                            Expired
                          </Text>
                        ) : (
                          <Text className="text-xs text-ink/50">
                            Expires {fmtDate(inv.expiresAt)}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
