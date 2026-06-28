import { openingBalanceUpsertSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DateField } from '../../../components/DateField';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';

// Mirror of apps/web's /owner-money/opening-balance. "Starting balances" — what
// the business already had when it started. One per company (upsert); the
// double-entry is hidden behind plain language.
const todayIso = () => new Date().toISOString().slice(0, 10);

export default function OpeningBalanceScreen() {
  const router = useRouter();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);

  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [cash, setCash] = useState('');
  const [receivables, setReceivables] = useState('');
  const [payables, setPayables] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const didBootstrap = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (didBootstrap.current) return;
      didBootstrap.current = true;
      let active = true;
      (async () => {
        const compRes = await api.api.companies.$get();
        if (!active || !compRes.ok) return;
        const { companies } = await compRes.json();
        const company = await pickActiveCompany(companies);
        if (!company) return;
        setCompanyId(company.id);
        const obRes = await api.api['owner-money']['opening-balance'].$get({
          query: { companyId: company.id },
        });
        if (active && obRes.ok) {
          const { openingBalance } = await obRes.json();
          if (openingBalance) {
            setHasExisting(true);
            setAsOfDate(openingBalance.asOfDate);
            setCash(openingBalance.cash);
            setReceivables(openingBalance.receivables);
            setPayables(openingBalance.payables);
          }
        }
      })()
        .catch(() => {})
        .finally(() => {
          if (active) setBootstrapped(true);
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const noCompany = bootstrapped && companyId === null;
  const canSubmit =
    !submitting &&
    !noCompany &&
    (Number(cash) > 0 || Number(receivables) > 0 || Number(payables) > 0);

  async function onSubmit() {
    if (!companyId) return;
    setFormError(null);
    setFieldErrors({});
    const parsed = openingBalanceUpsertSchema.safeParse({
      companyId,
      asOfDate: asOfDate.trim(),
      cash: cash.trim() === '' ? undefined : cash.trim(),
      receivables: receivables.trim() === '' ? undefined : receivables.trim(),
      payables: payables.trim() === '' ? undefined : payables.trim(),
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0] ?? '_');
        if (!errs[k]) errs[k] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.api['owner-money']['opening-balance'].$put({ json: parsed.data });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(b?.error ?? 'save_failed');
        return;
      }
      router.replace('/owner-money');
    } catch {
      setFormError('save_failed');
    } finally {
      setSubmitting(false);
    }
  }

  function onClear() {
    if (!companyId) return;
    Alert.alert('Clear starting balances?', 'This removes them from your books.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          setSubmitting(true);
          try {
            const res = await api.api['owner-money']['opening-balance'].$delete({
              query: { companyId },
            });
            if (res.ok || res.status === 404) router.replace('/owner-money');
          } finally {
            setSubmitting(false);
          }
        },
      },
    ]);
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              ← My Money
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Starting balances</Text>
          <Text className="mt-2 text-sm text-ink/60">
            What your business already had when you started. Fill in what applies; leave the rest
            blank.
          </Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <DateField
              label="When did you start? *"
              value={asOfDate}
              onChange={setAsOfDate}
              error={fieldErrors.asOfDate}
            />
            <MoneyField
              label="Money in the bank"
              hint="How much was in the business account when you started."
              value={cash}
              onChangeText={setCash}
              error={fieldErrors.cash}
            />
            <MoneyField
              label="Money customers already owed you"
              hint="Unpaid work from before you started here."
              value={receivables}
              onChangeText={setReceivables}
            />
            <MoneyField
              label="Money you already owed"
              hint="Bills or suppliers you hadn't paid yet."
              value={payables}
              onChangeText={setPayables}
            />

            {noCompany ? (
              <Text className="text-xs text-oxblood">No company in this workspace.</Text>
            ) : null}

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className="mt-2 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
            >
              {submitting ? (
                <ActivityIndicator color="#f4ede0" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">Save</Text>
              )}
            </Pressable>

            {hasExisting ? (
              <Pressable
                onPress={onClear}
                disabled={submitting}
                className="mt-2 self-start rounded-sm border border-oxblood/30 px-4 py-3 active:bg-oxblood/5 disabled:opacity-50"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                  Clear starting balances
                </Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MoneyField({
  label,
  hint,
  value,
  onChangeText,
  error,
}: {
  label: string;
  hint: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text className="mt-0.5 text-xs text-ink/45">{hint}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        placeholder="0.00"
        className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-right font-mono text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}
