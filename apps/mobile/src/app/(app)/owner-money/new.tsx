import { type OwnerMoneyEventKind, ownerMoneyEventCreateSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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
import { DateField } from '../../../components/DateField';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/api-errors';

// Mirror of apps/web's /owner-money/new. The owner records money they put in or
// took out, in plain language; the double-entry is hidden. `kind` fully
// determines the posting (cash is always Cash 1000), so the form is just a
// two-way choice + amount + date + note.
const todayIso = () => new Date().toISOString().slice(0, 10);

const KIND_CHOICES: { value: OwnerMoneyEventKind; title: string; hint: string }[] = [
  { value: 'contribution', title: 'I put my own money in', hint: 'From your own pocket.' },
  { value: 'draw', title: 'I paid myself / took money out', hint: 'Out of the business.' },
];

export default function NewOwnerMoney() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [kind, setKind] = useState<OwnerMoneyEventKind>('contribution');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [memo, setMemo] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Bootstrap once — a ref gates re-entry so a focus regain doesn't re-fetch.
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
        if (company) setCompanyId(company.id);
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
  const canSubmit = !submitting && !noCompany && amount.trim().length > 0;

  async function onSubmit() {
    if (!companyId) return;
    setFormError(null);
    setFieldErrors({});

    const parsed = ownerMoneyEventCreateSchema.safeParse({
      companyId,
      kind,
      amount: amount.trim(),
      occurredOn: occurredOn.trim(),
      memo: memo.trim() === '' ? undefined : memo.trim(),
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api['owner-money'].$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(apiErrorMessage(body?.error, 'create_failed', body));
        return;
      }
      const created = await res.json();
      router.replace(`/owner-money/${created.id}`);
    } catch {
      setFormError('create_failed');
    } finally {
      setSubmitting(false);
    }
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
              ← Investments
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Record money</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                What happened? *
              </Text>
              <View className="mt-2 space-y-2">
                {KIND_CHOICES.map((c) => (
                  <Pressable
                    key={c.value}
                    onPress={() => setKind(c.value)}
                    className={`rounded-sm border px-4 py-3 ${
                      kind === c.value
                        ? 'border-gold-deep bg-gold-deep/10'
                        : 'border-ink/15 bg-cream-warm'
                    }`}
                  >
                    <Text className="font-serif text-base text-ink">{c.title}</Text>
                    <Text className="mt-0.5 text-xs text-ink/55">{c.hint}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Amount *
              </Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholder="0.00"
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
              />
              {fieldErrors.amount ? (
                <Text className="mt-1 text-xs text-oxblood">{fieldErrors.amount}</Text>
              ) : null}
            </View>

            <DateField
              label="Date *"
              value={occurredOn}
              onChange={setOccurredOn}
              error={fieldErrors.occurredOn}
            />

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Note</Text>
              <TextInput
                value={memo}
                onChangeText={setMemo}
                multiline
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
              />
            </View>

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
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
