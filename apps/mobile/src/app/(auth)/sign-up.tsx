import { COPY } from '@thalermark/brand';
import { checkPassword } from '@thalermark/validation';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PasswordStrength } from '../../components/PasswordStrength';
import { SocialSignIn } from '../../components/SocialSignIn';
import { authClient } from '../../lib/auth-client';
import { getAuthToken } from '../../lib/secure-store';

export default function SignUp() {
  const { invite } = useLocalSearchParams<{ invite?: string }>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // After a fresh (non-invite) signup the server requires email verification
  // before sign-in, so there's no session yet — show the check-your-inbox state
  // with a resend instead of bouncing into the gate (which would dead-end at
  // sign-in with no explanation). See the api's requireEmailVerification wiring.
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  async function onSubmit() {
    setError(null);
    const pwCheck = checkPassword(password);
    if (!pwCheck.ok) {
      setError(pwCheck.message);
      return;
    }
    setSubmitting(true);
    // An unreachable server REJECTS rather than returning an error result, and
    // this used to have no catch, so the button span forever with nothing said
    // (TMC-272). Found on a real device: Android blocks cleartext in a release
    // build, so the request failed before a socket was even opened, and the
    // screen just sat there. The cause varies (no signal, server down, a
    // self-host address typed wrong in Advanced); the dead spinner did not.
    // `finally` owns the pending flag so no path can leave it stuck.
    try {
      const result = await authClient.signUp.email({ email, password, name });
      if (result.error) {
        setError(result.error.message ?? 'Sign-up failed');
        return;
      }
      // Invited signups are auto-verified (the invite already proves email
      // ownership) → they get a session immediately, so continue into the app.
      if (invite) {
        router.replace({ pathname: '/accept-invite', params: { token: invite } });
        return;
      }
      // Fresh signup: a session exists only when verification is OFF (self-host
      // without a mailer) — auth-client stores the bearer token in that case.
      // Token present → straight into the app; absent → verification is required,
      // so show the check-your-inbox state (the server already sent the link).
      const token = await getAuthToken();
      if (token) {
        router.replace('/');
      } else {
        setAwaitingVerification(true);
      }
    } catch {
      setError("Couldn't reach the server. Check your connection, or the address under Advanced.");
    } finally {
      setSubmitting(false);
    }
  }

  // Re-send the verification link. No callbackURL: the link verifies the account
  // server-side, then the user returns here and signs in (a bearer client can't
  // adopt the cookie session that autoSignInAfterVerification would create).
  async function onResend() {
    setResending(true);
    setResent(false);
    try {
      await authClient.sendVerificationEmail({ email });
      setResent(true);
    } finally {
      setResending(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          Get early access
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">{COPY.signUp.title}</Text>

        {awaitingVerification ? (
          <View className="mt-8 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-5 py-4">
            <Text className="font-serif text-lg text-ink">Check your inbox.</Text>
            <Text className="mt-2 text-sm text-ink/75">
              We sent a verification link to <Text className="font-medium text-ink">{email}</Text>.
              Open it to finish setting up your account, then come back and sign in.
            </Text>
            <View className="mt-4 flex-row items-center gap-4">
              <Pressable
                onPress={onResend}
                disabled={resending}
                className="rounded-sm border border-ink/25 px-4 py-2 active:bg-ink/5 disabled:opacity-50"
              >
                <Text className="text-sm font-medium text-ink">
                  {resending ? 'Sending…' : 'Resend email'}
                </Text>
              </Pressable>
              {resent ? (
                <Text className="font-mono text-xs uppercase tracking-widest text-sage">Sent</Text>
              ) : null}
            </View>
            <Pressable onPress={() => router.replace('/sign-in')} className="mt-5">
              <Text className="text-sm text-gold-deep underline">Back to sign in</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View className="mt-8 gap-5">
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  Name
                </Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  autoComplete="name"
                  className="mt-2 border-b border-ink/30 py-2 text-ink"
                />
              </View>
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  Email
                </Text>
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
                  autoComplete="new-password"
                  className="mt-2 border-b border-ink/30 py-2 text-ink"
                />
                <PasswordStrength password={password} />
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
                    {COPY.signUp.submit}
                  </Text>
                )}
              </Pressable>
            </View>

            {invite ? null : <SocialSignIn />}

            <View className="mt-8 flex-row justify-center">
              <Text className="text-sm text-ink/70">Already have an account? </Text>
              <Link
                href={invite ? { pathname: '/sign-in', params: { invite } } : '/sign-in'}
                className="text-sm text-gold-deep underline"
              >
                Sign in
              </Link>
            </View>

            <View className="mt-10 flex-row justify-center">
              <Link
                href="/server"
                className="font-mono text-xs uppercase tracking-widest text-ink/50"
              >
                Advanced
              </Link>
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
