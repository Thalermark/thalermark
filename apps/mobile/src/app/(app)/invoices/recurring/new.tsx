import {
  type RecurringInvoiceLineItemInput,
  addMoney,
  customerCreateSchema,
  multiplyMoney,
  recurringInvoiceCreateSchema,
  sumMoney,
} from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
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
import { ItemPickerField } from '../../../../components/ItemPickerField';
import { pickActiveCompany } from '../../../../lib/active-company';
import { api } from '../../../../lib/api';
import { type DupeCandidate, findEmailDupe, findNameDupes } from '../../../../lib/customer-dupes';

// Mirror of apps/web's /recurring/new — the invoice create form minus
// number/issue/due, plus cadence (frequency, every-N, start/end, max
// occurrences, net terms). Counters are JSON numbers; money/qty decimal
// strings. Two-step create with inline customer.
const NEW_CUSTOMER = '__new__';
const FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const;
const FREQ_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

type Row = {
  description: string;
  quantity: string;
  unitPrice: string;
  sourceItemId: string | null;
};
const blankRow = (): Row => ({ description: '', quantity: '', unitPrice: '', sourceItemId: null });
const todayIso = () => new Date().toISOString().slice(0, 10);

const FRIENDLY: Record<string, string> = {
  customer_company_mismatch: 'Selected customer does not belong to this company.',
  customer_not_found: 'Selected customer no longer exists.',
};

