import {
  type InvoiceLineItemInput,
  type LineItemType,
  addMoney,
  contactCreateSchema,
  formatUnitPrice,
  hoursFromMinutes,
  invoiceCreateSchema,
  multiplyMoney,
  sumMoney,
  unitPriceFromTotal,
} from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
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
import { Checkbox } from '../../../components/Checkbox';
import { ContactField } from '../../../components/ContactField';
import { DateField } from '../../../components/DateField';
import { type ItemPatch, ItemPickerField } from '../../../components/ItemPickerField';
import { TaxRow } from '../../../components/TaxRow';
import { TypeRow } from '../../../components/TypeRow';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/api-errors';
import { NEW_CONTACT, findEmailDupe } from '../../../lib/contact-dupes';
import { useFlowAbandonment } from '../../../lib/flow-abandonment';
import { type TaxPolicyLite, lineTax, policyRate, resolvePolicyId } from '../../../lib/line-tax';

// Mirror of apps/web's /invoices/new (+page.svelte + server action), client-
// side. The contact selector is a type-ahead (ContactField) that searches
// /api/contacts on demand; two-step create when adding a contact inline; money
// math done with the shared helpers (server is authority but must agree);
// sourceItemId rides each line via ItemPickerField. See apps/mobile/CLAUDE.md.

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
  // Set when this row was seeded from a tracked time entry (TMC-180). Carried on
  // the ROW, not in a separate list, so deleting the row also drops the entry
  // from billedTimeEntryIds — otherwise an entry could be stamped billed with
  // no line on the invoice to show for it.
  timeEntryId: string | null;
};
const blankRow = (): Row => ({
  timeEntryId: null,
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function plusDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const FRIENDLY: Record<string, string> = {
  invoice_number_taken: 'Invoice number already used for this company. Try another.',
  customer_company_mismatch: 'Selected contact does not belong to this company.',
  contact_not_found: 'Selected contact no longer exists.',
};

export default function NewInvoice() {
  const router = useRouter();
  // Set when the user came from a job's "Bill this job" — attaches the invoice
  // to that job and seeds its unbilled hours as line rows.
  const { jobId } = useLocalSearchParams<{ jobId?: string }>();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [contactId, setContactId] = useState('');
  const [contactName, setContactName] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const [number, setNumber] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(plusDaysIso(30));
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
  const [notes, setNotes] = useState('');
  // From-block "show on this invoice" toggles, seeded from the company defaults
  // at bootstrap. Default true so a no-company / load failure still submits a
  // sensible (always-show) invoice.
  const [showAddress, setShowAddress] = useState(true);
  const [showPhone, setShowPhone] = useState(true);
  const [showEmail, setShowEmail] = useState(true);
  const [rows, setRows] = useState<Row[]>([blankRow()]);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // invoice_flow_abandoned: on leaving without submitting, emit the furthest
  // section engaged — 'line_items' if any row has content, else 'details' if a
  // contact is chosen/typed, else nothing.
  const flow = useFlowAbandonment('invoice_flow_abandoned', () =>
    rows.some((r) => r.description || r.quantity || r.unitPrice)
      ? 'line_items'
      : contactId || newName
        ? 'details'
        : null,
  );

  // Bootstrap once. A ref (not the `bootstrapped` state) gates re-entry: using
  // state as the effect dep would re-run the effect when it flips, tearing down
  // `active` mid-flight and dropping the still-pending next-number prefill.
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
            setShowAddress(company.showAddressOnInvoice);
            setShowPhone(company.showPhoneOnInvoice);
            setShowEmail(company.showEmailOnInvoice);
            const numRes = await api.api.invoices['next-number'].$get({
              query: { companyId: company.id },
            });
            if (active && numRes.ok) setNumber((await numRes.json()).suggestion);
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

        // Arriving from a job's "Bill this job" (TMC-180). The job's unbilled
        // hours are SEEDED AS LINE ROWS rather than offered in a separate
        // checklist: on a phone, a row you can see and edit beats a list you
        // have to reconcile against one. Deleting a row drops its entry too,
        // because billedTimeEntryIds is derived from the rows.
        //
        // Priced with the same multiplyMoney every typed row uses, so a billed
        // hour and a hand-typed hour cannot round differently.
        if (jobId) {
          const timeRes = await api.api.jobs[':id'].time.$get({
            param: { id: jobId },
            query: { unbilled: 'true' },
          });
          if (active && timeRes.ok) {
            const { timeEntries } = await timeRes.json();
            const seeded = timeEntries.map((t): Row => {
              const quantity = hoursFromMinutes(t.minutes);
              const unitPrice = t.rate ?? '0';
              return {
                timeEntryId: t.id,
                description: t.note?.trim() || 'Hours',
                quantity,
                unitLabel: 'hour',
                unitPrice,
                amount: multiplyMoney(quantity, unitPrice),
                sourceItemId: null,
                // Labour is a service — routes revenue to 4000 in the hidden
                // ledger.
                type: 'service',
                // Whether labour is taxable varies by state and trade; guessing
                // is worse than the user ticking the row.
                taxable: false,
                taxPolicyId: '',
              };
            });
            if (seeded.length > 0) setRows([...seeded, blankRow()]);
          }
        }

        if (active) setBootstrapped(true);
      })().catch(() => {
        if (active) setBootstrapped(true);
      });
      return () => {
        active = false;
      };
    }, [jobId]),
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
  // Toggle a row taxable, seeding a concrete policy when turning on.
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
  // A catalog pick carries the item's taxability + policy; resolve to a concrete
  // active policy. Hand-typing (no taxable in patch) just patches normally.
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

  async function onSubmit() {
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    setFormError(null);
    setFieldErrors({});

    // Step 1: resolve the contact (create inline if needed).
    let resolvedContactId = contactId;
    if (inlineMode) {
      const custInput = {
        companyId,
        name: newName.trim(),
        email: newEmail.trim() === '' ? undefined : newEmail.trim(),
      };
      const parsedCust = contactCreateSchema.safeParse(custInput);
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
          setFormError(apiErrorMessage(body?.error, 'contact_create_failed', body));
          return;
        }
        const created = await custRes.json();
        resolvedContactId = created.id;
        // Recovery: keep the created contact selected so a retry (e.g. after a
        // number collision) doesn't create a second one.
        setContactName(created.name);
        setContactId(created.id);
        setNewName('');
        setNewEmail('');
      } catch {
        setFormError('contact_create_failed');
        setSubmitting(false);
        return;
      }
    }

    // Step 2: compute money + create the invoice. The line tax rate comes from
    // the line's policy; the invoice tax is the derived sum of line tax.
    const lineItems: InvoiceLineItemInput[] = rows.map((r, i) => {
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
    const billedIds = rows.map((r) => r.timeEntryId).filter((v): v is string => v !== null);
    const sub = sumMoney(lineItems.map((li) => li.amount));
    const taxVal = sumMoney(lineItems.map((li) => li.taxAmount ?? '0'));
    const payload = {
      companyId,
      contactId: resolvedContactId,
      number: number.trim(),
      issueDate: issueDate.trim(),
      dueDate: dueDate.trim(),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal),
      notes: notes.trim() === '' ? undefined : notes.trim(),
      showAddress,
      showPhone,
      showEmail,
      lineItems,
      jobId: jobId || undefined,
      // Derived from the rows, so a deleted hour row takes its entry with it.
      billedTimeEntryIds: billedIds.length > 0 ? billedIds : undefined,
    };

    const parsed = invoiceCreateSchema.safeParse(payload);
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
      const res = await api.api.invoices.$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = apiErrorMessage(body?.error, 'create_failed', body);
        setFormError(FRIENDLY[code] ?? code);
        return;
      }
      const created = await res.json();
      flow.markSubmitted();
      router.replace(`/invoices/${created.id}`);
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
              ← Invoices
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New invoice</Text>

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

            {/* Number + dates */}
            <LabeledInput
              label="Number *"
              value={number}
              onChangeText={setNumber}
              error={fieldErrors.number}
            />
            <DateField
              label="Issued *"
              value={issueDate}
              onChange={setIssueDate}
              error={fieldErrors.issueDate}
            />
            <DateField
              label="Due *"
              value={dueDate}
              onChange={setDueDate}
              error={fieldErrors.dueDate}
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

            {/* Totals — tax is the derived sum of per-line tax. */}
            <View className="rounded-sm border border-ink/10 bg-cream-warm p-4">
              <Row label="Subtotal" value={subtotal} />
              <Row label="Tax" value={taxTotal} />
              <View className="mt-3 border-t border-ink/10 pt-3">
                <Row label="Total" value={total} emphasize />
              </View>
            </View>

            {/* Notes */}
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Notes</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                multiline
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
              />
            </View>

            {/* From-block toggles */}
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Your details on this invoice
              </Text>
              <Text className="mt-1 text-xs text-ink/50">
                Only details you've added in Business settings will show.
              </Text>
              <Checkbox
                label="Show my address"
                value={showAddress}
                onToggle={() => setShowAddress((v) => !v)}
                className="mt-3"
              />
              <Checkbox
                label="Show my phone"
                value={showPhone}
                onToggle={() => setShowPhone((v) => !v)}
                className="mt-3"
              />
              <Checkbox
                label="Show my email"
                value={showEmail}
                onToggle={() => setShowEmail((v) => !v)}
                className="mt-3"
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
                <Text className="text-center text-sm font-medium text-cream">Create invoice</Text>
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
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
  autoCapitalize?: 'none';
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
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
