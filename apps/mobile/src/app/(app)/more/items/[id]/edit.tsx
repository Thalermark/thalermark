import { type LineItemType, itemUpdateSchema } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  type ItemFieldKey,
  ItemForm,
  type ItemFormValues,
} from '../../../../../components/ItemForm';
import { api } from '../../../../../lib/api';
import { type TaxPolicyLite, resolvePolicyId } from '../../../../../lib/line-tax';

// Mirror of apps/web's /settings/items/[id]/edit. Seeds from the loaded item,
// then PATCHes with full-replacement semantics — omitted optionals collapse to
// the column default server-side, so clearing a field clears the value.
const OPTIONAL_KEYS: Exclude<ItemFieldKey, 'name'>[] = [
  'description',
  'unitPrice',
  'unitLabel',
  'defaultQuantity',
];

export default function EditItem() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [values, setValues] = useState<ItemFormValues | null>(null);
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
  const [type, setType] = useState<LineItemType>('service');
  const [taxable, setTaxable] = useState(false);
  const [taxPolicyId, setTaxPolicyId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ItemFieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed once from the loaded item; don't clobber edits on a focus regain.
  useFocusEffect(
    useCallback(() => {
      if (values) return;
      let active = true;
      api.api.items[':id']
        .$get({ param: { id } })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setFormError('load_failed');
            return;
          }
          const i = await res.json();
          setValues({
            name: i.name,
            description: i.description ?? '',
            unitPrice: i.unitPrice,
            unitLabel: i.unitLabel ?? '',
            defaultQuantity: i.defaultQuantity,
          });
          setType(i.type === 'product' ? 'product' : 'service');
          setTaxable(i.taxable ?? false);
          setTaxPolicyId(i.taxPolicyId ?? '');
          const polRes = await api.api['tax-policies'].$get({ query: { companyId: i.companyId } });
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
        })
        .catch(() => {
          if (active) setFormError('load_failed');
        });
      return () => {
        active = false;
      };
    }, [id, values]),
  );

  const set = (key: ItemFieldKey, val: string) => setValues((v) => (v ? { ...v, [key]: val } : v));
  function toggleTaxable() {
    const turningOn = !taxable;
    setTaxable(turningOn);
    if (turningOn && !taxPolicyId) setTaxPolicyId(resolvePolicyId(taxPolicies, ''));
  }

  async function onSubmit() {
    if (!values) return;
    setFormError(null);
    setFieldErrors({});

    const body: Record<string, unknown> = { name: values.name.trim(), type };
    for (const k of OPTIONAL_KEYS) {
      const trimmed = values[k].trim();
      if (trimmed !== '') body[k] = trimmed;
    }
    // Full-replacement: unchecking taxable clears the policy server-side (the
    // omitted optional collapses tax_policy_id to null).
    if (taxable) {
      body.taxable = true;
      if (taxPolicyId) body.taxPolicyId = taxPolicyId;
    }

    const parsed = itemUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const errs: Partial<Record<ItemFieldKey, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '') as ItemFieldKey;
        if (key && !errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.api.items[':id'].$patch({ param: { id }, json: parsed.data });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(errBody?.error ?? 'save_failed');
        return;
      }
      router.replace(`/more/items/${id}`);
    } catch {
      setFormError('save_failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!values) {
    return (
      <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
        {formError ? (
          <Text className="mt-12 px-6 text-sm text-oxblood">Couldn't load this item.</Text>
        ) : (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        )}
      </SafeAreaView>
    );
  }

  return (
    <ItemForm
      backLabel="Item"
      onBack={() => router.back()}
      title="Edit item"
      submitLabel="Save changes"
      values={values}
      onChange={set}
      type={type}
      onSelectType={setType}
      taxPolicies={taxPolicies}
      taxable={taxable}
      taxPolicyId={taxPolicyId}
      onToggleTaxable={toggleTaxable}
      onSelectPolicy={setTaxPolicyId}
      fieldErrors={fieldErrors}
      formError={formError}
      submitting={submitting}
      canSubmit={!submitting && values.name.trim().length > 0}
      onSubmit={onSubmit}
    />
  );
}
