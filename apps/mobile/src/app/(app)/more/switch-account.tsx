import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Membership } from '../../../lib/active-account';
import { api } from '../../../lib/api';
import { getActiveAccountId, setActiveAccountId } from '../../../lib/secure-store';

// In-app workspace switcher — the mobile equivalent of web's select-company /
// UserMenu Workspace area. Lists every membership (marks the active one) AND
// surfaces any pending invitations as accept/decline banners. The Home notice
// deep-links here; the More hub also links it when memberships > 1.
type Invite = { token: string; accountName: string; inviterName: string | null };
type SwitchState =
  | { state: 'loading' }
  | { state: 'ready'; memberships: Membership[]; activeId: string | null; invites: Invite[] }
  | { state: 'error' };

export default function SwitchAccount() {
  const router = useRouter();
  const [screen, setScreen] = useState<SwitchState>({ state: 'loading' });
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback((isActive: () => boolean) => {
    Promise.all([api.api.me.$get(), api.api.me.invitations.$get(), getActiveAccountId()])
      .then(async ([meRes, invRes, activeId]) => {
        if (!isActive()) return;
        if (!meRes.ok) {
          setScreen({ state: 'error' });
          return;
        }
        const { memberships } = await meRes.json();
        const invites = invRes.ok ? (await invRes.json()).invitations : [];
        setScreen({ state: 'ready', memberships, activeId, invites });
      })
      .catch(() => {
        if (isActive()) setScreen({ state: 'error' });
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      load(() => active);
      return () => {
        active = false;
      };
    }, [load]),
  );

  // Switch then bounce home: the layout gate + each tab's focus effect refetch
  // against the new x-account-id, so the whole app re-scopes to the new account.
  async function onPick(accountId: string) {
    if (screen.state === 'ready' && accountId === screen.activeId) return;
    await setActiveAccountId(accountId);
    router.replace('/');
  }

  // Accept joins + switches into the new workspace (mirror of web's accept).
  async function onAccept(token: string) {
    setBusyToken(token);
    setActionError(null);
    try {
      const res = await api.api.invitations[':token'].accept.$post({ param: { token } });
      if (!res.ok) {
        setActionError('Could not accept the invitation.');
        setBusyToken(null);
        return;
      }
      const { accountId } = await res.json();
      await setActiveAccountId(accountId);
      router.replace('/');
    } catch {
      setActionError('Could not accept the invitation.');
      setBusyToken(null);
    }
  }

  async function onDecline(token: string) {
    setBusyToken(token);
    setActionError(null);
    try {
      const res = await api.api.invitations[':token'].decline.$post({ param: { token } });
      if (!res.ok) {
        setActionError('Could not decline the invitation.');
      } else {
        load(() => true); // drop the declined invite
      }
    } catch {
      setActionError('Could not decline the invitation.');
    }
    setBusyToken(null);
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← More</Text>
        </Pressable>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Switch workspace</Text>
        <Text className="mt-3 text-sm text-ink/60">
          Pick which workspace to work in. Everything — invoices, contacts, the dashboard —
          re-scopes to your choice.
        </Text>

        {screen.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : screen.state === 'error' ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load your workspaces.</Text>
        ) : (
          <>
            {/* Pending invitations */}
            {screen.invites.map((inv) => (
              <View
                key={inv.token}
                className="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-5 py-4"
              >
                <Text className="text-sm text-ink">
                  {inv.inviterName ? `${inv.inviterName} is` : "You've been"} inviting you to join{' '}
                  <Text className="font-medium">{inv.accountName}</Text>.
                </Text>
                <View className="mt-3 flex-row items-center gap-3">
                  <Pressable
                    onPress={() => onAccept(inv.token)}
                    disabled={busyToken === inv.token}
                    className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep disabled:opacity-50"
                  >
                    <Text className="text-sm font-medium text-cream">Accept</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => onDecline(inv.token)}
                    disabled={busyToken === inv.token}
                    className="rounded-sm border border-ink/30 px-4 py-2 active:bg-ink/5 disabled:opacity-50"
                  >
                    <Text className="text-sm font-medium text-ink">Decline</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {actionError ? <Text className="mt-3 text-sm text-oxblood">{actionError}</Text> : null}

            {/* Workspaces */}
            <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
              {screen.memberships.map((m, i) => {
                const isActive = m.accountId === screen.activeId;
                return (
                  <Pressable
                    key={m.accountId}
                    onPress={() => onPick(m.accountId)}
                    disabled={isActive}
                    className={`flex-row items-center justify-between px-5 py-4 active:bg-cream ${
                      i > 0 ? 'border-t border-ink/10' : ''
                    }`}
                  >
                    <Text className="font-serif text-lg text-ink">{m.name}</Text>
                    {isActive ? (
                      <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                        Current
                      </Text>
                    ) : (
                      <Text className="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream">
                        Switch
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
