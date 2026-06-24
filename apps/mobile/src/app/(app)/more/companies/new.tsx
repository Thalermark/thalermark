import { BUSINESS_TYPES } from '@thalermark/validation';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';
import { setActiveCompanyId } from '../../../../lib/secure-store';

// Mobile mirror of web's /companies/new — add a second company to the workspace.
// Name + business type only (the sole-prop COA is seeded server-side regardless
// of type, per the locked ledger decision); the rest is filled later in Business
// settings. On success we switch the active company to the new one and bounce
// home, matching the web flow. Gated by settings:manage — the API enforces it,
// so this guard just keeps a member off a form whose submit would only 403.
type BusinessType = (typeof BUSINESS_TYPES)[number];

// Friendly labels — business structure, not accounting jargon. Same wording as
// web's create + welcome forms.
const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  sole_prop: 'Just me (sole proprietor)',
  llc_single_member: 'LLC (single-member)',
  partnership: 'Partnership',
  s_corp: 'S-Corporation',
  c_corp: 'C-Corporation',
};

export default function NewCompany() {
  const router = useRouter();
  const canManage = useMay('settings:manage');
  const [name, setName] = useState('');
  const [businessType, setBusinessType] = useState<BusinessType>('sole_prop');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!canManage) return <Redirect href="/more/companies" />;

  async function onSubmit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.api.companies.$post({ json: { name: trimmed, businessType } });
      if (!res.ok) {
        setSubmitting(false);
        setError('Could not create the company. Please try again.');
        return;
      }
      const created = await res.json();
      // Switch to the new company so the user lands inside it.
      await setActiveCompanyId(created.id);
      router.replace('/');
    } catch {
      setSubmitting(false);
      setError('Could not create the company. Please try again.');
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more/companies')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
            ← Companies
          </Text>
        </Pressable>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Add a company</Text>
        <Text className="mt-3 text-sm text-ink/60">
          Run a second business out of this workspace — its books, invoices, and contacts stay
          separate. You can switch between companies anytime.
        </Text>

        <View className="mt-8">
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
            Business name
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Northside Handyman"
            placeholderTextColor="#0f162659"
            className="mt-2 border-b border-ink/30 py-2 text-ink"
          />
        </View>

        <View className="mt-8">
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
            How's it set up?
          </Text>
          <View className="mt-3 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
            {BUSINESS_TYPES.map((bt, i) => {
              const selected = bt === businessType;
              return (
                <Pressable
                  key={bt}
                  onPress={() => setBusinessType(bt)}
                  className={`flex-row items-center justify-between px-5 py-4 active:bg-cream ${
                    i > 0 ? 'border-t border-ink/10' : ''
                  }`}
                >
                  <Text className="text-sm text-ink">{BUSINESS_TYPE_LABELS[bt]}</Text>
                  {selected ? <Text className="text-gold-deep">✓</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        {error ? (
          <Text className="mt-6 font-mono text-xs uppercase tracking-widest text-oxblood">
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={submitting || name.trim().length === 0}
          className="mt-8 rounded-sm bg-ink px-3 py-3 active:bg-gold-deep disabled:opacity-50"
        >
          {submitting ? (
            <ActivityIndicator color="#f4ede0" />
          ) : (
            <Text className="text-center text-sm font-medium text-cream">Create company</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
