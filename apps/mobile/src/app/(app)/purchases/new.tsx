import { capitalPurchaseCreateSchema, contactCreateSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
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
import { ContactField } from '../../../components/ContactField';
import { DateField } from '../../../components/DateField';
import { MoneyAccountPicker, useMoneyAccounts } from '../../../components/MoneyAccountPicker';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/api-errors';
import { NEW_CONTACT, findEmailDupe } from '../../../lib/contact-dupes';

// Mirror of apps/web's /purchases/new. Log a big purchase in plain language —
// the accounting (capital asset, optional loan, §179 vs depreciation) is hidden.
// Two plain forks: paid-now vs over-time, and deduct-now vs spread-out.
type Funding = 'paid_in_full' | 'financed';
type TaxTreatment = 'deduct_now' | 'spread';

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function NewPurchase() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayIso());
  const [funding, setFunding] = useState<Funding>('paid_in_full');
  const [downPayment, setDownPayment] = useState('');
  const [taxTreatment, setTaxTreatment] = useState<TaxTreatment>('deduct_now');

  // Optional "who from" — the shared ContactField type-ahead (inline-creatable).
  const [contactId, setContactId] = useState('');
  const [contactName, setContactName] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

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
        const company = await pickActiveCompany(companies);
        if (company) setCompanyId(company.id);
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

  const inlineMode = contactId === NEW_CONTACT;
  const noCompany = bootstrapped && companyId === null;
  // Cards included: a mower is as likely to go on the card as out of checking.
  const moneyAccounts = useMoneyAccounts(companyId);
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null);
  const canSubmit =
    !submitting && !noCompany && description.trim().length > 0 && amount.trim().length > 0;

  async function onSubmit() {
    if (!companyId) return;
    setFormError(null);
    setFieldErrors({});

    // Resolve the optional vendor (create inline as a vendor if the user typed a
    // new name), mirroring the bills flow — but only when one was entered.
    let resolvedContactId: string | undefined;
    if (inlineMode && newName.trim().length > 0) {
      const parsedContact = contactCreateSchema.safeParse({
        companyId,
        name: newName.trim(),
        email: newEmail.trim() === '' ? undefined : newEmail.trim(),
        isVendor: true,
      });
      if (!parsedContact.success) {
        const errs: Record<string, string> = {};
        for (const issue of parsedContact.error.issues) {
          const key = `contact_${String(issue.path[0] ?? '_')}`;
          if (!errs[key]) errs[key] = issue.message;
        }
        setFieldErrors(errs);
        return;
      }
      setSubmitting(true);
      try {
        if (parsedContact.data.email) {
          const dres = await api.api.contacts.$get({
            query: { q: parsedContact.data.email, companyId },
          });
          if (dres.ok) {
            const { contacts: list } = await dres.json();
            const dupe = findEmailDupe(
              parsedContact.data.email,
              list.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })),
            );
            if (dupe) {
              setFieldErrors({ contact_email: `${dupe.name} already uses this email.` });
              setSubmitting(false);
              return;
            }
          }
        }
        const cres = await api.api.contacts.$post({ json: parsedContact.data });
        if (!cres.ok) {
          const body = (await cres.json().catch(() => null)) as { error?: string } | null;
          setFormError(
            apiErrorMessage(body?.error, 'That customer could not be created. Try again.', body),
          );
          setSubmitting(false);
          return;
        }
        const created = await cres.json();
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
    } else if (contactId !== '' && contactId !== NEW_CONTACT) {
      resolvedContactId = contactId;
    }

    const financed = funding === 'financed';
    const parsed = capitalPurchaseCreateSchema.safeParse({
      companyId,
      description: description.trim(),
      amount: amount.trim(),
      purchaseDate: purchaseDate.trim(),
      funding,
      downPayment: financed && downPayment.trim() !== '' ? downPayment.trim() : undefined,
      // Absent → the server's primary account.
      paymentAccountId: paymentAccountId ?? undefined,
      taxTreatment,
      vendorContactId: resolvedContactId,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '_');
        if (!errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      setSubmitting(false);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api.purchases.$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(apiErrorMessage(body?.error, 'That could not be saved. Try again.', body));
        return;
      }
      const created = await res.json();
      router.replace(`/purchases/${created.id}`);
    } catch {
      setFormError('That could not be saved. Try again.');
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
              ← New expense
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Log a big purchase</Text>
          <Text className="mt-2 text-sm text-ink/60">
            Something you'll use for years — a mower, trailer, truck. We'll track what you still owe
            and how it helps at tax time.
          </Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <Field
              label="What did you buy? *"
              value={description}
              onChangeText={setDescription}
              error={fieldErrors.description}
            />
            <Field
              label="How much was it? *"
              value={amount}
              onChangeText={setAmount}
              error={fieldErrors.amount}
              keyboardType="decimal-pad"
            />
            <DateField label="When? *" value={purchaseDate} onChange={setPurchaseDate} />

            {/* Shown for both funding shapes: paid-in-full still leaves an
                account, and a financed down payment leaves one too. */}
            <MoneyAccountPicker
              accounts={moneyAccounts}
              value={paymentAccountId ?? moneyAccounts?.[0]?.id ?? null}
              onChange={setPaymentAccountId}
            />

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Did you pay all at once, or over time? *
              </Text>
              <View className="mt-2 space-y-2">
                <Choice
                  label="Paid it all at once"
                  selected={funding === 'paid_in_full'}
                  onPress={() => setFunding('paid_in_full')}
                />
                <Choice
                  label="Paying it off over time"
                  selected={funding === 'financed'}
                  onPress={() => setFunding('financed')}
                />
              </View>
            </View>

            {funding === 'financed' ? (
              <Field
                label="How much did you put down? (if any)"
                value={downPayment}
                onChangeText={setDownPayment}
                error={fieldErrors.downPayment}
                keyboardType="decimal-pad"
              />
            ) : null}

            <ContactField
              label="Who did you buy it from? (optional)"
              companyId={companyId}
              contactName={contactName}
              setContactName={setContactName}
              contactId={contactId}
              setContactId={setContactId}
              error={fieldErrors.vendorContactId}
              newName={newName}
              setNewName={setNewName}
              newEmail={newEmail}
              setNewEmail={setNewEmail}
              nameError={fieldErrors.contact_name}
              emailError={fieldErrors.contact_email}
            />

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                How do you want to handle it on taxes? *
              </Text>
              <View className="mt-2 space-y-2">
                <Choice
                  label="Deduct it all this year"
                  hint="Write off the whole cost on this year's taxes."
                  selected={taxTreatment === 'deduct_now'}
                  onPress={() => setTaxTreatment('deduct_now')}
                />
                <Choice
                  label="Spread it out over the years you'll use it"
                  hint="A little of the cost each year instead of all at once."
                  selected={taxTreatment === 'spread'}
                  onPress={() => setTaxTreatment('spread')}
                />
              </View>
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
                <Text className="text-center text-sm font-medium text-cream">Save</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Choice({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-sm border px-4 py-3 ${
        selected ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15 bg-cream-warm'
      }`}
    >
      <Text className="font-serif text-base text-ink">{label}</Text>
      {hint ? <Text className="mt-0.5 text-xs text-ink/55">{hint}</Text> : null}
    </Pressable>
  );
}

function Field({
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
  keyboardType?: 'decimal-pad';
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
