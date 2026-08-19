import { billCreateSchema, contactCreateSchema } from '@thalermark/validation';
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
import { ContactField } from '../../../components/ContactField';
import { DateField } from '../../../components/DateField';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/api-errors';
import { NEW_CONTACT, findEmailDupe } from '../../../lib/contact-dupes';

// Mirror of apps/web's /bills/new. A bill is the accrual sibling of an expense:
// you owe a vendor now, pay later. Header-only — a single vendor (a contact,
// inline-creatable as a vendor), a single category (an 'expense' COA account),
// an amount, and dates. No line items, no tax field (purchase sales tax rolls
// into the amount for the cash-basis sole-prop audience). The vendor selector is
// the shared ContactField type-ahead; the category a bottom-sheet picker like
// the expense form.
type Account = { id: string; code: string; name: string };

const todayIso = () => new Date().toISOString().slice(0, 10);

const FRIENDLY: Record<string, string> = {
  invalid_category_account: 'That category is no longer a valid expense account. Pick another.',
  contact_not_found: 'That vendor could not be found. Pick another.',
  company_not_found: 'No company in this workspace.',
};

export default function NewBill() {
  const router = useRouter();

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [categories, setCategories] = useState<Account[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Vendor field: '' (none) | <uuid> (linked) | NEW_CONTACT (inline create).
  const [contactId, setContactId] = useState('');
  const [contactName, setContactName] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [amount, setAmount] = useState('');
  const [billDate, setBillDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Bootstrap once — a ref (not the `bootstrapped` state) gates re-entry so a
  // focus regain doesn't tear down a still-pending fetch (the M3 caution).
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
        const catRes = await api.api.companies[':id'].accounts.$get({
          param: { id: company.id },
          query: { type: 'expense' },
        });
        if (active && catRes.ok) setCategories((await catRes.json()).accounts);
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
  const categoryName = categories.find((a) => a.id === categoryId)?.name ?? null;
  const noCompany = bootstrapped && companyId === null;
  const hasContact = inlineMode ? newName.trim().length > 0 : contactId !== '';
  const canSubmit =
    !submitting && !noCompany && hasContact && categoryId !== null && amount.trim().length > 0;

  async function onSubmit() {
    if (!companyId || !categoryId) return;
    setFormError(null);
    setFieldErrors({});

    // Step 1: resolve the vendor (create inline as a vendor if needed). Mirrors
    // the invoice new-contact flow, with isVendor set so the contact lands in
    // the vendor list + the expense vendor picker.
    let resolvedContactId = contactId;
    if (inlineMode) {
      const contactInput = {
        companyId,
        name: newName.trim(),
        email: newEmail.trim() === '' ? undefined : newEmail.trim(),
        isVendor: true,
      };
      const parsedContact = contactCreateSchema.safeParse(contactInput);
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
        // HARD BLOCK on an exact email match (the API doesn't dedupe). Search by
        // the email so the check is correct at any contact count.
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
        const custRes = await api.api.contacts.$post({ json: parsedContact.data });
        if (!custRes.ok) {
          const body = (await custRes.json().catch(() => null)) as { error?: string } | null;
          setFormError(
            apiErrorMessage(body?.error, 'That customer could not be created. Try again.', body),
          );
          return;
        }
        const created = await custRes.json();
        resolvedContactId = created.id;
        // Recovery: keep the created vendor selected so a retry (e.g. after a
        // validation bounce) doesn't create a second one.
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

    // Step 2: validate + create the bill.
    const payload = {
      companyId,
      contactId: resolvedContactId,
      categoryAccountId: categoryId,
      amount: amount.trim(),
      billDate: billDate.trim(),
      dueDate: dueDate.trim(),
      reference: reference.trim() === '' ? undefined : reference.trim(),
      memo: memo.trim() === '' ? undefined : memo.trim(),
    };
    const parsed = billCreateSchema.safeParse(payload);
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
      const res = await api.api.bills.$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = apiErrorMessage(body?.error, 'That could not be created. Try again.', body);
        setFormError(
          FRIENDLY[code] ?? apiErrorMessage(code, 'That could not be saved. Try again.'),
        );
        return;
      }
      const created = await res.json();
      router.replace(`/bills/${created.id}`);
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
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              ← Bills
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New bill</Text>
          <Text className="mt-2 text-sm text-ink-subtle">
            A bill is something you owe a vendor and will pay later. Record it now; mark it paid
            when you settle it.
          </Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 gap-5">
            <ContactField
              label="Vendor *"
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

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Category *
              </Text>
              <Pressable
                onPress={() => setPicker(true)}
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-3"
              >
                <Text className={categoryName ? 'text-ink' : 'text-ink-subtle'}>
                  {categoryName ?? 'Select a category…'}
                </Text>
              </Pressable>
              {fieldErrors.categoryAccountId ? (
                <Text className="mt-1 text-xs text-oxblood">{fieldErrors.categoryAccountId}</Text>
              ) : null}
            </View>

            <Field
              label="Amount *"
              value={amount}
              onChangeText={setAmount}
              error={fieldErrors.amount}
              keyboardType="decimal-pad"
            />
            <DateField
              label="Bill date *"
              value={billDate}
              onChange={setBillDate}
              error={fieldErrors.billDate}
            />
            <DateField
              label="Due date *"
              value={dueDate}
              onChange={setDueDate}
              error={fieldErrors.dueDate}
            />
            <Field
              label="Reference"
              value={reference}
              onChangeText={setReference}
              error={fieldErrors.reference}
            />
            <Field label="Memo" value={memo} onChangeText={setMemo} />

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
                <Text className="text-center text-sm font-medium text-cream">Save bill</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={picker}
        animationType="slide"
        transparent
        onRequestClose={() => setPicker(false)}
      >
        <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setPicker(false)}>
          <Pressable
            className="max-h-[70%] rounded-t-lg bg-cream px-6 pb-10 pt-5"
            onPress={() => {}}
          >
            <Text className="font-serif text-xl text-ink">Choose category</Text>
            <ScrollView className="mt-4">
              {categories.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => {
                    setCategoryId(a.id);
                    setPicker(false);
                  }}
                  className="border-b border-ink/10 py-3"
                >
                  <Text className="text-ink">{a.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}
