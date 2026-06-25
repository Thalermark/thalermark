import { BUSINESS_TYPES } from '@thalermark/validation';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WelcomeHeader } from '../../components/WelcomeHeader';
import { pickActiveCompany } from '../../lib/active-company';
import { api } from '../../lib/api';

// Step 1 — Your business. Name + business type are required (they replace the
// signup fallback that named the company after the person, and setting the type
// is what satisfies the (app) onboarding gate); address + phone are optional and
// only show on invoices. Mirror of web's welcome/+page. Operates on the active
// company — the fresh signup's untyped seed in the common case.
type BusinessType = (typeof BUSINESS_TYPES)[number];

const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  sole_prop: 'Just me (sole proprietor)',
  llc_single_member: 'LLC (single-member)',
  partnership: 'Partnership',
  s_corp: 'S-Corporation',
  c_corp: 'C-Corporation',
};

export default function WelcomeBusiness() {
  const router = useRouter();
  const [load, setLoad] = useState<'loading' | 'ready' | 'gone' | 'error'>('loading');
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [businessType, setBusinessType] = useState<BusinessType>('sole_prop');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bootstrapped = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (bootstrapped.current) return;
      bootstrapped.current = true;
      let active = true;
      (async () => {
        const res = await api.api.companies.$get();
        if (!active) return;
        if (!res.ok) {
          setLoad('error');
          return;
        }
        const { companies } = await res.json();
        const picked = await pickActiveCompany(companies);
        const row = companies.find((c) => c.id === picked?.id);
        if (!row) {
          setLoad('gone');
          return;
        }
        setCompanyId(row.id);
        setName(row.name ?? '');
        setBusinessType((row.businessType as BusinessType | null) ?? 'sole_prop');
        setAddress(row.businessAddress ?? '');
        setPhone(row.businessPhone ?? '');
        setLoad('ready');
      })().catch(() => {
        if (active) setLoad('error');
      });
      return () => {
        active = false;
      };
    }, []),
  );

  async function onSubmit() {
    if (!companyId) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: companyId },
        json: {
          name: trimmed,
          businessType,
          businessAddress: address.trim(),
          businessPhone: phone.trim(),
        },
      });
      if (!res.ok) {
        setSubmitting(false);
        setError('Could not save. Please try again.');
        return;
      }
      router.replace('/welcome/paid');
    } catch {
      setSubmitting(false);
      setError('Could not save. Please try again.');
    }
  }

  // No company to set up (invited-only / signup never provisioned one) — the app
  // gate owns that empty state, so bounce back out of the wizard.
  if (load === 'gone') return <Redirect href="/" />;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        <WelcomeHeader step={1} />

        {load === 'loading' ? (
          <View className="mt-16 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : load === 'error' ? (
          <Text className="mt-10 text-sm text-oxblood">Couldn't load your business.</Text>
        ) : (
          <>
            <Text className="mt-8 font-mono text-xs uppercase tracking-widest text-gold-deep">
              Welcome
            </Text>
            <Text className="mt-3 font-serif text-3xl font-light text-ink">
              Let's set up your business.
            </Text>
            <Text className="mt-3 text-sm text-ink/70">
              Just a couple of quick things, then you can send your first invoice. You can change
              any of this later in Settings.
            </Text>

            <View className="mt-8">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                Business name
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="e.g. Sunrise Landscaping"
                placeholderTextColor="#0f162659"
                className="mt-2 border-b border-ink/30 py-2 text-ink"
              />
              <Text className="mt-1 font-mono text-xs text-ink/50">
                This is what your contacts see.
              </Text>
            </View>

            <View className="mt-8">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                How's your business set up?
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

            <View className="mt-8 border-t border-ink/10 pt-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/40">
                Optional — shown on your invoices
              </Text>
              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/60">
                Business address
              </Text>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder={'123 Main St\nSpringfield, IL 62704'}
                placeholderTextColor="#0f162659"
                multiline
                className="mt-2 min-h-[72px] rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />
              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/60">
                Phone
              </Text>
              <TextInput
                value={phone}
                onChangeText={setPhone}
                placeholder="(555) 123-4567"
                placeholderTextColor="#0f162659"
                keyboardType="phone-pad"
                className="mt-2 rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />
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
                <Text className="text-center text-sm font-medium text-cream">Continue</Text>
              )}
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
