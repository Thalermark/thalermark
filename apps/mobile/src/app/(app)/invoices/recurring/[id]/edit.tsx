import {
  type LineItemType,
  type RecurringInvoiceLineItemInput,
  addMoney,
  multiplyMoney,
  recurringInvoiceUpdateSchema,
  sumMoney,
} from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
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
import { DateField } from '../../../../../components/DateField';
import { type ItemPatch, ItemPickerField } from '../../../../../components/ItemPickerField';
import { TaxRow } from '../../../../../components/TaxRow';
import { TypeRow } from '../../../../../components/TypeRow';
import { api } from '../../../../../lib/api';
import {
  type TaxPolicyLite,
  lineTax,
  policyRate,
  resolvePolicyId,
} from '../../../../../lib/line-tax';

// Edit half of apps/web's /recurring/[id]/edit — the missing mobile editor that
// closed the 5-vs-6 doc-form parity gap. PATCHes the whole schedule
// (recurringInvoiceUpdateSchema = create minus companyId), so the form re-sends
// every field + line. Like invoices/[id]/edit it re-picks an existing contact
// (no inline create) and carries each line's sourceItemId through unchanged, or
// editing would null the top-products breadcrumb (see apps/mobile/CLAUDE.md).
// An ended schedule is terminal: the API rejects the PATCH, so we guard on load.
const FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const;
const FREQ_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

type Contact = { id: string; name: string; email: string | null };
type Row = {
  description: string;
  quantity: string;
  unitPrice: string;
  sourceItemId: string | null;
  type: LineItemType;
  taxable: boolean;
  taxPolicyId: string;
};
const blankRow = (): Row => ({
  description: '',
  quantity: '',
  unitPrice: '',
  sourceItemId: null,
  type: 'service',
  taxable: false,
  taxPolicyId: '',
});
type Seed = {
  status: string;
  contactId: string;
  frequency: (typeof FREQUENCIES)[number];
  intervalCount: string;
  startDate: string;
  endDate: string;
  maxOccurrences: string;
  netTermsDays: string;
  notes: string;
  rows: Row[];
};

const FRIENDLY: Record<string, string> = {
  customer_company_mismatch: 'Selected contact does not belong to this company.',
  contact_not_found: 'Selected contact no longer exists.',
  not_editable: 'This schedule has ended and cannot be edited.',
};

