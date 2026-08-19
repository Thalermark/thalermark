import { Ionicons } from '@expo/vector-icons';
import { manualJournalEntryCreateSchema, sumMoney } from '@thalermark/validation';
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
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/api-errors';

// Mirror of apps/web's /ledger/new. A balanced multi-line journal entry the user
// posts as their accountant dictates. The double-entry is shown on purpose here.
// Total debits must equal total credits (computed with the same sumMoney the
// server validates with) before the entry can be posted.
type Line = { coaAccountId: string; side: 'debit' | 'credit'; amount: string };
type Account = { id: string; code: string; name: string; accountType: string };

const todayIso = () => new Date().toISOString().slice(0, 10);

const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
const TYPE_LABELS: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expenses',
};

export default function NewLedgerEntry() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [postedOn, setPostedOn] = useState(todayIso());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([
    { coaAccountId: '', side: 'debit', amount: '' },
    { coaAccountId: '', side: 'credit', amount: '' },
  ]);
  const [pickerLine, setPickerLine] = useState<number | null>(null);

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
        const accRes = await api.api.companies[':id'].accounts.$get({
          param: { id: company.id },
          query: { type: undefined },
        });
        if (active && accRes.ok) setAccounts((await accRes.json()).accounts);
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

  function setLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { coaAccountId: '', side: 'debit', amount: '' }]);
  }
  function removeLine(i: number) {
    setLines((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev));
  }

  const totalDebit = sumMoney(lines.filter((l) => l.side === 'debit').map((l) => l.amount));
  const totalCredit = sumMoney(lines.filter((l) => l.side === 'credit').map((l) => l.amount));
  const difference = (Number(totalDebit) - Number(totalCredit)).toFixed(2);
  const balanced = totalDebit === totalCredit && Number(totalDebit) > 0;
  const completeLines = lines.filter((l) => l.coaAccountId && Number(l.amount) > 0).length;
  const noCompany = bootstrapped && companyId === null;
  const canSubmit = !submitting && !noCompany && balanced && completeLines >= 2;

  function accountLabel(id: string): string {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} · ${a.name}` : 'Choose account…';
  }

  async function onSubmit() {
    if (!companyId) return;
    setFormError(null);
    const parsed = manualJournalEntryCreateSchema.safeParse({
      companyId,
      postedOn: postedOn.trim(),
      memo: memo.trim(),
      lines,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Invalid entry.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.api.ledger.entries.$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(
          body?.error === 'invalid_account'
            ? 'One of the accounts is not valid for this company.'
            : apiErrorMessage(body?.error, 'Could not post the entry.', body),
        );
        return;
      }
      const created = await res.json();
      router.replace(`/ledger/${created.id}`);
    } catch {
      setFormError('Could not post the entry.');
    } finally {
      setSubmitting(false);
    }
  }

  const grouped = TYPE_ORDER.map((type) => ({
    label: TYPE_LABELS[type],
    accounts: accounts.filter((a) => a.accountType === type),
  })).filter((g) => g.accounts.length > 0);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              ← The Ledger
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New journal entry</Text>
          <Text className="mt-2 text-sm text-ink-subtle">
            Enter the debits and credits exactly as your accountant gave them.
          </Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 gap-5">
            <DateField label="Date *" value={postedOn} onChange={setPostedOn} />

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Description *
              </Text>
              <TextInput
                value={memo}
                onChangeText={setMemo}
                placeholder="e.g. 2026 depreciation per CPA"
                maxLength={500}
                className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
              />
            </View>

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Lines *
              </Text>
              <View className="mt-2 gap-3">
                {lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are a positional list edited in place
                  <View key={i} className="rounded-sm border border-ink/15 bg-cream-warm p-3">
                    <View className="flex-row items-center justify-between">
                      <Pressable onPress={() => setPickerLine(i)} className="flex-1 pr-2">
                        <Text
                          className={line.coaAccountId ? 'text-ink' : 'text-ink-subtle'}
                          numberOfLines={1}
                        >
                          {accountLabel(line.coaAccountId)}
                        </Text>
                      </Pressable>
                      {lines.length > 2 ? (
                        <Pressable onPress={() => removeLine(i)} className="pl-2">
                          <Ionicons name="close" size={18} className="text-oxblood" />
                        </Pressable>
                      ) : null}
                    </View>
                    <View className="mt-3 flex-row items-center gap-3">
                      <View className="flex-row overflow-hidden rounded-sm border border-ink/15">
                        {(['debit', 'credit'] as const).map((side) => (
                          <Pressable
                            key={side}
                            onPress={() => setLine(i, { side })}
                            className={`px-3 py-2 ${line.side === side ? 'bg-ink' : 'bg-cream'}`}
                          >
                            <Text
                              className={`text-xs uppercase tracking-widest ${line.side === side ? 'text-cream' : 'text-ink-subtle'}`}
                            >
                              {side}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      <TextInput
                        value={line.amount}
                        onChangeText={(t) => setLine(i, { amount: t })}
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                        className="flex-1 rounded-sm border border-field bg-cream px-3 py-2 text-right font-mono text-ink"
                      />
                    </View>
                  </View>
                ))}
              </View>
              <Pressable onPress={addLine} className="mt-2 py-1">
                <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                  + Add line
                </Text>
              </Pressable>
            </View>

            <View className="flex-row items-center justify-between rounded-sm border border-ink/10 bg-cream-warm px-4 py-3">
              <View className="flex-row gap-5">
                <Text className="font-mono text-xs text-ink-subtle">
                  Dr <Text className="text-ink">{totalDebit}</Text>
                </Text>
                <Text className="font-mono text-xs text-ink-subtle">
                  Cr <Text className="text-ink">{totalCredit}</Text>
                </Text>
              </View>
              <Text
                className={`font-mono text-xs uppercase tracking-widest ${balanced ? 'text-gold-deep' : 'text-ink-subtle'}`}
              >
                {balanced ? 'Balanced' : `Off by ${difference}`}
              </Text>
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
                <ActivityIndicator className="text-cream" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">Post entry</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={pickerLine !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setPickerLine(null)}
      >
        <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setPickerLine(null)}>
          <Pressable
            className="max-h-[70%] rounded-t-lg bg-cream px-6 pb-10 pt-5"
            onPress={() => {}}
          >
            <Text className="font-serif text-xl text-ink">Choose account</Text>
            <ScrollView className="mt-4">
              {grouped.map((group) => (
                <View key={group.label} className="mb-2">
                  <Text className="py-1 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    {group.label}
                  </Text>
                  {group.accounts.map((a) => (
                    <Pressable
                      key={a.id}
                      onPress={() => {
                        if (pickerLine !== null) setLine(pickerLine, { coaAccountId: a.id });
                        setPickerLine(null);
                      }}
                      className="border-b border-ink/10 py-3"
                    >
                      <Text className="text-ink">{a.name}</Text>
                      <Text className="text-xs text-ink-subtle">{a.code}</Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
