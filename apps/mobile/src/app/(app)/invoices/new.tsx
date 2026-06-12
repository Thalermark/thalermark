import {
  type InvoiceLineItemInput,
  addMoney,
  customerCreateSchema,
  invoiceCreateSchema,
  multiplyMoney,
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
import { DateField } from '../../../components/DateField';
import { ItemPickerField } from '../../../components/ItemPickerField';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { type DupeCandidate, findEmailDupe, findNameDupes } from '../../../lib/customer-dupes';

// Mirror of apps/web's /invoices/new (+page.svelte + server action), client-
// side. Two-step create when adding a customer inline; money math done with
// the shared helpers (server is authority but must agree); sourceItemId rides
// each line via ItemPickerField. See the slice plan / apps/mobile/CLAUDE.md.
const NEW_CUSTOMER = '__new__';

type Row = {
  description: string;
  quantity: string;
  unitPrice: string;
  sourceItemId: string | null;
};
const blankRow = (): Row => ({ description: '', quantity: '', unitPrice: '', sourceItemId: null });

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
  customer_company_mismatch: 'Selected customer does not belong to this company.',
  customer_not_found: 'Selected customer no longer exists.',
};

export default function NewInvoice() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<DupeCandidate[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const [number, setNumber] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(plusDaysIso(30));
  const [tax, setTax] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([blankRow()]);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
          if (company) {
            setCompanyId(company.id);
            const numRes = await api.api.invoices['next-number'].$get({
              query: { companyId: company.id },
            });
            if (active && numRes.ok) setNumber((await numRes.json()).suggestion);
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

  async function onSubmit() {
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    setFormError(null);
    setFieldErrors({});

    // Step 1: resolve the customer (create inline if needed).
    let resolvedCustomerId = customerId;
    if (inlineMode) {
      const custInput = {
        companyId,
        name: newName.trim(),
        email: newEmail.trim() === '' ? undefined : newEmail.trim(),
      };
      const parsedCust = customerCreateSchema.safeParse(custInput);
      if (!parsedCust.success) {
        const errs: Record<string, string> = {};
        for (const issue of parsedCust.error.issues) {
          const key = `customer_${String(issue.path[0] ?? '_')}`;
          if (!errs[key]) errs[key] = issue.message;
        }
        setFieldErrors(errs);
        return;
      }
      if (findEmailDupe(parsedCust.data.email, customers)) return; // hard block (submit already disabled)

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
        // Recovery: keep the created customer selected so a retry (e.g. after a
        // number collision) doesn't create a second one.
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

    // Step 2: compute money + create the invoice.
    const lineItems: InvoiceLineItemInput[] = rows.map((r, i) => ({
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
      number: number.trim(),
      issueDate: issueDate.trim(),
      dueDate: dueDate.trim(),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal ?? '0'),
      notes: notes.trim() === '' ? undefined : notes.trim(),
      lineItems,
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
        const code = body?.error ?? 'create_failed';
        setFormError(FRIENDLY[code] ?? code);
        return;
      }
      const created = await res.json();
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
              {fieldErrors.customerId ? (
                <Text className="mt-1 text-xs text-oxblood">{fieldErrors.customerId}</Text>
              ) : null}
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
                          onPress={() => {
                            setCustomerId(d.id);
                            setPickerOpen(false);
                          }}
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
                  <Text className="mt-1 text-xs text-ink/50">
                    Optional, but needed to send the invoice by email.
                  </Text>
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

            {/* Tax + totals */}
            <LabeledInput label="Tax" value={tax} onChangeText={setTax} error={fieldErrors.tax} />
            <View className="rounded-sm border border-ink/10 bg-cream-warm p-4">
              <Row label="Subtotal" value={subtotal} />
              <Row label="Tax" value={tax || '0.00'} />
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

      {/* Customer picker */}
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
