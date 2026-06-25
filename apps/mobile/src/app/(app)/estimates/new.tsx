import {
  type EstimateLineItemInput,
  type LineItemType,
  addMoney,
  contactCreateSchema,
  estimateCreateSchema,
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
import { Checkbox } from '../../../components/Checkbox';
import { DateField } from '../../../components/DateField';
import { type ItemPatch, ItemPickerField } from '../../../components/ItemPickerField';
import { TaxRow } from '../../../components/TaxRow';
import { TypeRow } from '../../../components/TypeRow';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { type DupeCandidate, findEmailDupe, findNameDupes } from '../../../lib/contact-dupes';
import { type TaxPolicyLite, lineTax, policyRate, resolvePolicyId } from '../../../lib/line-tax';

// Mirror of apps/web's /estimates/new — the invoice create form minus dueDate,
// plus an optional expiresOn (quote validity). Two-step create with inline
// contact; decimal-string money; sourceItemId via ItemPickerField.
const NEW_CONTACT = '__new__';

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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const FRIENDLY: Record<string, string> = {
  estimate_number_taken: 'Estimate number already used for this company. Try another.',
  customer_company_mismatch: 'Selected contact does not belong to this company.',
  contact_not_found: 'Selected contact no longer exists.',
};

export default function NewEstimate() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<DupeCandidate[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [contactId, setContactId] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const [number, setNumber] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [expiresOn, setExpiresOn] = useState('');
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
  const [notes, setNotes] = useState('');
  // From-block "show on this estimate" toggles, seeded from the company's
  // estimate-side defaults at bootstrap. Default true so a load failure still
  // submits a sensible (always-show) estimate.
  const [showAddress, setShowAddress] = useState(true);
  const [showPhone, setShowPhone] = useState(true);
  const [showEmail, setShowEmail] = useState(true);
  const [rows, setRows] = useState<Row[]>([blankRow()]);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Bootstrap once — ref gate (not a state dep), so a state flip can't tear
  // down `active` mid-flight and drop the next-number prefill (M3 footgun).
  const didBootstrap = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (didBootstrap.current) return;
      didBootstrap.current = true;
      let active = true;
      (async () => {
        const [compRes, custRes] = await Promise.all([
          api.api.companies.$get(),
          api.api.contacts.$get(),
        ]);
        if (!active) return;
        if (custRes.ok) {
          const { contacts: rowsC } = await custRes.json();
          setContacts(rowsC.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })));
        }
        if (compRes.ok) {
          const { companies } = await compRes.json();
          const company = await pickActiveCompany(companies);
          if (company) {
            setCompanyId(company.id);
            setShowAddress(company.showAddressOnEstimate);
            setShowPhone(company.showPhoneOnEstimate);
            setShowEmail(company.showEmailOnEstimate);
            const numRes = await api.api.estimates['next-number'].$get({
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
  const selectedName =
    contactId && !inlineMode ? contacts.find((c) => c.id === contactId)?.name : null;

  const emailDupe = useMemo(
    () => (inlineMode ? findEmailDupe(newEmail, contacts) : undefined),
    [inlineMode, newEmail, contacts],
  );
  const nameDupes = useMemo(
    () => (inlineMode ? findNameDupes(newName, contacts) : []),
    [inlineMode, newName, contacts],
  );

  const computedRows = useMemo(
    () =>
      rows.map((r) => {
        const amount = multiplyMoney(r.quantity, r.unitPrice);
        const rate = r.taxable ? policyRate(taxPolicies, r.taxPolicyId) : '0';
        return { ...r, amount, tax: lineTax(r.taxable, rate, amount) };
      }),
    [rows, taxPolicies],
  );
  const subtotal = useMemo(() => sumMoney(computedRows.map((r) => r.amount)), [computedRows]);
  const taxTotal = useMemo(() => sumMoney(computedRows.map((r) => r.tax)), [computedRows]);
  const total = useMemo(() => addMoney(subtotal, taxTotal), [subtotal, taxTotal]);

  const patchRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
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

  const noCompany = bootstrapped && companyId === null;
  const hasContact = inlineMode ? newName.trim().length > 0 : contactId !== '';
  const canSubmit = !submitting && !noCompany && !emailDupe && hasContact;

  async function onSubmit() {
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    setFormError(null);
    setFieldErrors({});

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
      if (findEmailDupe(parsedCust.data.email, contacts)) return;

      setSubmitting(true);
      try {
        const custRes = await api.api.contacts.$post({ json: parsedCust.data });
        if (!custRes.ok) {
          const body = (await custRes.json().catch(() => null)) as { error?: string } | null;
          setFormError(body?.error ?? 'contact_create_failed');
          return;
        }
        const created = await custRes.json();
        resolvedContactId = created.id;
        setContacts((cs) => [
          { id: created.id, name: created.name, email: newEmail.trim() || null },
          ...cs,
        ]);
        setContactId(created.id);
        setNewName('');
        setNewEmail('');
      } catch {
        setFormError('contact_create_failed');
        setSubmitting(false);
        return;
      }
    }

    const lineItems: EstimateLineItemInput[] = rows.map((r, i) => {
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
      companyId,
      contactId: resolvedContactId,
      number: number.trim(),
      issueDate: issueDate.trim(),
      expiresOn: expiresOn.trim() === '' ? undefined : expiresOn.trim(),
      subtotal: sub,
      tax: taxVal,
      total: addMoney(sub, taxVal),
      notes: notes.trim() === '' ? undefined : notes.trim(),
      showAddress,
      showPhone,
      showEmail,
      lineItems,
    };

    const parsed = estimateCreateSchema.safeParse(payload);
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
      const res = await api.api.estimates.$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = body?.error ?? 'create_failed';
        setFormError(FRIENDLY[code] ?? code);
        return;
      }
      const created = await res.json();
      router.replace(`/estimates/${created.id}`);
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
              ← Estimates
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New estimate</Text>

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
                <Text className={selectedName || inlineMode ? 'text-ink' : 'text-ink/40'}>
                  {inlineMode ? '+ New contact' : (selectedName ?? 'Select a contact')}
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
                  {fieldErrors.contact_name ? (
                    <Text className="mt-1 text-xs text-oxblood">{fieldErrors.contact_name}</Text>
                  ) : null}
                  {nameDupes.length > 0 ? (
                    <View className="mt-2 rounded-sm border border-ink/10 bg-cream p-2">
                      <Text className="text-xs text-ink/60">Looks like an existing contact:</Text>
                      {nameDupes.map((d) => (
                        <Pressable
                          key={d.id}
                          onPress={() => setContactId(d.id)}
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
                    <Pressable onPress={() => setContactId(emailDupe.id)} className="mt-2">
                      <Text className="font-mono text-xs uppercase tracking-wider text-gold-deep">
                        Use {emailDupe.name}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : null}

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
              label="Valid until"
              value={expiresOn}
              onChange={setExpiresOn}
              error={fieldErrors.expiresOn}
              optional
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

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Your details on this estimate
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
                <Text className="text-center text-sm font-medium text-cream">Create estimate</Text>
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
              <Pressable
                onPress={() => {
                  setContactId(NEW_CONTACT);
                  setPickerOpen(false);
                }}
                className="border-b border-ink/10 py-3"
              >
                <Text className="font-medium text-gold-deep">+ New contact</Text>
              </Pressable>
              {contacts.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => {
                    setContactId(c.id);
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
