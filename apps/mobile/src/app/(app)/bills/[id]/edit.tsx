import { billUpdateSchema } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
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
import { ContactField } from '../../../../components/ContactField';
import { DateField } from '../../../../components/DateField';
import { api } from '../../../../lib/api';
import { apiErrorMessage } from '../../../../lib/api-errors';

// Edit half of apps/web's /bills/[id]/edit. Only OPEN bills are editable — the
// detail screen gates the Edit button, and this screen bounces paid/voided bills
// back. The vendor field is re-pick-only (allowCreate=false, like web): editing
// shouldn't spawn new vendors. The API edit = reverse the prior open posting +
// repost in one tx, so amount/category changes stay GL-clean. companyId is
// immutable, so the category picker stays within this company.
type Account = { id: string; code: string; name: string };
type Seed = {
  companyId: string;
  contactId: string;
  contactName: string;
  categoryId: string;
  amount: string;
  billDate: string;
  dueDate: string;
  reference: string;
  memo: string;
};

export default function EditBill() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [categories, setCategories] = useState<Account[]>([]);
  const [picker, setPicker] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed once from the bill + its COA; don't clobber edits on a focus regain.
  useFocusEffect(
    useCallback(() => {
      if (seed) return;
      let active = true;
      (async () => {
        const res = await api.api.bills[':id'].$get({ param: { id } });
        if (!active) return;
        if (!res.ok) {
          setFormError('That could not be loaded. Try again.');
          return;
        }
        const b = await res.json();
        // Bounce non-open bills back to the detail screen — they're terminal.
        if (b.status !== 'open') {
          router.replace(`/bills/${id}`);
          return;
        }
        const catRes = await api.api.companies[':id'].accounts.$get({
          param: { id: b.companyId },
          query: { type: 'expense' },
        });
        if (!active) return;
        if (catRes.ok) setCategories((await catRes.json()).accounts);
        setSeed({
          companyId: b.companyId,
          contactId: b.contactId,
          contactName: b.vendorName,
          categoryId: b.categoryAccountId,
          amount: b.amount,
          billDate: b.billDate,
          dueDate: b.dueDate,
          reference: b.reference ?? '',
          memo: b.memo ?? '',
        });
      })().catch(() => {
        if (active) setFormError('That could not be loaded. Try again.');
      });
      return () => {
        active = false;
      };
    }, [id, seed, router]),
  );

  const set = <K extends keyof Seed>(key: K, val: Seed[K]) =>
    setSeed((s) => (s ? { ...s, [key]: val } : s));

  const categoryName = seed
    ? (categories.find((a) => a.id === seed.categoryId)?.name ?? null)
    : null;

  async function onSubmit() {
    if (!seed) return;
    setFormError(null);
    setFieldErrors({});

    // Full replacement under the API's sparse merge. Empty reference/memo omit
    // (kept current) — matching web's bill edit (clearing isn't an edit action).
    const payload = {
      contactId: seed.contactId,
      categoryAccountId: seed.categoryId,
      amount: seed.amount.trim(),
      billDate: seed.billDate.trim(),
      dueDate: seed.dueDate.trim(),
      reference: seed.reference.trim() === '' ? undefined : seed.reference.trim(),
      memo: seed.memo.trim() === '' ? undefined : seed.memo.trim(),
    };
    const parsed = billUpdateSchema.safeParse(payload);
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
      const res = await api.api.bills[':id'].$patch({ param: { id }, json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = apiErrorMessage(body?.error, 'That could not be saved. Try again.', body);
        const msg =
          code === 'bill_not_editable'
            ? 'This bill can no longer be edited.'
            : code === 'invalid_category_account'
              ? 'That category is no longer a valid expense account.'
              : code;
        setFormError(msg);
        return;
      }
      router.replace(`/bills/${id}`);
    } catch {
      setFormError('That could not be saved. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!seed) {
    return (
      <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
        {formError ? (
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this bill.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  const canSubmit = !submitting && seed.contactId !== '' && seed.amount.trim().length > 0;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              ← {seed.contactName || 'Bill'}
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Edit bill</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 gap-5">
            <ContactField
              label="Vendor *"
              companyId={seed.companyId}
              contactName={seed.contactName}
              setContactName={(t) => set('contactName', t)}
              contactId={seed.contactId}
              setContactId={(v) => set('contactId', v)}
              allowCreate={false}
              error={fieldErrors.contactId}
            />

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Category *
              </Text>
              <Pressable
                onPress={() => setPicker(true)}
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-3"
              >
                <Text className={categoryName ? 'text-ink' : 'text-ink-subtle'}>
                  {categoryName ?? 'Select a category…'}
                </Text>
              </Pressable>
              {fieldErrors.categoryAccountId ? (
                <Text className="mt-1 text-xs text-oxblood">{fieldErrors.categoryAccountId}</Text>
              ) : null}
            </View>

            <Field
              label="Amount *"
              value={seed.amount}
              onChangeText={(t) => set('amount', t)}
              error={fieldErrors.amount}
              keyboardType="decimal-pad"
            />
            <DateField
              label="Bill date *"
              value={seed.billDate}
              onChange={(iso) => set('billDate', iso)}
              error={fieldErrors.billDate}
            />
            <DateField
              label="Due date *"
              value={seed.dueDate}
              onChange={(iso) => set('dueDate', iso)}
              error={fieldErrors.dueDate}
            />
            <Field
              label="Reference"
              value={seed.reference}
              onChangeText={(t) => set('reference', t)}
              error={fieldErrors.reference}
            />
            <Field label="Memo" value={seed.memo} onChangeText={(t) => set('memo', t)} />

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className="mt-2 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
            >
              {submitting ? (
                <ActivityIndicator className="text-cream" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">Save changes</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={picker}
        animationType="slide"
        transparent
        onRequestClose={() => setPicker(false)}
      >
        <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setPicker(false)}>
          <Pressable
            className="max-h-[70%] rounded-t-lg bg-cream px-6 pb-10 pt-5"
            onPress={() => {}}
          >
            <Text className="font-serif text-xl text-ink">Choose category</Text>
            <ScrollView className="mt-4">
              {categories.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => {
                    set('categoryId', a.id);
                    setPicker(false);
                  }}
                  className="border-b border-ink/10 py-3"
                >
                  <Text className="text-ink">{a.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  error,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
  keyboardType?: 'decimal-pad';
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}
