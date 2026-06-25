import { expenseUpdateSchema } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';
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
import { DateField } from '../../../../components/DateField';
import { SuggestButton, SuggestNotice } from '../../../../components/SuggestCategory';
import { VendorField } from '../../../../components/VendorField';
import { api } from '../../../../lib/api';
import { type SuggestResult, suggestCategory } from '../../../../lib/categorize';
import { resolveVendor } from '../../../../lib/expense-vendor';

// Edit half of apps/web's /expenses/[id]/edit. Seeds from the loaded expense +
// its company's chart of accounts, then PATCHes. The API does a sparse merge
// (omitted fields keep current) and re-posts the ledger entry as a reversal +
// fresh posting, so editing the amount/category stays GL-clean. memo is sent
// even when blank ('' is a valid clear) since sparse merge wouldn't otherwise
// drop it. companyId is immutable, so the COA pickers stay within this company.
type Account = { id: string; code: string; name: string };
type Seed = {
  companyId: string;
  merchant: string;
  vendorContactId: string;
  amount: string;
  expenseDate: string;
  memo: string;
  categoryId: string;
  paymentId: string;
};

export default function EditExpense() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [categories, setCategories] = useState<Account[]>([]);
  const [payments, setPayments] = useState<Account[]>([]);
  const [picker, setPicker] = useState<'category' | 'payment' | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNotice, setSuggestNotice] = useState<SuggestResult | null>(null);
  // Whether the Vendor field was touched. Untouched → omit vendorContactId from
  // the PATCH so an unrelated edit leaves the link + needs-review flag alone.
  const [vendorTouched, setVendorTouched] = useState(false);

  // Seed once from the expense + its COA; don't clobber edits on a focus regain.
  useFocusEffect(
    useCallback(() => {
      if (seed) return;
      let active = true;
      (async () => {
        const res = await api.api.expenses[':id'].$get({ param: { id } });
        if (!active) return;
        if (!res.ok) {
          setFormError('load_failed');
          return;
        }
        const e = await res.json();
        const [catRes, payRes] = await Promise.all([
          api.api.companies[':id'].accounts.$get({
            param: { id: e.companyId },
            query: { type: 'expense' },
          }),
          api.api.companies[':id'].accounts.$get({
            param: { id: e.companyId },
            query: { type: 'asset' },
          }),
        ]);
        if (!active) return;
        if (catRes.ok) setCategories((await catRes.json()).accounts);
        if (payRes.ok) setPayments((await payRes.json()).accounts);
        setSeed({
          companyId: e.companyId,
          merchant: e.merchant,
          vendorContactId: e.vendorContactId ?? '',
          amount: e.amount,
          expenseDate: e.expenseDate,
          memo: e.memo ?? '',
          categoryId: e.categoryAccountId,
          paymentId: e.paymentAccountId,
        });
      })().catch(() => {
        if (active) setFormError('load_failed');
      });
      return () => {
        active = false;
      };
    }, [id, seed]),
  );

  const set = <K extends keyof Seed>(key: K, val: Seed[K]) =>
    setSeed((s) => (s ? { ...s, [key]: val } : s));

  async function onSuggest() {
    if (!seed) return;
    setSuggesting(true);
    setSuggestNotice(null);
    const result = await suggestCategory({
      companyId: seed.companyId,
      merchant: seed.merchant,
      memo: seed.memo,
      amount: seed.amount,
    });
    if (result.kind === 'applied') set('categoryId', result.categoryAccountId);
    setSuggestNotice(result);
    setSuggesting(false);
  }

  const categoryName = seed
    ? (categories.find((a) => a.id === seed.categoryId)?.name ?? null)
    : null;
  const paymentName = seed ? (payments.find((a) => a.id === seed.paymentId)?.name ?? null) : null;

  async function onSubmit() {
    if (!seed) return;
    setFormError(null);
    setFieldErrors({});

    // memo sent even when '' (a valid clear under the sparse merge).
    const payload = {
      categoryAccountId: seed.categoryId,
      paymentAccountId: seed.paymentId,
      amount: seed.amount.trim(),
      expenseDate: seed.expenseDate.trim(),
      merchant: seed.merchant.trim(),
      memo: seed.memo.trim(),
    };
    const parsed = expenseUpdateSchema.safeParse(payload);
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
      // Only resolve/send the vendor when it was touched; otherwise omit it so
      // the API preserves the existing link AND the needs-review flag.
      let json = parsed.data;
      if (vendorTouched) {
        const vendor = await resolveVendor(seed.companyId, seed.vendorContactId, seed.merchant);
        if (!vendor.ok) {
          setFormError('vendor_create_failed');
          return;
        }
        json = { ...parsed.data, vendorContactId: vendor.value };
      }
      const res = await api.api.expenses[':id'].$patch({ param: { id }, json });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? 'save_failed');
        return;
      }
      router.replace(`/expenses/${id}`);
    } catch {
      setFormError('save_failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!seed) {
    return (
      <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
        {formError ? (
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this expense.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  const pickerList = picker === 'category' ? categories : payments;
  const canSubmit = !submitting && seed.merchant.trim().length > 0 && seed.amount.trim().length > 0;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              ← {seed.merchant || 'Expense'}
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Edit expense</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <VendorField
              label="Vendor *"
              companyId={seed.companyId}
              merchant={seed.merchant}
              setMerchant={(t) => set('merchant', t)}
              vendorContactId={seed.vendorContactId}
              setVendorContactId={(v) => set('vendorContactId', v)}
              onDirty={() => setVendorTouched(true)}
              error={fieldErrors.merchant}
            />
            <Field
              label="Amount *"
              value={seed.amount}
              onChangeText={(t) => set('amount', t)}
              error={fieldErrors.amount}
              keyboardType="decimal-pad"
            />
            <DateField
              label="Date *"
              value={seed.expenseDate}
              onChange={(iso) => set('expenseDate', iso)}
              error={fieldErrors.expenseDate}
            />

            <View>
              <PickerField
                label="Category *"
                value={categoryName}
                placeholder="Select a category…"
                onPress={() => setPicker('category')}
                error={fieldErrors.categoryAccountId}
                headerRight={<SuggestButton suggesting={suggesting} onPress={onSuggest} />}
              />
              {suggestNotice ? <SuggestNotice result={suggestNotice} /> : null}
            </View>
            <PickerField
              label="Paid with *"
              value={paymentName}
              placeholder="Select an account…"
              onPress={() => setPicker('payment')}
              error={fieldErrors.paymentAccountId}
            />

            <Field label="Memo" value={seed.memo} onChangeText={(t) => set('memo', t)} />

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className="mt-2 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
            >
              {submitting ? (
                <ActivityIndicator color="#f4ede0" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">Save changes</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={picker !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setPicker(null)}
      >
        <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setPicker(null)}>
          <Pressable
            className="max-h-[70%] rounded-t-lg bg-cream px-6 pb-10 pt-5"
            onPress={() => {}}
          >
            <Text className="font-serif text-xl text-ink">
              {picker === 'category' ? 'Choose category' : 'Paid with'}
            </Text>
            <ScrollView className="mt-4">
              {pickerList.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => {
                    if (picker === 'category') set('categoryId', a.id);
                    else set('paymentId', a.id);
                    setPicker(null);
                  }}
                  className="border-b border-ink/10 py-3"
                >
                  <Text className="text-ink">{a.name}</Text>
                  <Text className="text-xs text-ink/50">{a.code}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// Matches the field idiom in expenses/new.
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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}

function PickerField({
  label,
  value,
  placeholder,
  onPress,
  error,
  headerRight,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  onPress: () => void;
  error?: string;
  headerRight?: ReactNode;
}) {
  return (
    <View>
      <View className="flex-row items-center justify-between">
        <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
        {headerRight ?? null}
      </View>
      <Pressable
        onPress={onPress}
        className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-3"
      >
        <Text className={value ? 'text-ink' : 'text-ink/40'}>{value ?? placeholder}</Text>
      </Pressable>
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}
