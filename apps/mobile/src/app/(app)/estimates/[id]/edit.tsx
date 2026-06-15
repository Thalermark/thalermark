import {
  type EstimateLineItemInput,
  addMoney,
  estimateUpdateSchema,
  multiplyMoney,
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
import { Checkbox } from '../../../../components/Checkbox';
import { DateField } from '../../../../components/DateField';
import { type ItemPatch, ItemPickerField } from '../../../../components/ItemPickerField';
import { TaxRow } from '../../../../components/TaxRow';
import { api } from '../../../../lib/api';
import { type TaxPolicyLite, lineTax, policyRate, resolvePolicyId } from '../../../../lib/line-tax';

// Edit half of apps/web's /estimates/[id]/edit — the invoice-edit twin, minus
// dueDate, plus an optional expiresOn ("Valid until"). Draft-only on the API
// (the detail screen gates the Edit button). PATCHes the whole estimate
// (estimateUpdateSchema = create minus companyId). Each line carries its
// sourceItemId through unchanged so editing a draft doesn't null the
// top-products breadcrumb (see apps/mobile/CLAUDE.md).
type Customer = { id: string; name: string; email: string | null };
type Row = {
  description: string;
  quantity: string;
  unitPrice: string;
  sourceItemId: string | null;
  taxable: boolean;
  taxPolicyId: string;
};
const blankRow = (): Row => ({
  description: '',
  quantity: '',
  unitPrice: '',
  sourceItemId: null,
  taxable: false,
  taxPolicyId: '',
});
type Seed = {
  customerId: string;
  number: string;
  issueDate: string;
  expiresOn: string;
  notes: string;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
  rows: Row[];
};

const FRIENDLY: Record<string, string> = {
  estimate_number_taken: 'Estimate number already used for this company. Try another.',
  customer_company_mismatch: 'Selected customer does not belong to this company.',
  customer_not_found: 'Selected customer no longer exists.',
  invalid_transition: 'This estimate can no longer be edited.',
};

export default function EditEstimate() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (seed) return;
      let active = true;
      (async () => {
        const [estRes, custRes] = await Promise.all([
          api.api.estimates[':id'].$get({ param: { id } }),
          api.api.customers.$get(),
        ]);
        if (!active) return;
        if (custRes.ok) {
          const { customers: rows } = await custRes.json();
          setCustomers(rows.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })));
        }
        if (!estRes.ok) {
          setFormError('load_failed');
          return;
        }
        const est = await estRes.json();
        setSeed({
          customerId: est.customerId,
          number: est.number,
          issueDate: est.issueDate,
          expiresOn: est.expiresOn ?? '',
          notes: est.notes ?? '',
          showAddress: est.showAddress,
          showPhone: est.showPhone,
          showEmail: est.showEmail,
          rows: est.lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            sourceItemId: li.sourceItemId ?? null,
            taxable: li.taxable ?? false,
            taxPolicyId: li.taxPolicyId ?? '',
          })),
        });
        const polRes = await api.api['tax-policies'].$get({ query: { companyId: est.companyId } });
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

  const selectedName = seed
    ? (customers.find((c) => c.id === seed.customerId)?.name ?? null)
    : null;

  async function onSubmit() {
    if (!seed) return;
    setFormError(null);
    setFieldErrors({});

    const lineItems: EstimateLineItemInput[] = seed.rows.map((r, i) => {
      const amount = multiplyMoney(r.quantity, r.unitPrice);
      const rate = r.taxable ? policyRate(taxPolicies, r.taxPolicyId) : '0';
      return {
        position: i + 1,
        description: r.description.trim(),
        quantity: r.quantity.trim(),
        unitPrice: r.unitPrice.trim(),
        amount,
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
      customerId: seed.customerId,
      number: seed.number.trim(),
      issueDate: seed.issueDate.trim(),
      expiresOn: seed.expiresOn.trim() === '' ? undefined : seed.expiresOn.trim(),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal),
      notes: seed.notes.trim() === '' ? undefined : seed.notes.trim(),
      showAddress: seed.showAddress,
      showPhone: seed.showPhone,
      showEmail: seed.showEmail,
      lineItems,
    };

    const parsed = estimateUpdateSchema.safeParse(payload);
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
      const res = await api.api.estimates[':id'].$patch({ param: { id }, json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = body?.error ?? 'save_failed';
        setFormError(FRIENDLY[code] ?? code);
        return;
      }
      router.replace(`/estimates/${id}`);
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
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this estimate.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  const canSubmit = !submitting && seed.customerId !== '' && seed.number.trim().length > 0;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              ← {seed.number || 'Estimate'}
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Edit estimate</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Customer *
              </Text>
              <Pressable
                onPress={() => setPickerOpen(true)}
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-3"
              >
                <Text className={selectedName ? 'text-ink' : 'text-ink/40'}>
                  {selectedName ?? 'Select a customer'}
                </Text>
              </Pressable>
            </View>

            <LabeledInput
              label="Number *"
              value={seed.number}
              onChangeText={(t) => set('number', t)}
              error={fieldErrors.number}
            />
            <DateField
              label="Issued *"
              value={seed.issueDate}
              onChange={(iso) => set('issueDate', iso)}
              error={fieldErrors.issueDate}
            />
            <DateField
              label="Valid until"
              value={seed.expiresOn}
              onChange={(iso) => set('expiresOn', iso)}
              error={fieldErrors.expiresOn}
              optional
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
                <TotalRow label="Total" value={total} emphasize />
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

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Your details on this estimate
              </Text>
              <Text className="mt-1 text-xs text-ink/50">
                Only details you've added in Business settings will show.
              </Text>
              <Checkbox
                label="Show my address"
                value={seed.showAddress}
                onToggle={() => set('showAddress', !seed.showAddress)}
                className="mt-3"
              />
              <Checkbox
                label="Show my phone"
                value={seed.showPhone}
                onToggle={() => set('showPhone', !seed.showPhone)}
                className="mt-3"
              />
              <Checkbox
                label="Show my email"
                value={seed.showEmail}
                onToggle={() => set('showEmail', !seed.showEmail)}
                className="mt-3"
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
            <Text className="font-serif text-xl text-ink">Choose customer</Text>
            <ScrollView className="mt-4">
              {customers.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => {
                    set('customerId', c.id);
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
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
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
