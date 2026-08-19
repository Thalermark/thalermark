import { Link } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authClient } from '../../lib/auth-client';

// Reset is *requested* here but *completed on web*: the emailed link points at
// the server's PUBLIC_APP_URL/reset-password page, so it works on whatever
// device opens the inbox. The native screen is just the entry point — no
// in-app reset form, no cross-device deep-link fragility.
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function onSubmit() {
    setSubmitting(true);
    // Non-enumerating: fire the request and show the same neutral confirmation
    // regardless of the result (the API also returns a neutral 200 and sends
    // nothing for an unknown email).
    try {
      // requestPasswordReset resolves with { data, error } — it does not throw
      // on an API error, so the returned error has to be read explicitly or a
      // refusal sails straight into the "check your inbox" confirmation.
      const { error } = await authClient.requestPasswordReset({ email });
      // Exactly one refusal is worth telling the truth about. RESET_PASSWORD_DISABLED
      // (HTTP 400) means this install has no mailer that delivers, so Better Auth
      // rejects the request *before* it looks the address up — the answer is a
      // fact about the server, byte-identical for every address, so showing it
      // enumerates nothing.
      //
      // KEEP THIS BRANCH NARROW: match the code and nothing else. Every other
      // error — unknown address, rate limit, validation, anything — must keep
      // falling through to the neutral confirmation. Widening this to
      // `error.status === 400`, or to any truthy error, turns the screen into an
      // oracle for "does this account exist", which is precisely what the
      // neutral wording exists to prevent.
      if (error?.code === 'RESET_PASSWORD_DISABLED') {
        setUnavailable(true);
        return;
      }
      setSubmitted(true);
    } catch {
      // A thrown request is a transport failure, not a signal about the account.
      // Unchanged behaviour: still land on the neutral confirmation.
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-1 justify-center px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
          Account recovery
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Reset your password</Text>

        {unavailable ? (
          <View className="mt-8 rounded-sm border border-copper/40 bg-copper/5 px-4 py-4">
            <Text className="font-serif text-lg text-ink">
              Reset by email isn't available here.
            </Text>
            <Text className="mt-2 text-sm text-ink/75">
              Nothing was sent, and your password is unchanged. This Thalermark server has no email
              set up, so a reset link can't reach you. Ask whoever set it up to turn email on — then
              come back and try again.
            </Text>
          </View>
        ) : submitted ? (
          <View className="mt-8 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-4">
            <Text className="font-serif text-lg text-ink">Check your inbox.</Text>
            <Text className="mt-2 text-sm text-ink/75">
              If an account exists for <Text className="font-medium text-ink">{email}</Text>, we've
              sent a link to choose a new password. Open it in your browser to finish — the link
              expires in one hour.
            </Text>
          </View>
        ) : (
          <>
            <Text className="mt-4 text-sm text-ink/75">
              Enter your email and we'll send you a link to choose a new password.
            </Text>
            <View className="mt-8">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Email
              </Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                inputMode="email"
                keyboardType="email-address"
                className="mt-2 border-b border-field py-2 text-ink"
              />
            </View>
            <Pressable
              onPress={onSubmit}
              disabled={submitting}
              className="mt-6 rounded-sm bg-ink px-3 py-3 active:bg-gold-deep disabled:opacity-50"
            >
              {submitting ? (
                <ActivityIndicator color="#f4ede0" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">Send reset link</Text>
              )}
            </Pressable>
          </>
        )}

        <View className="mt-8 flex-row justify-center">
          <Text className="text-sm text-ink-muted">Remembered it? </Text>
          <Link href="/sign-in">
            <Text className="text-sm text-gold-deep underline">Sign in</Text>
          </Link>
        </View>
      </View>
    </SafeAreaView>
  );
}
