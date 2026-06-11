import { INVITE_ROLES, type InviteRole, type Role, can } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { changeMemberRole, sendInvite, transferOwnership } from '../../../lib/invitations';

// Mirror of apps/web's /settings/team. Roles (v1.1) gate what each member can
// do: the owner has full control, owner/admin can manage the team (invite,
// change roles, remove). Role mutations go through lib/invitations.ts (raw
// fetch — the API routes have no json validator the typed hc client can carry).
type Member = {
  userId: string;
  name: string | null;
  email: string;
  role: string;
  joinedAt: string;
  isYou: boolean;
};
type Invitation = {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  declined: boolean;
};
type TeamState =
  | { state: 'loading' }
  | { state: 'ready'; members: Member[]; invitations: Invitation[] }
  | { state: 'error' };

const fmtDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  accountant: 'Accountant',
  viewer: 'Viewer',
};

// One-liners shown under each option in the role picker — the user-facing gloss
// of the capability bundles in @thalermark/validation.
const ROLE_BLURBS: Record<InviteRole, string> = {
  admin: 'Everything except billing and ownership.',
  member: 'Invoices, estimates, customers, expenses.',
  accountant: 'Expenses and exports — for your bookkeeper.',
  viewer: 'Read-only access.',
};

// Maps the API error codes to a human line, matching web's INVITE/MEMBER_ERRORS.
const INVITE_ERRORS: Record<string, string> = {
  invalid_email: "That doesn't look like a valid email address.",
  mailer_not_configured: 'Email is not configured on this server, so the invite could not be sent.',
  mailer_send_failed: "The invite was saved but the email couldn't be sent. Try again.",
  network: "Couldn't reach the server. Check your connection and try again.",
};

const MEMBER_ERRORS: Record<string, string> = {
  cannot_remove_owner: "The workspace owner can't be removed.",
  cannot_change_owner: "The owner's role can't be changed — transfer ownership instead.",
  member_not_found: 'That person is no longer a member.',
  invalid_role: 'That is not a valid role.',
  forbidden: "You don't have permission to do that.",
  already_owner: 'That person is already the owner.',
  network: "Couldn't reach the server. Check your connection and try again.",
};

