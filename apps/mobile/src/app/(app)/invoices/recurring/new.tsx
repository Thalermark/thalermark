import {
  type LineItemType,
  type RecurringInvoiceLineItemInput,
  addMoney,
  contactCreateSchema,
  formatUnitPrice,
  multiplyMoney,
  recurringInvoiceCreateSchema,
  sumMoney,
  unitPriceFromTotal,
} from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
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
import { ContactField } from '../../../../components/ContactField';
import { DateField } from '../../../../components/DateField';
import { type ItemPatch, ItemPickerField } from '../../../../components/ItemPickerField';
import { TaxRow } from '../../../../components/TaxRow';
import { TypeRow } from '../../../../components/TypeRow';
import { pickActiveCompany } from '../../../../lib/active-company';
import { api } from '../../../../lib/api';
import { apiErrorMessage } from '../../../../lib/api-errors';
import { NEW_CONTACT, findEmailDupe } from '../../../../lib/contact-dupes';
import { type TaxPolicyLite, lineTax, policyRate, resolvePolicyId } from '../../../../lib/line-tax';

// Mirror of apps/web's /recurring/new — the invoice create form minus
// number/issue/due, plus cadence (frequency, every-N, start/end, max
// occurrences, net terms). Counters are JSON numbers; money/qty decimal
// strings. Contact via the ContactField type-ahead; two-step create with
// inline contact.
const FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const;
const FREQ_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

type Row = {
  description: string;
  quantity: string;
  unitLabel: string;
  unitPrice: string;
  amount: string;
  sourceItemId: string | null;
  type: LineItemType;
  taxable: boolean;
  taxPolicyId: string;
};
const blankRow = (): Row => ({
  description: '',
  quantity: '',
  unitLabel: '',
  unitPrice: '',
  amount: '',
  sourceItemId: null,
  type: 'service',
  taxable: false,
  taxPolicyId: '',
});
const todayIso = () => new Date().toISOString().slice(0, 10);

const FRIENDLY: Record<string, string> = {
  customer_company_mismatch: 'Selected contact does not belong to this company.',
  contact_not_found: 'Selected contact no longer exists.',
};

