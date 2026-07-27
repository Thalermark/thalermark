import { type LineItemType, itemCreateSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { type ItemFieldKey, ItemForm, type ItemFormValues } from '../../../../components/ItemForm';
import { pickActiveCompany } from '../../../../lib/active-company';
import { api } from '../../../../lib/api';
import { type TaxPolicyLite, resolvePolicyId } from '../../../../lib/line-tax';

// Mirror of apps/web's /settings/items/new. The API doesn't auto-pick a company,
// so this resolves the active one for the required companyId. Empty optionals are
// omitted so undefined (not '') reaches the schema.
const OPTIONAL_KEYS: Exclude<ItemFieldKey, 'name'>[] = [
  'description',
  'unitPrice',
  'unitLabel',
  'defaultQuantity',
];

const EMPTY: ItemFormValues = {
  name: '',
  description: '',
  unitPrice: '',
  unitLabel: '',
  defaultQuantity: '',
};

export default function NewItem() {
  const router = useRouter();
  const [values, setValues] = useState<ItemFormValues>(EMPTY);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [taxPolicies, setTaxPolicies] = useState<TaxPolicyLite[]>([]);
  const [type, setType] = useState<LineItemType>('service');
  const [taxable, setTaxable] = useState(false);
  const [taxPolicyId, setTaxPolicyId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ItemFieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (bootstrapped) return;
      let active = true;
      api.api.companies
        .$get()
        .then(async (res) => {
          if (!active) return;
          if (res.ok) {
            const { companies } = await res.json();
            const cId = (await pickActiveCompany(companies))?.id ?? null;
            setCompanyId(cId);
            if (cId) {
              const polRes = await api.api['tax-policies'].$get({ query: { companyId: cId } });
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

  const set = (key: ItemFieldKey, val: string) => setValues((v) => ({ ...v, [key]: val }));
  function toggleTaxable() {
    const turningOn = !taxable;
    setTaxable(turningOn);
    if (turningOn && !taxPolicyId) setTaxPolicyId(resolvePolicyId(taxPolicies, ''));
  }
  const noCompany = bootstrapped && companyId === null;
  const canSubmit = !submitting && !noCompany && values.name.trim().length > 0;

  async function onSubmit() {
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    setFormError(null);
    setFieldErrors({});

    const body: Record<string, unknown> = { companyId, name: values.name.trim(), type };
    for (const k of OPTIONAL_KEYS) {
      const trimmed = values[k].trim();
      if (trimmed !== '') body[k] = trimmed;
    }
    if (taxable) {
      body.taxable = true;
      if (taxPolicyId) body.taxPolicyId = taxPolicyId;
    }

    const parsed = itemCreateSchema.safeParse(body);
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
      const res = await api.api.items.$post({ json: parsed.data });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(errBody?.error ?? 'create_failed');
        return;
      }
      const created = await res.json();
      router.replace(`/more/items/${created.id}`);
    } catch {
      setFormError('create_failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ItemForm
      backLabel="Items"
      onBack={() => router.back()}
      title="New item"
      submitLabel="Create item"
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
      formError={noCompany ? 'No company in this workspace.' : formError}
      submitting={submitting}
      canSubmit={canSubmit}
      onSubmit={onSubmit}
    />
  );
}