export default function Team() {
  const router = useRouter();
  const [team, setTeam] = useState<TeamState>({ state: 'loading' });
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole>('member');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  // The role-picker bottom sheet, opened either for the invite form or for a
  // specific member's role change.
  const [rolePicker, setRolePicker] = useState<
    { kind: 'invite' } | { kind: 'member'; userId: string; name: string } | null
  >(null);

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

  // The viewer's own role drives which controls render; the API is the real
  // authority — these gates only keep the UI honest. Derived from the loaded
  // members (not the gate context) so it stays fresh after a transfer reload.
  const myRole = (team.state === 'ready' ? team.members.find((m) => m.isYou)?.role : undefined) as
    | Role
    | undefined;
  const canManageTeam = myRole ? can(myRole, 'team:manage') : false;
  const canTransfer = myRole ? can(myRole, 'workspace:manage') : false;

  async function onInvite() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError(INVITE_ERRORS.invalid_email);
      return;
    }
    setSending(true);
    setError(null);
    setSentTo(null);
    const result = await sendInvite(trimmed, inviteRole);
    setSending(false);
    if (result.ok) {
      setSentTo(trimmed);
      setEmail('');
      load(() => true); // refresh pending list
    } else {
      setError(INVITE_ERRORS[result.error] ?? 'Could not send the invite.');
    }
  }

  // Remove another member, or leave the workspace (when userId is yourself).
  // The API enforces the owner guard. On leaving, bounce home so the gate
  // re-resolves the active workspace (a remaining one, or the picker).
  async function onMembership(userId: string, isSelf: boolean) {
    setBusyUser(userId);
    setMemberError(null);
    try {
      const res = await api.api.team[':userId'].$delete({ param: { userId } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMemberError(MEMBER_ERRORS[body.error ?? ''] ?? 'Could not update membership.');
        setBusyUser(null);
        return;
      }
      if (isSelf) {
        router.replace('/');
        return;
      }
      setBusyUser(null);
      load(() => true);
    } catch {
      setMemberError('Could not update membership.');
      setBusyUser(null);
    }
  }

  // A role was picked from the bottom sheet — either set the invite default or
  // change an existing member's role.
  function onPickRole(role: InviteRole) {
    const picker = rolePicker;
    setRolePicker(null);
    if (!picker) return;
    if (picker.kind === 'invite') {
      setInviteRole(role);
      return;
    }
    void changeRoleFor(picker.userId, role);
  }

  async function changeRoleFor(userId: string, role: InviteRole) {
    setBusyUser(userId);
    setMemberError(null);
    const res = await changeMemberRole(userId, role);
    if (res.ok) load(() => true);
    else setMemberError(MEMBER_ERRORS[res.error] ?? 'Could not change that role.');
    setBusyUser(null);
  }

  function onTransfer(userId: string, name: string) {
    Alert.alert('Make owner?', `Make ${name} the owner? You'll become an admin.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Make owner', style: 'destructive', onPress: () => void doTransfer(userId) },
    ]);
  }

  async function doTransfer(userId: string) {
    setBusyUser(userId);
    setMemberError(null);
    const res = await transferOwnership(userId);
    if (res.ok) load(() => true);
    else setMemberError(MEMBER_ERRORS[res.error] ?? 'Could not transfer ownership.');
    setBusyUser(null);
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
            Invite teammates and set what each can do — from full admins to view-only accountants.
            The owner has complete control; everyone else gets the access their role grants.
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
                    className={`flex-row items-start justify-between px-5 py-4 ${
                      i > 0 ? 'border-t border-ink/10' : ''
                    }`}
                  >
                    <View className="flex-1">
                      <View className="flex-row items-center gap-2">
                        <Text className="font-serif text-lg text-ink">{m.name ?? m.email}</Text>
                        {m.isYou ? (
                          <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
                            You
                          </Text>
                        ) : null}
                      </View>
                      <Text className="mt-0.5 text-sm text-ink/60">{m.email}</Text>
                      <Text className="mt-0.5 text-xs text-ink/40">
                        Joined {fmtDate(m.joinedAt)}
                      </Text>
                    </View>
                    <View className="ml-3 items-end gap-2">
                      {/* Role: owner badge, an inline picker for a team manager
                          looking at another member, or a static label. */}
                      {m.role === 'owner' ? (
                        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                          Owner
                        </Text>
                      ) : canManageTeam && !m.isYou ? (
                        <Pressable
                          onPress={() =>
                            setRolePicker({
                              kind: 'member',
                              userId: m.userId,
                              name: m.name ?? m.email,
                            })
                          }
                          disabled={busyUser === m.userId}
                          className="rounded-sm border border-ink/20 px-2 py-1 active:border-gold-deep disabled:opacity-50"
                        >
                          <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                            {ROLE_LABELS[m.role] ?? m.role} ▾
                          </Text>
                        </Pressable>
                      ) : (
                        <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
                          {ROLE_LABELS[m.role] ?? m.role}
                        </Text>
                      )}

                      {/* Actions */}
                      {m.isYou && m.role !== 'owner' ? (
                        <Pressable
                          onPress={() => onMembership(m.userId, true)}
                          disabled={busyUser === m.userId}
                          className="rounded-sm border border-ink/30 px-3 py-1.5 active:bg-ink/5 disabled:opacity-50"
                        >
                          <Text className="text-sm font-medium text-ink">Leave</Text>
                        </Pressable>
                      ) : m.role !== 'owner' && (canTransfer || canManageTeam) ? (
                        <View className="flex-row gap-2">
                          {canTransfer ? (
                            <Pressable
                              onPress={() => onTransfer(m.userId, m.name ?? m.email)}
                              disabled={busyUser === m.userId}
                              className="rounded-sm border border-ink/30 px-3 py-1.5 active:bg-ink/5 disabled:opacity-50"
                            >
                              <Text className="text-sm font-medium text-ink">Make owner</Text>
                            </Pressable>
                          ) : null}
                          {canManageTeam ? (
                            <Pressable
                              onPress={() => onMembership(m.userId, false)}
                              disabled={busyUser === m.userId}
                              className="rounded-sm border border-ink/30 px-3 py-1.5 active:bg-ink/5 disabled:opacity-50"
                            >
                              <Text className="text-sm font-medium text-ink">Remove</Text>
                            </Pressable>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
              {memberError ? (
                <Text className="mt-3 text-sm text-oxblood">{memberError}</Text>
              ) : null}

              {/* Invite — only for roles that can manage the team. */}
              {canManageTeam ? (
                <>
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
                    onPress={() => setRolePicker({ kind: 'invite' })}
                    className="mt-3 flex-row items-center justify-between rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5"
                  >
                    <Text className="text-ink">{ROLE_LABELS[inviteRole]}</Text>
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
                      Role ▾
                    </Text>
                  </Pressable>
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
                </>
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
                        {inv.declined ? (
                          <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
                            Declined
                          </Text>
                        ) : inv.expired ? (
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

      {/* Role picker — shared by the invite form and per-member role change. */}
      <Modal
        visible={rolePicker !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setRolePicker(null)}
      >
        <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setRolePicker(null)}>
          <Pressable className="rounded-t-lg bg-cream px-6 pb-10 pt-5" onPress={() => {}}>
            <Text className="font-serif text-xl text-ink">Choose role</Text>
            <View className="mt-4">
              {INVITE_ROLES.map((r) => (
                <Pressable
                  key={r}
                  onPress={() => onPickRole(r)}
                  className="border-b border-ink/10 py-3"
                >
                  <Text className="text-ink">{ROLE_LABELS[r]}</Text>
                  <Text className="text-xs text-ink/50">{ROLE_BLURBS[r]}</Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
