import { taxPolicyCreateSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { TaxPolicyForm, type TaxPolicyFormValues } from '../../../../components/TaxPolicyForm';
import { pickActiveCompany } from '../../../../lib/active-company';
import { api } from '../../../../lib/api';
import { apiErrorMessage } from '../../../../lib/api-errors';

// Mirror of apps/web's /settings/tax-policies/new. Resolves the active company
// for the required companyId. A blank rate is omitted so the API defaults
// rate_pct to '0'.
const EMPTY: TaxPolicyFormValues = { name: '', ratePct: '', isDefault: false };

export default function NewTaxPolicy() {
  const router = useRouter();
  const [values, setValues] = useState<TaxPolicyFormValues>(EMPTY);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'name' | 'ratePct', string>>>({});
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
            setCompanyId((await pickActiveCompany(companies))?.id ?? null);
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

  const noCompany = bootstrapped && companyId === null;
  const canSubmit = !submitting && !noCompany && values.name.trim().length > 0;

  async function onSubmit() {
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    setFormError(null);
    setFieldErrors({});

    const body: Record<string, unknown> = { companyId, name: values.name.trim() };
    if (values.ratePct.trim() !== '') body.ratePct = values.ratePct.trim();
    if (values.isDefault) body.isDefault = true;

    const parsed = taxPolicyCreateSchema.safeParse(body);
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
      const res = await api.api['tax-policies'].$post({ json: parsed.data });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(apiErrorMessage(errBody?.error, 'That could not be created. Try again.'));
        return;
      }
      const created = await res.json();
      router.replace(`/more/tax-policies/${created.id}`);
    } catch {
      setFormError('That could not be created. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <TaxPolicyForm
      backLabel="Tax policies"
      onBack={() => router.back()}
      title="New tax policy"
      submitLabel="Create policy"
      values={values}
      onChangeField={(key, val) => setValues((v) => ({ ...v, [key]: val }))}
      onToggleDefault={() => setValues((v) => ({ ...v, isDefault: !v.isDefault }))}
      fieldErrors={fieldErrors}
      formError={noCompany ? 'No company in this workspace.' : formError}
      submitting={submitting}
      canSubmit={canSubmit}
      onSubmit={onSubmit}
    />
  );
}
