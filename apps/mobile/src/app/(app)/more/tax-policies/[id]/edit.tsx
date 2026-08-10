import { taxPolicyUpdateSchema } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TaxPolicyForm, type TaxPolicyFormValues } from '../../../../../components/TaxPolicyForm';
import { api } from '../../../../../lib/api';
import { apiErrorMessage } from '../../../../../lib/api-errors';

// Mirror of apps/web's /settings/tax-policies/[id]/edit. Seeds from the loaded
// policy (rate normalised "8.2500" → "8.25"), then PATCHes with full-replacement
// semantics — omitted optionals collapse to the column default.
export default function EditTaxPolicy() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [values, setValues] = useState<TaxPolicyFormValues | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'name' | 'ratePct', string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (values) return;
      let active = true;
      api.api['tax-policies'][':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setFormError('That could not be loaded. Try again.');
            return;
          }
          const p = await res.json();
          setValues({
            name: p.name,
            ratePct: String(Number(p.ratePct)),
            isDefault: p.isDefault,
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

  async function onSubmit() {
    if (!values) return;
    setFormError(null);
    setFieldErrors({});

    const body: Record<string, unknown> = { name: values.name.trim() };
    if (values.ratePct.trim() !== '') body.ratePct = values.ratePct.trim();
    if (values.isDefault) body.isDefault = true;

    const parsed = taxPolicyUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const errs: Partial<Record<'name' | 'ratePct', string>> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '') as 'name' | 'ratePct';
        if ((key === 'name' || key === 'ratePct') && !errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api['tax-policies'][':id'].$patch({ param: { id }, json: parsed.data });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(apiErrorMessage(errBody?.error, 'That could not be saved. Try again.'));
        return;
      }
      router.replace(`/more/tax-policies/${id}`);
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
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this tax policy.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  return (
    <TaxPolicyForm
      backLabel="Tax policy"
      onBack={() => router.back()}
      title="Edit tax policy"
      submitLabel="Save changes"
      values={values}
      onChangeField={(key, val) => setValues((v) => (v ? { ...v, [key]: val } : v))}
      onToggleDefault={() => setValues((v) => (v ? { ...v, isDefault: !v.isDefault } : v))}
      fieldErrors={fieldErrors}
      formError={formError}
      submitting={submitting}
      canSubmit={!submitting && values.name.trim().length > 0}
      onSubmit={onSubmit}
    />
  );
}