export default function NewRecurring() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [contactId, setContactId] = useState('');
  const [contactName, setContactName] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]>('monthly');
  const [intervalCount, setIntervalCount] = useState('1');
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState('');
  const [maxOccurrences, setMaxOccurrences] = useState('');
  const [netTermsDays, setNetTermsDays] = useState('');
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
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
        const compRes = await api.api.companies.$get();
        if (!active) return;
        if (compRes.ok) {
          const { companies } = await compRes.json();
          const company = await pickActiveCompany(companies);
          if (company) {
            setCompanyId(company.id);
            const polRes = await api.api['tax-policies'].$get({
              query: { companyId: company.id },
            });
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
          }
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

  const inlineMode = contactId === NEW_CONTACT;

  const computedRows = useMemo(
    () =>
      rows.map((r) => {
        const rate = r.taxable ? policyRate(taxPolicies, r.taxPolicyId) : '0';
        return { ...r, tax: lineTax(r.taxable, rate, r.amount) };
      }),
    [rows, taxPolicies],
  );
  const subtotal = useMemo(() => sumMoney(computedRows.map((r) => r.amount)), [computedRows]);
  const taxTotal = useMemo(() => sumMoney(computedRows.map((r) => r.tax)), [computedRows]);
  const total = useMemo(() => addMoney(subtotal, taxTotal), [subtotal, taxTotal]);

  const patchRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // Keep unit price and line total in step (mirror of web). Editing quantity or
  // unit price re-derives the amount (unit price sticky); editing the amount
  // back-computes a 4dp unit price so an agreed total that doesn't divide evenly
  // (e.g. $650 over 7 → $92.8571 → $650.00) is representable.
  const setRowQuantity = (i: number, quantity: string) =>
    setRows((rs) =>
      rs.map((r, j) =>
        j === i ? { ...r, quantity, amount: multiplyMoney(quantity, r.unitPrice) } : r,
      ),
    );
  const setRowUnitPrice = (i: number, unitPrice: string) =>
    setRows((rs) =>
      rs.map((r, j) =>
        j === i ? { ...r, unitPrice, amount: multiplyMoney(r.quantity, unitPrice) } : r,
      ),
    );
  const setRowAmount = (i: number, amount: string) =>
    setRows((rs) =>
      rs.map((r, j) =>
        j === i ? { ...r, amount, unitPrice: unitPriceFromTotal(amount, r.quantity) } : r,
      ),
    );
  const addRow = () => setRows((rs) => [...rs, blankRow()]);
  const removeRow = (i: number) =>
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, j) => j !== i)));
  const toggleRowTaxable = (i: number) =>
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const turningOn = !r.taxable;
        return {
          ...r,
          taxable: turningOn,
          taxPolicyId:
            turningOn && !r.taxPolicyId ? resolvePolicyId(taxPolicies, '') : r.taxPolicyId,
        };
      }),
    );
  const applyPick = (i: number, patch: ItemPatch) => {
    const { taxable, taxPolicyId, unitLabel, ...rest } = patch;
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const merged: Row = { ...r, ...rest };
        // A pick carries the item's unit ('' when it has none); hand-typing the
        // description leaves unitLabel out of the patch, so the row keeps its own.
        if (unitLabel !== undefined) merged.unitLabel = unitLabel ?? '';
        if (taxable !== undefined) {
          merged.taxable = taxable;
          merged.taxPolicyId = taxable ? resolvePolicyId(taxPolicies, taxPolicyId ?? '') : '';
        }
        // A pick sets unit price + quantity; keep the amount in step.
        merged.amount = multiplyMoney(merged.quantity, merged.unitPrice);
        return merged;
      }),
    );
  };

  const noCompany = bootstrapped && companyId === null;
  const hasContact = inlineMode ? newName.trim().length > 0 : contactId !== '';
  const canSubmit = !submitting && !noCompany && hasContact;

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

    let resolvedContactId = contactId;
    if (inlineMode) {
      const parsedCust = contactCreateSchema.safeParse({
        companyId,
        name: newName.trim(),
        email: newEmail.trim() === '' ? undefined : newEmail.trim(),
      });
      if (!parsedCust.success) {
        const errs: Record<string, string> = {};
        for (const issue of parsedCust.error.issues) {
          const key = `contact_${String(issue.path[0] ?? '_')}`;
          if (!errs[key]) errs[key] = issue.message;
        }
        setFieldErrors(errs);
        return;
      }
      setSubmitting(true);
      try {
        // HARD BLOCK on email exact match (the API doesn't dedupe). Search by
        // the email so the check is correct at any contact count.
        if (parsedCust.data.email) {
          const dres = await api.api.contacts.$get({
            query: { q: parsedCust.data.email, companyId },
          });
          if (dres.ok) {
            const { contacts: list } = await dres.json();
            const dupe = findEmailDupe(
              parsedCust.data.email,
              list.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })),
            );
            if (dupe) {
              setFieldErrors({ contact_email: `${dupe.name} already uses this email.` });
              setSubmitting(false);
              return;
            }
          }
        }
        const custRes = await api.api.contacts.$post({ json: parsedCust.data });
        if (!custRes.ok) {
          const body = (await custRes.json().catch(() => null)) as { error?: string } | null;
          setFormError(
            apiErrorMessage(body?.error, 'That customer could not be created. Try again.', body),
          );
          return;
        }
        const created = await custRes.json();
        resolvedContactId = created.id;
        setContactName(created.name);
        setContactId(created.id);
        setNewName('');
        setNewEmail('');
      } catch {
        setFormError('That customer could not be created. Try again.');
        setSubmitting(false);
        return;
      }
    }

    const lineItems: RecurringInvoiceLineItemInput[] = rows.map((r, i) => {
      const amount = multiplyMoney(r.quantity, r.unitPrice);
      const rate = r.taxable ? policyRate(taxPolicies, r.taxPolicyId) : '0';
      return {
        position: i + 1,
        description: r.description.trim(),
        quantity: r.quantity.trim(),
        unitLabel: r.unitLabel.trim() || undefined,
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
      companyId,
      contactId: resolvedContactId,
      frequency,
      intervalCount: toInt(intervalCount) ?? 1,
      startDate: startDate.trim(),
      endDate: endDate.trim() === '' ? undefined : endDate.trim(),
      maxOccurrences: toInt(maxOccurrences),
      netTermsDays: toInt(netTermsDays),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal),
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
        const code = apiErrorMessage(body?.error, 'That could not be created. Try again.', body);
        setFormError(
          FRIENDLY[code] ?? apiErrorMessage(code, 'That could not be saved. Try again.'),
        );
        return;
      }
      const created = await res.json();
      router.replace(`/invoices/recurring/${created.id}`);
    } catch {
      setFormError('That could not be created. Try again.');
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
              ← Repeating
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New schedule</Text>

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
              contactId={contactId}
              setContactId={setContactId}
              error={fieldErrors.contactId}
              newName={newName}
              setNewName={setNewName}
              newEmail={newEmail}
              setNewEmail={setNewEmail}
              nameError={fieldErrors.contact_name}
              emailError={fieldErrors.contact_email}
            />

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
                          onChangeText={(t) => setRowQuantity(i, t)}
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
                          onChangeText={(t) => setRowUnitPrice(i, t)}
                          inputMode="decimal"
                          className="mt-1 rounded-sm border border-ink/15 bg-cream px-2 py-2 text-right font-mono tabular-nums text-ink"
                        />
                      </View>
                      <View className="flex-1">
                        <Text className="font-mono text-[10px] uppercase tracking-widest text-ink/50">
                          Amount
                        </Text>
                        <TextInput
                          value={row.amount}
                          onChangeText={(t) => setRowAmount(i, t)}
                          inputMode="decimal"
                          className="mt-1 rounded-sm border border-ink/15 bg-cream px-2 py-2 text-right font-mono tabular-nums text-ink"
                        />
                      </View>
                    </View>
                    <View className="mt-2">
                      <Text className="font-mono text-[10px] uppercase tracking-widest text-ink/50">
                        Unit
                      </Text>
                      <TextInput
                        value={row.unitLabel}
                        onChangeText={(t) => patchRow(i, { unitLabel: t })}
                        placeholder="hr, day, sq ft"
                        maxLength={50}
                        className="mt-1 rounded-sm border border-ink/15 bg-cream px-2 py-2 text-ink"
                      />
                    </View>
                    <TaxRow
                      taxPolicies={taxPolicies}
                      taxable={row.taxable}
                      taxPolicyId={row.taxPolicyId}
                      lineTaxAmount={computedRows[i]?.tax ?? '0.00'}
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
