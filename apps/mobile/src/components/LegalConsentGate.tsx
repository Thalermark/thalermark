import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { api } from '../lib/api';
import { getServerUrl } from '../lib/server-url';

// Blocking legal-consent gate (spikes/SIGN-UP-ACK-TOS.md) — the native sibling
// of web's LegalConsent.svelte. The (app) gate renders this when the deployment
// requires Terms/Privacy consent and the signed-in user hasn't accepted the
// current version. Tapping the checkbox is the clickwrap act; "Agree & continue"
// records it (POST /api/legal/accept) and re-runs the gate. Gating app ENTRY (not
// the sign-up form) is what lets one mechanism cover every door — including the
// social OAuth callback, which carries no form body.
export function LegalConsentGate({
  termsUrl,
  privacyUrl,
  onAccepted,
}: {
  termsUrl: string;
  privacyUrl: string;
  onAccepted: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  // The template URLs are web paths (e.g. /legal/terms) served by the web app, so
  // resolve a relative path against the configured server origin; an absolute
  // https:// URL (a real hosted policy) opens as-is.
  const openUrl = (url: string) => {
    const abs = /^https?:\/\//.test(url) ? url : `${getServerUrl().replace(/\/$/, '')}${url}`;
    Linking.openURL(abs).catch(() => {});
  };

  const submit = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    setError(false);
    try {
      const res = await api.api.legal.accept.$post();
      if (!res.ok) throw new Error('accept failed');
      onAccepted();
    } catch {
      setError(true);
      setSubmitting(false);
    }
  };

  return (
    <View className="flex-1 justify-center bg-cream px-6">
      <View className="rounded-sm border border-ink/15 bg-white px-5 py-6">
        <Text className="font-mono text-[11px] uppercase tracking-widest text-ink-subtle">
          One quick thing
        </Text>
        <Text className="mt-2 font-serif text-2xl text-ink">Before you continue</Text>
        <Text className="mt-3 text-sm text-ink-muted">
          To use Thalermark, please review and accept our terms.
        </Text>

        <Pressable onPress={() => setAgreed((v) => !v)} className="mt-5 flex-row items-start gap-3">
          <Ionicons
            name={agreed ? 'checkbox' : 'square-outline'}
            size={22}
            color={agreed ? '#9a7b4f' : '#0f162680'}
          />
          <Text className="flex-1 text-sm text-ink/80">
            I agree to the{' '}
            <Text className="text-gold-deep underline" onPress={() => openUrl(termsUrl)}>
              Terms of Service
            </Text>{' '}
            and{' '}
            <Text className="text-gold-deep underline" onPress={() => openUrl(privacyUrl)}>
              Privacy Policy
            </Text>
            .
          </Text>
        </Pressable>

        {error ? (
          <Text className="mt-3 text-sm text-oxblood">Couldn't save that — please try again.</Text>
        ) : null}

        <Pressable
          onPress={submit}
          disabled={!agreed || submitting}
          className={`mt-6 flex-row items-center justify-center rounded-sm px-4 py-3 ${
            agreed ? 'bg-ink active:bg-gold-deep' : 'bg-ink/30'
          }`}
        >
          {submitting ? (
            <ActivityIndicator className="text-cream" />
          ) : (
            <Text className="text-sm font-medium text-cream">Agree &amp; continue</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
