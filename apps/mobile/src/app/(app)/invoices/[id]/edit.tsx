import {
  type InvoiceLineItemInput,
  type LineItemType,
  addMoney,
  invoiceUpdateSchema,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
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
import { Checkbox } from '../../../../components/Checkbox';
import { ContactField } from '../../../../components/ContactField';
import { DateField } from '../../../../components/DateField';
import { type ItemPatch, ItemPickerField } from '../../../../components/ItemPickerField';
import { TaxRow } from '../../../../components/TaxRow';
import { TypeRow } from '../../../../components/TypeRow';
import { api } from '../../../../lib/api';
import { type TaxPolicyLite, lineTax, policyRate, resolvePolicyId } from '../../../../lib/line-tax';

// Edit half of apps/web's /invoices/[id]/edit — draft-only on the API (the
// detail screen only surfaces the Edit button for drafts). PATCHes the whole
// invoice (invoiceUpdateSchema = create minus companyId), so the form re-sends
// every field + line. Leaner than invoices/new: the ContactField re-picks an
// existing contact only (allowCreate=false — a draft already names one).
// CRITICAL: each line carries its sourceItemId through unchanged, or editing a
// draft would null the top-products breadcrumb (see apps/mobile/CLAUDE.md).
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
  contactId: string;
  number: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
  rows: Row[];
};

const FRIENDLY: Record<string, string> = {
  invoice_number_taken: 'Invoice number already used for this company. Try another.',
  customer_company_mismatch: 'Selected contact does not belong to this company.',
  contact_not_found: 'Selected contact no longer exists.',
  invalid_transition: 'This invoice can no longer be edited.',
};

export default function EditInvoice() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [seed, setSeed] = useState<Seed | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed once from the invoice + contact list; don't clobber edits on refocus.
  useFocusEffect(
    useCallback(() => {
      if (seed) return;
      let active = true;
      (async () => {
        const invRes = await api.api.invoices[':id'].$get({ param: { id } });
        if (!active) return;
        if (!invRes.ok) {
          setFormError('load_failed');
          return;
        }
        const inv = await invRes.json();
        setCompanyId(inv.companyId);
        // The ContactField type-ahead searches on demand; we only need the
        // currently linked contact's name to seed its display text.
        const cRes = await api.api.contacts[':id'].$get({ param: { id: inv.contactId } });
        if (active && cRes.ok) setContactName((await cRes.json()).name);
        setSeed({
          contactId: inv.contactId,
          number: inv.number,
          issueDate: inv.issueDate,
          dueDate: inv.dueDate,
          notes: inv.notes ?? '',
          showAddress: inv.showAddress,
          showPhone: inv.showPhone,
          showEmail: inv.showEmail,
          rows: inv.lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            sourceItemId: li.sourceItemId ?? null,
            type: li.type === 'product' ? 'product' : 'service',
            taxable: li.taxable ?? false,
            taxPolicyId: li.taxPolicyId ?? '',
          })),
        });
        const polRes = await api.api['tax-policies'].$get({ query: { companyId: inv.companyId } });
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

  async function onSubmit() {
    if (!seed) return;
    setFormError(null);
    setFieldErrors({});

    const lineItems: InvoiceLineItemInput[] = seed.rows.map((r, i) => {
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
      number: seed.number.trim(),
      issueDate: seed.issueDate.trim(),
      dueDate: seed.dueDate.trim(),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal),
      notes: seed.notes.trim() === '' ? undefined : seed.notes.trim(),
      showAddress: seed.showAddress,
      showPhone: seed.showPhone,
      showEmail: seed.showEmail,
      lineItems,
    };

    const parsed = invoiceUpdateSchema.safeParse(payload);
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
      const res = await api.api.invoices[':id'].$patch({ param: { id }, json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = body?.error ?? 'save_failed';
        setFormError(FRIENDLY[code] ?? code);
        return;
      }
      router.replace(`/invoices/${id}`);
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
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this invoice.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  const canSubmit = !submitting && seed.contactId !== '' && seed.number.trim().length > 0;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              ← {seed.number || 'Invoice'}
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Edit invoice</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <ContactField
              label="Contact *"
              companyId={companyId}
              contactName={contactName}
              setContactName={setContactName}
              contactId={seed.contactId}
              setContactId={(v) => set('contactId', v)}
              allowCreate={false}
              error={fieldErrors.contactId}
            />

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
              label="Due *"
              value={seed.dueDate}
              onChange={(iso) => set('dueDate', iso)}
              error={fieldErrors.dueDate}
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
                Your details on this invoice
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
    </SafeAreaView>
  );
}

// Line-item editor — same markup as invoices/new's inline block, lifted to a
// local component since edit + new now both render it.
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
