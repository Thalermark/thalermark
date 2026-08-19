import { checkPassword } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PasswordStrength } from '../../../components/PasswordStrength';
import { authClient } from '../../../lib/auth-client';

// Personal profile — native mirror of apps/web's /settings/profile. Display name
// + change password for the signed-in user (no email change — that needs
// re-verification, out of scope). Uses the Better Auth client directly
// (updateUser / changePassword); the /change-password endpoint enforces the same
// password policy as signup server-side, this screen just gives instant feedback.
//
// Social-only logins (a trusted provider, no `credential` account) have no
// password to change, so they get an explanatory banner instead of the form.
export default function Profile() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [hasPassword, setHasPassword] = useState(false);

  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  const [sendingReset, setSendingReset] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      Promise.all([authClient.getSession(), authClient.listAccounts()])
        .then(([sessionRes, accountsRes]) => {
          if (!alive) return;
          const user = sessionRes.data?.user;
          if (user) {
            setName(user.name ?? '');
            setSavedName(user.name ?? '');
            setEmail(user.email ?? '');
          }
          setHasPassword((accountsRes.data ?? []).some((a) => a.providerId === 'credential'));
          setLoading(false);
        })
        .catch(() => {
          if (alive) setLoading(false);
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  async function onSaveName() {
    setNameError(null);
    setNameSaved(false);
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Name cannot be empty.');
      return;
    }
    setSavingName(true);
    const result = await authClient.updateUser({ name: trimmed });
    setSavingName(false);
    if (result.error) {
      setNameError(result.error.message ?? 'Could not update your name.');
      return;
    }
    setSavedName(trimmed);
    setNameSaved(true);
  }

  async function onChangePassword() {
    setPwError(null);
    setPwDone(false);
    const check = checkPassword(newPassword);
    if (!check.ok) {
      setPwError(check.message);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match.');
      return;
    }
    setChangingPw(true);
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setChangingPw(false);
    if (result.error) {
      setPwError(
        result.error.code === 'INVALID_PASSWORD'
          ? 'Your current password is incorrect.'
          : (result.error.message ?? 'Could not change your password.'),
      );
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPwDone(true);
  }

  // Email a reset link to the user's own address (same flow as forgot-password)
  // for the "I forgot my current password" escape hatch.
  async function onSendResetLink() {
    setSendingReset(true);
    await authClient.requestPasswordReset({ email });
    setSendingReset(false);
    setResetSent(true);
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/more')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← More
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Profile</Text>

        {loading ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : (
          <>
            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Your details
              </Text>

              <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Display name
              </Text>
              <TextInput
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  setNameSaved(false);
                }}
                autoComplete="name"
                className="mt-2 border-b border-field py-2 text-ink"
              />

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Email
              </Text>
              <Text className="mt-2 py-2 text-ink-subtle">{email}</Text>
              <Text className="text-xs text-ink-subtle">Email can't be changed.</Text>

              {nameError ? (
                <Text className="mt-3 font-mono text-xs uppercase tracking-widest text-oxblood">
                  {nameError}
                </Text>
              ) : null}
              <View className="mt-5 flex-row items-center gap-4">
                <Pressable
                  onPress={onSaveName}
                  disabled={savingName || name.trim() === savedName}
                  className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-cream">Save</Text>
                </Pressable>
                {nameSaved ? <Text className="text-sm text-ink-subtle">Saved.</Text> : null}
              </View>
            </View>

            <View className="mt-6 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Password
              </Text>

              {hasPassword ? (
                <>
                  {pwDone ? (
                    <Text className="mt-3 text-sm text-ink-muted">
                      Password updated. Other devices have been signed out.
                    </Text>
                  ) : null}

                  <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    Current password
                  </Text>
                  <TextInput
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    secureTextEntry
                    autoComplete="current-password"
                    className="mt-2 border-b border-field py-2 text-ink"
                  />

                  <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    New password
                  </Text>
                  <TextInput
                    value={newPassword}
                    onChangeText={(v) => {
                      setNewPassword(v);
                      setPwDone(false);
                    }}
                    secureTextEntry
                    autoComplete="new-password"
                    className="mt-2 border-b border-field py-2 text-ink"
                  />
                  <PasswordStrength password={newPassword} />

                  <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    Confirm new password
                  </Text>
                  <TextInput
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                    autoComplete="new-password"
                    className="mt-2 border-b border-field py-2 text-ink"
                  />

                  {pwError ? (
                    <Text className="mt-3 font-mono text-xs uppercase tracking-widest text-oxblood">
                      {pwError}
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={onChangePassword}
                    disabled={changingPw}
                    className="mt-5 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                  >
                    <Text className="text-center text-sm font-medium text-cream">
                      {changingPw ? 'Updating…' : 'Change password'}
                    </Text>
                  </Pressable>

                  {resetSent ? (
                    <Text className="mt-5 text-sm text-ink-muted">
                      We've emailed a reset link to {email}. It expires in one hour.
                    </Text>
                  ) : (
                    <Pressable onPress={onSendResetLink} disabled={sendingReset} className="mt-5">
                      <Text className="text-sm text-gold-deep underline">
                        {sendingReset ? 'Sending…' : 'Forgot your current password?'}
                      </Text>
                    </Pressable>
                  )}
                </>
              ) : (
                <Text className="mt-3 text-sm text-ink-muted">
                  You sign in with a connected account, so there's no password on this account to
                  change.
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
