import { contactUpdateSchema } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
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
import { AddressField, type AddressSuggestion } from '../../../../components/AddressField';
import { api } from '../../../../lib/api';
import { apiErrorMessage } from '../../../../lib/api-errors';

// Edit half of apps/web's /contacts/[id]/edit. Seeds from the loaded contact,
// then PATCHes with full-replacement semantics — undefined optionals clear the
// column (mirror of contacts/new minus the dupe detection, which only matters
// when creating). companyId is immutable, so it's not in the schema.
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
type Values = Record<FieldKey, string>;

export default function EditContact() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [values, setValues] = useState<Values | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed once from the loaded contact; don't clobber edits on a focus regain.
  useFocusEffect(
    useCallback(() => {
      if (values) return;
      let active = true;
      api.api.contacts[':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setFormError('That could not be loaded. Try again.');
            return;
          }
          const c = await res.json();
          setValues({
            name: c.name,
            email: c.email ?? '',
            phone: c.phone ?? '',
            addressLine1: c.addressLine1 ?? '',
            addressLine2: c.addressLine2 ?? '',
            city: c.city ?? '',
            region: c.region ?? '',
            postalCode: c.postalCode ?? '',
            country: c.country ?? '',
            notes: c.notes ?? '',
          });
        })
        .catch(() => {
          if (active) setFormError('That could not be loaded. Try again.');
        });
      return () => {
        active = false;
      };
    }, [id, values]),
  );

  const set = (key: FieldKey, val: string) => setValues((v) => (v ? { ...v, [key]: val } : v));

  // Picking an address suggestion rewrites Street + fans the rest into the
  // sibling fields (a programmatic write, so it doesn't re-trigger the search).
  const applyAddress = (s: AddressSuggestion) =>
    setValues((v) =>
      v
        ? {
            ...v,
            addressLine1: s.addressLine1,
            city: s.city,
            region: s.region,
            postalCode: s.postalCode,
            country: s.country,
          }
        : v,
    );

  async function onSubmit() {
    if (!values) return;
    setFormError(null);
    setFieldErrors({});

    // Trim; omit empty optionals so undefined (not '') reaches the schema —
    // full-replacement on the API clears the column. Matches contacts/new.
    const body: Record<string, string> = { name: values.name.trim() };
    for (const k of OPTIONAL_FIELDS) {
      const trimmed = values[k].trim();
      if (trimmed !== '') body[k] = trimmed;
    }

    const parsed = contactUpdateSchema.safeParse(body);
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
      const res = await api.api.contacts[':id'].$patch({ param: { id }, json: parsed.data });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(apiErrorMessage(errBody?.error, 'That could not be saved. Try again.'));
        return;
      }
      router.replace(`/contacts/${id}`);
    } catch {
      setFormError('That could not be saved. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!values) {
    return (
      <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
        {formError ? (
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this contact.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        )}
      </SafeAreaView>
    );
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
              ← {values.name || 'Contact'}
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">Edit contact</Text>

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
            <Field
              label="Email"
              value={values.email}
              onChangeText={(t) => set('email', t)}
              error={fieldErrors.email}
              keyboardType="email-address"
              autoCapitalize="none"
            />
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

            <Pressable
              onPress={onSubmit}
              disabled={submitting || values.name.trim().length === 0}
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

// Matches the field idiom in contacts/new.
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
