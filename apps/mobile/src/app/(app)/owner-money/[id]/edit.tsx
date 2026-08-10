import { type OwnerMoneyEventKind, ownerMoneyEventUpdateSchema } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
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
import { DateField } from '../../../../components/DateField';
import { api } from '../../../../lib/api';
import { apiErrorMessage } from '../../../../lib/api-errors';

// Mirror of apps/web's /owner-money/[id]/edit. Edit = reverse the prior posting
// + repost (the API handles it); the form carries the full editable set.
const KIND_CHOICES: { value: OwnerMoneyEventKind; title: string; hint: string }[] = [
  { value: 'contribution', title: 'I put my own money in', hint: 'From your own pocket.' },
  { value: 'draw', title: 'I paid myself / took money out', hint: 'Out of the business.' },
];

export default function EditOwnerMoney() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [kind, setKind] = useState<OwnerMoneyEventKind>('contribution');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState('');
  const [memo, setMemo] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const didLoad = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (didLoad.current) return;
      didLoad.current = true;
      let active = true;
      (async () => {
        const res = await api.api['owner-money'][':id'].$get({ param: { id } });
        if (!active) return;
        if (!res.ok) {
          setLoadError(true);
          return;
        }
        const e = await res.json();
        setKind(e.kind === 'draw' ? 'draw' : 'contribution');
        setAmount(e.amount);
        setOccurredOn(e.occurredOn);
        setMemo(e.memo ?? '');
        setLoaded(true);
      })().catch(() => {
        if (active) setLoadError(true);
      });
      return () => {
        active = false;
      };
    }, [id]),
  );

  async function onSubmit() {
    setFormError(null);
    setFieldErrors({});

    // memo is sent even when empty (so clearing it clears the column) — the
    // sparse update schema accepts an empty string.
    const parsed = ownerMoneyEventUpdateSchema.safeParse({
      kind,
      amount: amount.trim(),
      occurredOn: occurredOn.trim(),
      memo: memo.trim(),
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
      const res = await api.api['owner-money'][':id'].$patch({ param: { id }, json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(apiErrorMessage(body?.error, 'That could not be saved. Try again.', body));
        return;
      }
      router.replace(`/owner-money/${id}`);
    } catch {
      setFormError('That could not be saved. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
        <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← Back</Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Edit</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          {!loaded ? (
            <View className="mt-12 items-center">
              <ActivityIndicator color="#0f1626" />
            </View>
          ) : (
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
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Note
                </Text>
                <TextInput
                  value={memo}
                  onChangeText={setMemo}
                  multiline
                  className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
                />
              </View>

              <Pressable
                onPress={onSubmit}
                disabled={submitting}
                className="mt-2 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
              >
                {submitting ? (
                  <ActivityIndicator color="#f4ede0" />
                ) : (
                  <Text className="text-center text-sm font-medium text-cream">Save changes</Text>
                )}
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
