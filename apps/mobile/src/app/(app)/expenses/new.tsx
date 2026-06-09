import { expenseCreateSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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
import { DateField } from '../../../components/DateField';
import { api } from '../../../lib/api';

// Mirror of apps/web's /expenses/new. An expense posts against two chart-of-
// accounts rows (category = an 'expense' account, payment = an 'asset'
// account), so the form fetches the company's COA and offers two pickers. The
// AI "suggest category" affordance is deferred to a later (AI) slice.
type Account = { id: string; code: string; name: string };

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function NewExpense() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [categories, setCategories] = useState<Account[]>([]);
  const [payments, setPayments] = useState<Account[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [memo, setMemo] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [picker, setPicker] = useState<'category' | 'payment' | null>(null);

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
        const company = companies[0];
        if (!company) return;
        setCompanyId(company.id);
        const [catRes, payRes] = await Promise.all([
          api.api.companies[':id'].accounts.$get({
            param: { id: company.id },
            query: { type: 'expense' },
          }),
          api.api.companies[':id'].accounts.$get({
            param: { id: company.id },
            query: { type: 'asset' },
          }),
        ]);
        if (!active) return;
        if (catRes.ok) setCategories((await catRes.json()).accounts);
        if (payRes.ok) {
          const { accounts } = await payRes.json();
          setPayments(accounts);
          // Default payment to the first asset account (typically Cash/Checking).
          setPaymentId((p) => p ?? accounts[0]?.id ?? null);
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

  const categoryName = categories.find((a) => a.id === categoryId)?.name ?? null;
  const paymentName = payments.find((a) => a.id === paymentId)?.name ?? null;
  const noCompany = bootstrapped && companyId === null;
  const canSubmit =
    !submitting &&
    !noCompany &&
    merchant.trim().length > 0 &&
    amount.trim().length > 0 &&
    categoryId !== null &&
    paymentId !== null;

  async function onSubmit() {
    if (!companyId || !categoryId || !paymentId) return;
    setFormError(null);
    setFieldErrors({});

    const payload = {
      companyId,
      categoryAccountId: categoryId,
      paymentAccountId: paymentId,
      amount: amount.trim(),
      expenseDate: expenseDate.trim(),
      merchant: merchant.trim(),
      memo: memo.trim() === '' ? undefined : memo.trim(),
    };
    const parsed = expenseCreateSchema.safeParse(payload);
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
      const res = await api.api.expenses.$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? 'create_failed');
        return;
      }
      const created = await res.json();
      router.replace(`/expenses/${created.id}`);
    } catch {
      setFormError('create_failed');
    } finally {
      setSubmitting(false);
    }
  }

  const pickerList = picker === 'category' ? categories : payments;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              ← Expenses
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New expense</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <Field
              label="Merchant *"
              value={merchant}
              onChangeText={setMerchant}
              error={fieldErrors.merchant}
            />
            <Field
              label="Amount *"
              value={amount}
              onChangeText={setAmount}
              error={fieldErrors.amount}
              keyboardType="decimal-pad"
            />
            <DateField
              label="Date *"
              value={expenseDate}
              onChange={setExpenseDate}
              error={fieldErrors.expenseDate}
            />

            <PickerField
              label="Category *"
              value={categoryName}
              placeholder="Select a category…"
              onPress={() => setPicker('category')}
              error={fieldErrors.categoryAccountId}
            />
            <PickerField
              label="Paid with *"
              value={paymentName}
              placeholder="Select an account…"
              onPress={() => setPicker('payment')}
              error={fieldErrors.paymentAccountId}
            />

            <Field label="Memo" value={memo} onChangeText={setMemo} />

            {noCompany ? (
              <Text className="text-xs text-oxblood">No company on this account.</Text>
            ) : null}

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className="mt-2 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
            >
              {submitting ? (
                <ActivityIndicator color="#f4ede0" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">Create expense</Text>
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
                    if (picker === 'category') setCategoryId(a.id);
                    else setPaymentId(a.id);
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

function Field({
  label,
  value,
  onChangeText,
  error,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
  keyboardType?: 'decimal-pad';
  autoCapitalize?: 'none';
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
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
}: {
  label: string;
  value: string | null;
  placeholder: string;
  onPress: () => void;
  error?: string;
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
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