export default function NewRecurring() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<DupeCandidate[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]>('monthly');
  const [intervalCount, setIntervalCount] = useState('1');
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState('');
  const [maxOccurrences, setMaxOccurrences] = useState('');
  const [netTermsDays, setNetTermsDays] = useState('');
  const [tax, setTax] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([blankRow()]);

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
        const [compRes, custRes] = await Promise.all([
          api.api.companies.$get(),
          api.api.customers.$get(),
        ]);
        if (!active) return;
        if (custRes.ok) {
          const { customers: rowsC } = await custRes.json();
          setCustomers(rowsC.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })));
        }
        if (compRes.ok) {
          const { companies } = await compRes.json();
          const company = await pickActiveCompany(companies);
          if (company) setCompanyId(company.id);
        }
        if (active) setBootstrapped(true);
      })().catch(() => {
        if (active) setBootstrapped(true);
      });
      return () => {
        active = false;
      };
    }, []),
  );

  const inlineMode = customerId === NEW_CUSTOMER;
  const selectedName =
    customerId && !inlineMode ? customers.find((c) => c.id === customerId)?.name : null;
  const emailDupe = useMemo(
    () => (inlineMode ? findEmailDupe(newEmail, customers) : undefined),
    [inlineMode, newEmail, customers],
  );
  const nameDupes = useMemo(
    () => (inlineMode ? findNameDupes(newName, customers) : []),
    [inlineMode, newName, customers],
  );

  const computedRows = useMemo(
    () => rows.map((r) => ({ ...r, amount: multiplyMoney(r.quantity, r.unitPrice) })),
    [rows],
  );
  const subtotal = useMemo(() => sumMoney(computedRows.map((r) => r.amount)), [computedRows]);
  const total = useMemo(() => addMoney(subtotal, tax || '0'), [subtotal, tax]);

  const patchRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, blankRow()]);
  const removeRow = (i: number) =>
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, j) => j !== i)));

  const noCompany = bootstrapped && companyId === null;
  const hasCustomer = inlineMode ? newName.trim().length > 0 : customerId !== '';
  const canSubmit = !submitting && !noCompany && !emailDupe && hasCustomer;

  // Parse a counter TextInput → a positive integer, or undefined when blank/bad.
  const toInt = (s: string): number | undefined => {
    const n = Number(s.trim());
    return s.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : undefined;
  };

  async function onSubmit() {
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    setFormError(null);
    setFieldErrors({});

    let resolvedCustomerId = customerId;
    if (inlineMode) {
      const parsedCust = customerCreateSchema.safeParse({
        companyId,
        name: newName.trim(),
        email: newEmail.trim() === '' ? undefined : newEmail.trim(),
      });
      if (!parsedCust.success) {
        const errs: Record<string, string> = {};
        for (const issue of parsedCust.error.issues) {
          const key = `customer_${String(issue.path[0] ?? '_')}`;
          if (!errs[key]) errs[key] = issue.message;
        }
        setFieldErrors(errs);
        return;
      }
      if (findEmailDupe(parsedCust.data.email, customers)) return;
      setSubmitting(true);
      try {
        const custRes = await api.api.customers.$post({ json: parsedCust.data });
        if (!custRes.ok) {
          const body = (await custRes.json().catch(() => null)) as { error?: string } | null;
          setFormError(body?.error ?? 'customer_create_failed');
          return;
        }
        const created = await custRes.json();
        resolvedCustomerId = created.id;
        setCustomers((cs) => [
          { id: created.id, name: created.name, email: newEmail.trim() || null },
          ...cs,
        ]);
        setCustomerId(created.id);
        setNewName('');
        setNewEmail('');
      } catch {
        setFormError('customer_create_failed');
        setSubmitting(false);
        return;
      }
    }

    const lineItems: RecurringInvoiceLineItemInput[] = rows.map((r, i) => ({
      position: i + 1,
      description: r.description.trim(),
      quantity: r.quantity.trim(),
      unitPrice: r.unitPrice.trim(),
      amount: multiplyMoney(r.quantity, r.unitPrice),
      sourceItemId: r.sourceItemId ?? undefined,
    }));
    const sub = sumMoney(lineItems.map((li) => li.amount));
    const taxVal = tax.trim() === '' ? undefined : tax.trim();
    const payload = {
      companyId,
      customerId: resolvedCustomerId,
      frequency,
      intervalCount: toInt(intervalCount) ?? 1,
      startDate: startDate.trim(),
      endDate: endDate.trim() === '' ? undefined : endDate.trim(),
      maxOccurrences: toInt(maxOccurrences),
      netTermsDays: toInt(netTermsDays),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal ?? '0'),
      notes: notes.trim() === '' ? undefined : notes.trim(),
      lineItems,
    };

    const parsed = recurringInvoiceCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      setSubmitting(false);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api['recurring-invoices'].$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = body?.error ?? 'create_failed';
        setFormError(FRIENDLY[code] ?? code);
        return;
      }
      const created = await res.json();
      router.replace(`/invoices/recurring/${created.id}`);
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
              ← Recurring
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New schedule</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            {/* Customer */}
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Customer *
              </Text>
              <Pressable
                onPress={() => setPickerOpen(true)}
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-3"
              >
                <Text className={selectedName || inlineMode ? 'text-ink' : 'text-ink/40'}>
                  {inlineMode ? '+ New customer' : (selectedName ?? 'Select a customer')}
                </Text>
              </Pressable>
            </View>

            {inlineMode ? (
              <View className="space-y-3 rounded-sm border border-ink/10 bg-cream-warm/60 p-4">
                <View>
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    Name *
                  </Text>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
                  />
                  {fieldErrors.customer_name ? (
                    <Text className="mt-1 text-xs text-oxblood">{fieldErrors.customer_name}</Text>
                  ) : null}
                  {nameDupes.length > 0 ? (
                    <View className="mt-2 rounded-sm border border-ink/10 bg-cream p-2">
                      <Text className="text-xs text-ink/60">Looks like an existing customer:</Text>
                      {nameDupes.map((d) => (
                        <Pressable
                          key={d.id}
                          onPress={() => setCustomerId(d.id)}
                          className="mt-1 flex-row items-center justify-between"
                        >
                          <Text className="text-sm text-ink">{d.name}</Text>
                          <Text className="font-mono text-xs uppercase tracking-wider text-gold-deep">
                            Use
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
                <View>
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    Email
                  </Text>
                  <TextInput
                    value={newEmail}
                    onChangeText={setNewEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
                  />
                </View>
                {emailDupe ? (
                  <View className="rounded-sm border border-oxblood/30 bg-oxblood/5 p-3">
                    <Text className="text-sm text-ink">
                      <Text className="font-medium">{emailDupe.name}</Text> already uses this email.
                    </Text>
                    <Pressable onPress={() => setCustomerId(emailDupe.id)} className="mt-2">
                      <Text className="font-mono text-xs uppercase tracking-wider text-gold-deep">
                        Use {emailDupe.name}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* Cadence */}
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Frequency
              </Text>
              <View className="mt-2 flex-row gap-2">
                {FREQUENCIES.map((f) => (
                  <Pressable
                    key={f}
                    onPress={() => setFrequency(f)}
                    className={`flex-1 rounded-sm border px-3 py-2 ${
                      frequency === f ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/20'
                    }`}
                  >
                    <Text className={`text-center ${frequency === f ? 'text-ink' : 'text-ink/70'}`}>
                      {FREQ_LABELS[f]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <LabeledInput
              label="Every (count)"
              value={intervalCount}
              onChangeText={setIntervalCount}
              error={fieldErrors.intervalCount}
              keyboardType="number-pad"
            />
            <DateField
              label="Start date *"
              value={startDate}
              onChange={setStartDate}
              error={fieldErrors.startDate}
            />
            <DateField
              label="End date (optional)"
              value={endDate}
              onChange={setEndDate}
              error={fieldErrors.endDate}
              optional
            />
            <LabeledInput
              label="Max occurrences (optional)"
              value={maxOccurrences}
              onChangeText={setMaxOccurrences}
              error={fieldErrors.maxOccurrences}
              keyboardType="number-pad"
            />
            <LabeledInput
              label="Net terms days (default 30)"
              value={netTermsDays}
              onChangeText={setNetTermsDays}
              error={fieldErrors.netTermsDays}
              keyboardType="number-pad"
            />

            {/* Line items */}
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Line items
              </Text>
              {fieldErrors.lineItems ? (
                <Text className="mt-1 text-xs text-oxblood">{fieldErrors.lineItems}</Text>
              ) : null}
              <View className="mt-2 space-y-4">
                {rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and reorder-free
                  <View key={i} className="rounded-sm border border-ink/10 bg-cream-warm p-3">
                    <ItemPickerField
                      description={row.description}
                      onChange={(patch) => patchRow(i, patch)}
                    />
                    <View className="mt-2 flex-row gap-2">
                      <View className="flex-1">
                        <Text className="font-mono text-[10px] uppercase tracking-widest text-ink/50">
                          Qty
                        </Text>
                        <TextInput
                          value={row.quantity}
                          onChangeText={(t) => patchRow(i, { quantity: t })}
                          inputMode="decimal"
                          className="mt-1 rounded-sm border border-ink/15 bg-cream px-2 py-2 text-right font-mono tabular-nums text-ink"
                        />
                      </View>
                      <View className="flex-1">
                        <Text className="font-mono text-[10px] uppercase tracking-widest text-ink/50">
                          Unit price
                        </Text>
                        <TextInput
                          value={row.unitPrice}
                          onChangeText={(t) => patchRow(i, { unitPrice: t })}
                          inputMode="decimal"
                          className="mt-1 rounded-sm border border-ink/15 bg-cream px-2 py-2 text-right font-mono tabular-nums text-ink"
                        />
                      </View>
                      <View className="flex-1">
                        <Text className="font-mono text-[10px] uppercase tracking-widest text-ink/50">
                          Amount
                        </Text>
                        <Text className="mt-1 py-2 text-right font-mono tabular-nums text-ink">
                          {computedRows[i]?.amount ?? '0.00'}
                        </Text>
                      </View>
                    </View>
                    {rows.length > 1 ? (
                      <Pressable onPress={() => removeRow(i)} className="mt-2 self-end">
                        <Text className="font-mono text-xs uppercase tracking-wider text-oxblood">
                          Remove
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </View>
              <Pressable onPress={addRow} className="mt-3">
                <Text className="text-sm font-medium text-gold-deep">+ Add row</Text>
              </Pressable>
            </View>

            <LabeledInput label="Tax" value={tax} onChangeText={setTax} error={fieldErrors.tax} />
            <View className="rounded-sm border border-ink/10 bg-cream-warm p-4">
              <TotalRow label="Subtotal" value={subtotal} />
              <TotalRow label="Tax" value={tax || '0.00'} />
              <View className="mt-3 border-t border-ink/10 pt-3">
                <TotalRow label="Total" value={total} emphasize />
              </View>
            </View>

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
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
                <Text className="text-center text-sm font-medium text-cream">Create schedule</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={pickerOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setPickerOpen(false)}>
          <Pressable
            className="max-h-[70%] rounded-t-lg bg-cream px-6 pb-10 pt-5"
            onPress={() => {}}
          >
            <Text className="font-serif text-xl text-ink">Choose customer</Text>
            <ScrollView className="mt-4">
              <Pressable
                onPress={() => {
                  setCustomerId(NEW_CUSTOMER);
                  setPickerOpen(false);
                }}
                className="border-b border-ink/10 py-3"
              >
                <Text className="font-medium text-gold-deep">+ New customer</Text>
              </Pressable>
              {customers.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => {
                    setCustomerId(c.id);
                    setPickerOpen(false);
                  }}
                  className="border-b border-ink/10 py-3"
                >
                  <Text className="text-ink">{c.name}</Text>
                  {c.email ? <Text className="text-xs text-ink/50">{c.email}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  error,
  autoCapitalize,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
  autoCapitalize?: 'none';
  keyboardType?: 'number-pad';
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        keyboardType={keyboardType}
        className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}

function TotalRow({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <View className="flex-row justify-between">
      <Text
        className={`font-mono text-xs uppercase tracking-widest ${emphasize ? 'text-ink/70' : 'text-ink/50'}`}
      >
        {label}
      </Text>
      <Text className={`font-mono tabular-nums text-ink ${emphasize ? 'text-lg' : ''}`}>
        {value}
      </Text>
    </View>
  );
}
