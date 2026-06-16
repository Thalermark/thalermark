import { COPY } from '@thalermark/brand';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SocialSignIn } from '../../components/SocialSignIn';
import { authClient } from '../../lib/auth-client';
import { getLastAuthMethod, setLastAuthMethod } from '../../lib/secure-store';
import { useSocialProviders } from '../../lib/social-providers';

// Short provider names for the wrong-method hint (the buttons use longer labels).
const PROVIDER_NAMES: Record<string, string> = {
  google: 'Google',
  facebook: 'Facebook',
  twitter: 'X',
};

// Oxford-style "A, B, or C".
function joinOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
}

export default function SignIn() {
  const { invite } = useLocalSearchParams<{ invite?: string }>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // An unverified email/password account can't sign in (the server requires
  // verification). Offer a resend rather than a dead-end error.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  const providers = useSocialProviders();
  // This device's last sign-in method — suppresses the wrong-method hint when it
  // was a password (a device-local signal that leaks nothing remotely).
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getLastAuthMethod().then((m) => {
      if (active) setLastMethod(m);
    });
    return () => {
      active = false;
    };
  }, []);

  // Option B wrong-method rescue: on any failed sign-in, nudge users who signed
  // up with a social provider toward the buttons below. Unconditional w.r.t. the
  // entered email (no email→provider lookup) so it can't leak account existence;
  // hidden when no providers are configured or this device last used a password.
  const showMethodHint = !!error && providers.length > 0 && lastMethod !== 'password';
  const methodHintText = joinOr(providers.map((p) => PROVIDER_NAMES[p] ?? p));

  async function onSubmit() {
    setError(null);
    setNeedsVerification(false);
    setSubmitting(true);
    const result = await authClient.signIn.email({ email, password });
    setSubmitting(false);
    if (result.error) {
      const msg = result.error.message ?? 'Sign-in failed';
      // BA returns EMAIL_NOT_VERIFIED for an unverified account; match the
      // message too in case the code shape shifts.
      if (result.error.code === 'EMAIL_NOT_VERIFIED' || /verif/i.test(msg)) {
        setNeedsVerification(true);
        return;
      }
      setError(msg);
      return;
    }
    await setLastAuthMethod('password');
    if (invite) {
      router.replace({ pathname: '/accept-invite', params: { token: invite } });
    } else {
      router.replace('/');
    }
  }

  // Re-send the verification link. No callbackURL: the link verifies server-side,
  // then the user signs in again here (a bearer client can't adopt the cookie
  // session autoSignInAfterVerification would create).
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
          <View className="items-end">
            <Link href="/forgot-password" className="text-sm text-gold-deep underline">
              Forgot password?
            </Link>
          </View>
          {error ? (
            <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
              {error}
            </Text>
          ) : null}
          {showMethodHint ? (
            <Text className="text-sm text-ink/60">
              Signed up with {methodHintText}? Use the button
              {providers.length > 1 ? 's' : ''} below.
            </Text>
          ) : null}
          {needsVerification ? (
            <View className="rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3">
              <Text className="text-sm text-ink/80">
                Verify your email to sign in — we sent a link to{' '}
                <Text className="font-medium text-ink">{email}</Text>.
              </Text>
              <View className="mt-3 flex-row items-center gap-4">
                <Pressable
                  onPress={onResend}
                  disabled={resending}
                  className="rounded-sm border border-ink/25 px-3 py-1.5 active:bg-ink/5 disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-ink">
                    {resending ? 'Sending…' : 'Resend verification'}
                  </Text>
                </Pressable>
                {resent ? (
                  <Text className="font-mono text-xs uppercase tracking-widest text-sage">
                    Sent
                  </Text>
                ) : null}
              </View>
            </View>
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

        {invite ? null : <SocialSignIn />}

        <View className="mt-8 flex-row justify-center">
          <Text className="text-sm text-ink/70">No account? </Text>
          <Link
            href={invite ? { pathname: '/sign-up', params: { invite } } : '/sign-up'}
            className="text-sm text-gold-deep underline"
          >
            Sign up
          </Link>
        </View>

        <View className="mt-10 flex-row justify-center">
          <Link href="/server" className="font-mono text-xs uppercase tracking-widest text-ink/50">
            Advanced
          </Link>
        </View>
      </View>
    </SafeAreaView>
  );
}
