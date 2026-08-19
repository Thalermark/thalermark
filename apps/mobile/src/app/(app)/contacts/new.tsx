import { contactCreateSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
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
import { AddressField, type AddressSuggestion } from '../../../components/AddressField';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/api-errors';
import { type DupeCandidate, findEmailDupe, findNameDupes } from '../../../lib/contact-dupes';

// Mirror of apps/web's /contacts/new (+page.svelte + its server action),
// client-side. The API has no dupe endpoint and doesn't auto-pick a company,
// so this screen does both: load the contact list for live dupe hints, grab
// the active company for the required companyId, hard-block on an exact email dupe.
type OptionalKey =
  | 'email'
  | 'phone'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'country'
  | 'notes';

const OPTIONAL_FIELDS: OptionalKey[] = [
  'email',
  'phone',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'country',
  'notes',
];

type FieldKey = 'name' | OptionalKey;

export default function NewContact() {
  const router = useRouter();

  const [values, setValues] = useState<Record<FieldKey, string>>({
    name: '',
    email: '',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    notes: '',
  });
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [contacts, setContacts] = useState<DupeCandidate[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load companies (for companyId) + the contact list (for dupe hints) once.
  useFocusEffect(
    useCallback(() => {
      if (bootstrapped) return;
      let active = true;
      Promise.all([api.api.companies.$get(), api.api.contacts.$get()])
        .then(async ([companiesRes, contactsRes]) => {
          if (!active) return;
          if (companiesRes.ok) {
            const { companies } = await companiesRes.json();
            const company = await pickActiveCompany(companies);
            setCompanyId(company?.id ?? null);
          }
          if (contactsRes.ok) {
            const { contacts: rows } = await contactsRes.json();
            setContacts(rows.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null })));
          }
          setBootstrapped(true);
        })
        .catch(() => {
          if (active) setBootstrapped(true);
        });
      return () => {
        active = false;
      };
    }, [bootstrapped]),
  );

  const set = (key: FieldKey, val: string) => setValues((v) => ({ ...v, [key]: val }));

  // Picking an address suggestion rewrites Street + fans the rest into the
  // sibling city / region / postalCode / country fields (a programmatic write,
  // so it doesn't re-trigger the type-ahead).
  const applyAddress = (s: AddressSuggestion) =>
    setValues((v) => ({
      ...v,
      addressLine1: s.addressLine1,
      city: s.city,
      region: s.region,
      postalCode: s.postalCode,
      country: s.country,
    }));

  const emailDupe = useMemo(() => findEmailDupe(values.email, contacts), [values.email, contacts]);
  const nameDupes = useMemo(() => findNameDupes(values.name, contacts), [values.name, contacts]);

  const noCompany = bootstrapped && companyId === null;
  const canSubmit = !submitting && !emailDupe && !noCompany && values.name.trim().length > 0;

  async function onSubmit() {
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    setFormError(null);
    setFieldErrors({});

    // Trim; omit empty optionals so undefined (not '') reaches the schema —
    // '' would fail .email()/.max(). Matches web's readForm().
    const body: Record<string, string> = { companyId, name: values.name.trim() };
    for (const k of OPTIONAL_FIELDS) {
      const trimmed = values[k].trim();
      if (trimmed !== '') body[k] = trimmed;
    }

    const parsed = contactCreateSchema.safeParse(body);
    if (!parsed.success) {
      const errs: Partial<Record<FieldKey, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '') as FieldKey;
        if (key && !errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api.contacts.$post({ json: parsed.data });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(apiErrorMessage(errBody?.error, 'That could not be created. Try again.'));
        return;
      }
      const created = await res.json();
      router.replace(`/contacts/${created.id}`);
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
              ← Contacts
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New contact</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 gap-5">
            <Field
              label="Name *"
              value={values.name}
              onChangeText={(t) => set('name', t)}
              error={fieldErrors.name}
            />
            {nameDupes.length > 0 ? (
              <View className="rounded-sm border border-ink/10 bg-cream-warm/60 p-3">
                <Text className="text-xs text-ink-subtle">
                  Looks like {nameDupes.length === 1 ? 'an existing contact' : 'existing contacts'}:
                </Text>
                {nameDupes.map((d) => (
                  <Pressable
                    key={d.id}
                    onPress={() => router.push(`/contacts/${d.id}`)}
                    className="mt-1 flex-row items-center justify-between"
                  >
                    <Text className="text-sm text-ink">
                      {d.name}
                      {d.email ? <Text className="text-ink-subtle"> · {d.email}</Text> : null}
                    </Text>
                    <Text className="font-mono text-xs uppercase tracking-wider text-gold-deep">
                      Open
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <Field
              label="Email"
              value={values.email}
              onChangeText={(t) => set('email', t)}
              error={fieldErrors.email}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            {emailDupe ? (
              <View className="rounded-sm border border-oxblood/30 bg-oxblood/5 p-3">
                <Text className="text-sm text-ink">
                  <Text className="font-medium">{emailDupe.name}</Text> already uses this email.
                </Text>
                <Pressable
                  onPress={() => router.push(`/contacts/${emailDupe.id}`)}
                  className="mt-2"
                >
                  <Text className="font-mono text-xs uppercase tracking-wider text-gold-deep">
                    Open {emailDupe.name}
                  </Text>
                </Pressable>
                <Text className="mt-1 text-xs text-ink-subtle">
                  or change the email to create a different contact.
                </Text>
              </View>
            ) : null}

            <Field
              label="Phone"
              value={values.phone}
              onChangeText={(t) => set('phone', t)}
              keyboardType="phone-pad"
            />
            <AddressField
              value={values.addressLine1}
              onChangeText={(t) => set('addressLine1', t)}
              onPick={applyAddress}
              country={values.country}
            />
            <Field
              label="Suite, unit, etc."
              value={values.addressLine2}
              onChangeText={(t) => set('addressLine2', t)}
            />
            <Field label="City" value={values.city} onChangeText={(t) => set('city', t)} />
            <Field
              label="State / Region"
              value={values.region}
              onChangeText={(t) => set('region', t)}
            />
            <Field
              label="Postal code"
              value={values.postalCode}
              onChangeText={(t) => set('postalCode', t)}
            />
            <Field
              label="Country (ISO, e.g. US)"
              value={values.country}
              onChangeText={(t) => set('country', t)}
              autoCapitalize="characters"
              error={fieldErrors.country}
            />
            <Field
              label="Notes"
              value={values.notes}
              onChangeText={(t) => set('notes', t)}
              multiline
            />

            {noCompany ? (
              <Text className="text-xs text-oxblood">No company in this workspace.</Text>
            ) : null}

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className="mt-2 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
            >
              {submitting ? (
                <ActivityIndicator className="text-cream" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">Create contact</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Small labelled TextInput matching the (auth) screens' field idiom.
function Field({
  label,
  value,
  onChangeText,
  error,
  keyboardType,
  autoCapitalize,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
  keyboardType?: 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'characters';
  multiline?: boolean;
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        multiline={multiline}
        className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}
