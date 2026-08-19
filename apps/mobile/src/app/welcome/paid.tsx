import { Ionicons } from '@expo/vector-icons';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WelcomeHeader } from '../../components/WelcomeHeader';
import { pickActiveCompany } from '../../lib/active-company';
import { api } from '../../lib/api';

// Step 2 — Getting paid. The offline methods (cash / check / Venmo / Zelle) that
// print as instructions on the public invoice. Stripe Connect is NOT here — it's
// a multi-minute external onboarding that would stall the wizard; we point at
// Settings → Payments for it. "Skip for now" jumps to Step 3 without saving.
// Mirror of web's welcome/paid.
export default function WelcomePaid() {
  const router = useRouter();
  const [load, setLoad] = useState<'loading' | 'ready' | 'gone' | 'error'>('loading');
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [cash, setCash] = useState(false);
  const [check, setCheck] = useState(false);
  const [checkPayableTo, setCheckPayableTo] = useState('');
  const [checkAddress, setCheckAddress] = useState('');
  const [venmo, setVenmo] = useState('');
  const [zelle, setZelle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bootstrapped = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (bootstrapped.current) return;
      bootstrapped.current = true;
      let active = true;
      (async () => {
        const res = await api.api.companies.$get();
        if (!active) return;
        if (!res.ok) {
          setLoad('error');
          return;
        }
        const { companies } = await res.json();
        const picked = await pickActiveCompany(companies);
        const row = companies.find((c) => c.id === picked?.id);
        if (!row) {
          setLoad('gone');
          return;
        }
        setCompanyId(row.id);
        setCompanyName(row.name);
        setCash(row.paymentCashEnabled);
        setCheck(row.paymentCheckEnabled);
        setCheckPayableTo(row.paymentCheckPayableTo ?? '');
        setCheckAddress(row.paymentCheckAddress ?? '');
        setVenmo(row.paymentVenmoHandle ?? '');
        setZelle(row.paymentZelleContact ?? '');
        setLoad('ready');
      })().catch(() => {
        if (active) setLoad('error');
      });
      return () => {
        active = false;
      };
    }, []),
  );

  async function onContinue() {
    if (!companyId) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: companyId },
        json: {
          paymentCashEnabled: cash,
          paymentCheckEnabled: check,
          paymentCheckPayableTo: checkPayableTo.trim(),
          paymentCheckAddress: checkAddress.trim(),
          paymentVenmoHandle: venmo.trim(),
          paymentZelleContact: zelle.trim(),
        },
      });
      if (!res.ok) {
        setSubmitting(false);
        setError('Could not save. Please try again.');
        return;
      }
      router.replace('/welcome/brand');
    } catch {
      setSubmitting(false);
      setError('Could not save. Please try again.');
    }
  }

  if (load === 'gone') return <Redirect href="/" />;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        <WelcomeHeader step={2} />

        {load === 'loading' ? (
          <View className="mt-16 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : load === 'error' ? (
          <Text className="mt-10 text-sm text-oxblood">Couldn't load your business.</Text>
        ) : (
          <>
            <Text className="mt-8 font-mono text-xs uppercase tracking-widest text-gold-deep">
              Getting paid
            </Text>
            <Text className="mt-3 font-serif text-3xl font-light text-ink">
              How do you want to get paid?
            </Text>
            <Text className="mt-3 text-sm text-ink-muted">
              These print as instructions on your invoices — you mark them paid yourself when the
              money lands. To accept card payments online, connect Stripe later in Settings →
              Payments.
            </Text>

            <View className="mt-8">
              <Checkbox
                label="Accept cash (in person)"
                value={cash}
                onToggle={() => setCash((v) => !v)}
              />
              <Checkbox label="Accept check" value={check} onToggle={() => setCheck((v) => !v)} />
              {check ? (
                <View className="mt-3 gap-3">
                  <TextInput
                    value={checkPayableTo}
                    onChangeText={setCheckPayableTo}
                    placeholder={`Make payable to (defaults to ${companyName})`}
                    placeholderClassName="text-ink-subtle"
                    className="rounded-sm border border-field bg-cream px-3 py-2 text-ink"
                  />
                  <TextInput
                    value={checkAddress}
                    onChangeText={setCheckAddress}
                    placeholder="Mailing address (optional)"
                    placeholderClassName="text-ink-subtle"
                    multiline
                    className="min-h-[60px] rounded-sm border border-field bg-cream px-3 py-2 text-ink"
                  />
                </View>
              ) : null}

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Venmo handle
              </Text>
              <TextInput
                value={venmo}
                onChangeText={setVenmo}
                placeholder="@your-handle"
                placeholderClassName="text-ink-subtle"
                autoCapitalize="none"
                className="mt-2 rounded-sm border border-field bg-cream px-3 py-2 text-ink"
              />

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Zelle email or phone
              </Text>
              <TextInput
                value={zelle}
                onChangeText={setZelle}
                placeholder="you@example.com or 555-0100"
                placeholderClassName="text-ink-subtle"
                autoCapitalize="none"
                className="mt-2 rounded-sm border border-field bg-cream px-3 py-2 text-ink"
              />
            </View>

            {error ? (
              <Text className="mt-6 font-mono text-xs uppercase tracking-widest text-oxblood">
                {error}
              </Text>
            ) : null}

            <View className="mt-8 flex-row items-center justify-between">
              <Pressable onPress={() => router.replace('/welcome/brand')} className="px-2 py-2">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Skip for now
                </Text>
              </Pressable>
              <Pressable
                onPress={onContinue}
                disabled={submitting}
                className="rounded-sm bg-ink px-6 py-3 active:bg-gold-deep disabled:opacity-50"
              >
                {submitting ? (
                  <ActivityIndicator className="text-cream" />
                ) : (
                  <Text className="text-sm font-medium text-cream">Continue</Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Checkbox({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable onPress={onToggle} className="mt-4 flex-row items-center gap-3">
      <Ionicons
        name={value ? 'checkbox' : 'square-outline'}
        size={22}
        color={value ? '#9a7b4f' : '#0f162680'}
      />
      <Text className="text-sm text-ink">{label}</Text>
    </Pressable>
  );
}