export default function EditRecurring() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed once from the schedule + contact list; don't clobber edits on refocus.
  useFocusEffect(
    useCallback(() => {
      if (seed) return;
      let active = true;
      (async () => {
        const [schedRes, custRes] = await Promise.all([
          api.api['recurring-invoices'][':id'].$get({ param: { id } }),
          api.api.contacts.$get(),
        ]);
        if (!active) return;
        if (custRes.ok) {
          const { contacts: rows } = await custRes.json();
          setContacts(rows.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })));
        }
        if (!schedRes.ok) {
          setFormError('load_failed');
          return;
        }
        const s = await schedRes.json();
        setSeed({
          status: s.status,
          contactId: s.contactId,
          frequency: s.frequency as Seed['frequency'],
          intervalCount: String(s.intervalCount),
          startDate: s.startDate,
          endDate: s.endDate ?? '',
          maxOccurrences: s.maxOccurrences != null ? String(s.maxOccurrences) : '',
          netTermsDays: s.netTermsDays != null ? String(s.netTermsDays) : '',
          notes: s.notes ?? '',
          rows:
            s.lineItems.length > 0
              ? s.lineItems.map((li) => ({
                  description: li.description,
                  quantity: li.quantity,
                  unitPrice: li.unitPrice,
                  sourceItemId: li.sourceItemId ?? null,
                  type: li.type === 'product' ? 'product' : 'service',
                  taxable: li.taxable ?? false,
                  taxPolicyId: li.taxPolicyId ?? '',
                }))
              : [blankRow()],
        });
        const polRes = await api.api['tax-policies'].$get({ query: { companyId: s.companyId } });
        if (active && polRes.ok) {
          const { taxPolicies: pols } = await polRes.json();
          setTaxPolicies(
            pols.map((p) => ({
              id: p.id,
              name: p.name,
              ratePct: p.ratePct,
              isDefault: p.isDefault,
            })),
          );
        }
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
  const patchRow = (i: number, patch: Partial<Row>) =>
    setSeed((s) =>
      s ? { ...s, rows: s.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : s,
    );
  const addRow = () => setSeed((s) => (s ? { ...s, rows: [...s.rows, blankRow()] } : s));
  const removeRow = (i: number) =>
    setSeed((s) => (s && s.rows.length > 1 ? { ...s, rows: s.rows.filter((_, j) => j !== i) } : s));
  const toggleRowTaxable = (i: number) =>
    setSeed((s) =>
      s
        ? {
            ...s,
            rows: s.rows.map((r, j) => {
              if (j !== i) return r;
              const turningOn = !r.taxable;
              return {
                ...r,
                taxable: turningOn,
                taxPolicyId:
                  turningOn && !r.taxPolicyId ? resolvePolicyId(taxPolicies, '') : r.taxPolicyId,
              };
            }),
          }
        : s,
    );
  const applyPick = (i: number, patch: ItemPatch) => {
    const { taxable, taxPolicyId, ...rest } = patch;
    if (taxable !== undefined) {
      patchRow(i, {
        ...rest,
        taxable,
        taxPolicyId: taxable ? resolvePolicyId(taxPolicies, taxPolicyId ?? '') : '',
      });
    } else {
      patchRow(i, rest);
    }
  };

  const computedRows = useMemo(
    () =>
      seed
        ? seed.rows.map((r) => {
            const amount = multiplyMoney(r.quantity, r.unitPrice);
            const rate = r.taxable ? policyRate(taxPolicies, r.taxPolicyId) : '0';
            return { ...r, amount, tax: lineTax(r.taxable, rate, amount) };
          })
        : [],
    [seed, taxPolicies],
  );
  const subtotal = useMemo(() => sumMoney(computedRows.map((r) => r.amount)), [computedRows]);
  const taxTotal = useMemo(() => sumMoney(computedRows.map((r) => r.tax)), [computedRows]);
  const total = useMemo(() => addMoney(subtotal, taxTotal), [subtotal, taxTotal]);

  const selectedName = seed ? (contacts.find((c) => c.id === seed.contactId)?.name ?? null) : null;

  // Parse a counter TextInput → a non-negative integer, or undefined when blank.
  const toInt = (str: string): number | undefined => {
    const n = Number(str.trim());
    return str.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : undefined;
  };

  async function onSubmit() {
    if (!seed) return;
    setFormError(null);
    setFieldErrors({});

    const lineItems: RecurringInvoiceLineItemInput[] = seed.rows.map((r, i) => {
      const amount = multiplyMoney(r.quantity, r.unitPrice);
      const rate = r.taxable ? policyRate(taxPolicies, r.taxPolicyId) : '0';
      return {
        position: i + 1,
        description: r.description.trim(),
        quantity: r.quantity.trim(),
        unitPrice: r.unitPrice.trim(),
        amount,
        type: r.type,
        taxable: r.taxable,
        taxRatePct: rate,
        taxAmount: lineTax(r.taxable, rate, amount),
        taxPolicyId: r.taxable ? r.taxPolicyId || undefined : undefined,
        sourceItemId: r.sourceItemId ?? undefined,
      };
    });
    const sub = sumMoney(lineItems.map((li) => li.amount));
    const taxVal = sumMoney(lineItems.map((li) => li.taxAmount ?? '0'));
    const payload = {
      contactId: seed.contactId,
      frequency: seed.frequency,
      intervalCount: toInt(seed.intervalCount) ?? 1,
      startDate: seed.startDate.trim(),
      endDate: seed.endDate.trim() === '' ? undefined : seed.endDate.trim(),
      maxOccurrences: toInt(seed.maxOccurrences),
      netTermsDays: toInt(seed.netTermsDays),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal),
      notes: seed.notes.trim() === '' ? undefined : seed.notes.trim(),
      lineItems,
    };

    const parsed = recurringInvoiceUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const top = String(issue.path[0] ?? '_');
        const key = top === 'lineItems' ? 'lineItems' : top;
        if (!errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api['recurring-invoices'][':id'].$patch({
        param: { id },
        json: parsed.data,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = body?.error ?? 'save_failed';
        setFormError(FRIENDLY[code] ?? code);
        return;
      }
      router.replace(`/invoices/recurring/${id}`);
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
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this schedule.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  // Terminal guard — mirrors the web load throwing 409 for ended schedules. The
  // detail screen hides Edit for ended, but a deep link / stale screen can land
  // here, so refuse rather than let the PATCH bounce.
  if (seed.status === 'ended') {
    return (
      <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
        <View className="px-6 pt-6">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← Back</Text>
          </Pressable>
          <Text className="mt-8 text-sm text-ink/70">
            This schedule has ended and can no longer be edited.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const canSubmit = !submitting && seed.contactId !== '';

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              ← Schedule
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Edit schedule</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            {/* Contact */}
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Contact *
              </Text>
              <Pressable
                onPress={() => setPickerOpen(true)}
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-3"
              >
                <Text className={selectedName ? 'text-ink' : 'text-ink/40'}>
                  {selectedName ?? 'Select a contact'}
                </Text>
              </Pressable>
            </View>

            {/* Cadence */}
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Frequency
              </Text>
              <View className="mt-2 flex-row gap-2">
                {FREQUENCIES.map((f) => (
                  <Pressable
                    key={f}
                    onPress={() => set('frequency', f)}
                    className={`flex-1 rounded-sm border px-3 py-2 ${
                      seed.frequency === f ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/20'
                    }`}
                  >
                    <Text
                      className={`text-center ${seed.frequency === f ? 'text-ink' : 'text-ink/70'}`}
                    >
                      {FREQ_LABELS[f]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <LabeledInput
              label="Every (count)"
              value={seed.intervalCount}
              onChangeText={(t) => set('intervalCount', t)}
              error={fieldErrors.intervalCount}
              keyboardType="number-pad"
            />
            <DateField
              label="Start date *"
              value={seed.startDate}
              onChange={(iso) => set('startDate', iso)}
              error={fieldErrors.startDate}
            />
            <DateField
              label="End date (optional)"
              value={seed.endDate}
              onChange={(iso) => set('endDate', iso)}
              error={fieldErrors.endDate}
              optional
            />
            <LabeledInput
              label="Max occurrences (optional)"
              value={seed.maxOccurrences}
              onChangeText={(t) => set('maxOccurrences', t)}
              error={fieldErrors.maxOccurrences}
              keyboardType="number-pad"
            />
            <LabeledInput
              label="Net terms days (default 30)"
              value={seed.netTermsDays}
              onChangeText={(t) => set('netTermsDays', t)}
              error={fieldErrors.netTermsDays}
              keyboardType="number-pad"
            />

            <LineItems
              rows={seed.rows}
              computed={computedRows}
              error={fieldErrors.lineItems}
              taxPolicies={taxPolicies}
              patchRow={patchRow}
              applyPick={applyPick}
              toggleRowTaxable={toggleRowTaxable}
              addRow={addRow}
              removeRow={removeRow}
            />

            <View className="rounded-sm border border-ink/10 bg-cream-warm p-4">
              <TotalRow label="Subtotal" value={subtotal} />
              <TotalRow label="Tax" value={taxTotal} />
              <View className="mt-3 border-t border-ink/10 pt-3">
                <TotalRow label="Total per invoice" value={total} emphasize />
              </View>
            </View>

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</Text>
              <TextInput
                value={seed.notes}
                onChangeText={(t) => set('notes', t)}
                multiline
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
              />
            </View>

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
            <Text className="font-serif text-xl text-ink">Choose contact</Text>
            <ScrollView className="mt-4">
              {contacts.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => {
                    set('contactId', c.id);
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

// Line-item editor — same markup as the recurring/new + invoice edit blocks.
function LineItems({
  rows,
  computed,
  error,
  taxPolicies,
  patchRow,
  applyPick,
  toggleRowTaxable,
  addRow,
  removeRow,
}: {
  rows: Row[];
  computed: { amount: string; tax: string }[];
  error?: string;
  taxPolicies: TaxPolicyLite[];
  patchRow: (i: number, patch: Partial<Row>) => void;
  applyPick: (i: number, patch: ItemPatch) => void;
  toggleRowTaxable: (i: number) => void;
  addRow: () => void;
  removeRow: (i: number) => void;
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Line items</Text>
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
      <View className="mt-2 space-y-4">
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and reorder-free
          <View key={i} className="rounded-sm border border-ink/10 bg-cream-warm p-3">
            <ItemPickerField
              description={row.description}
              onChange={(patch) => applyPick(i, patch)}
            />
            <TypeRow value={row.type} onSelect={(t) => patchRow(i, { type: t })} />
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
                  {computed[i]?.amount ?? '0.00'}
                </Text>
              </View>
            </View>
            <TaxRow
              taxPolicies={taxPolicies}
              taxable={row.taxable}
              taxPolicyId={row.taxPolicyId}
              lineTaxAmount={computed[i]?.tax ?? '0.00'}
              onToggle={() => toggleRowTaxable(i)}
              onSelectPolicy={(pid) => patchRow(i, { taxPolicyId: pid })}
            />
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
  );
}

function LabeledInput({
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
  keyboardType?: 'number-pad';
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

function TotalRow({
  label,
  value,
  emphasize,
}: { label: string; value: string; emphasize?: boolean }) {
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
