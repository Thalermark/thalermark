import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';

// Payment settings — native mirror of apps/web's /settings/payments. Two parts:
// Stripe Connect onboarding (open the Account Link in the system browser; the
// webhook keeps the flags fresh, so the status refetch on focus reflects
// reality on return) and the offline payment instructions shown on public
// invoices (cash / check / Venmo / Zelle), saved via company PATCH.
type Company = {
  id: string;
  name: string;
  paymentCashEnabled: boolean;
  paymentCheckEnabled: boolean;
  paymentCheckPayableTo: string | null;
  paymentCheckAddress: string | null;
  paymentVenmoHandle: string | null;
  paymentZelleContact: string | null;
};
type Status = {
  stripeConfigured: boolean;
  stripeConnectAccountId: string | null;
  stripeConnectChargesEnabled: boolean;
  stripeConnectDetailsSubmitted: boolean;
};
type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; company: Company; status: Status }
  | { state: 'error' };

export default function PaymentsSettings() {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });

  // Offline-methods form state.
  const [cash, setCash] = useState(false);
  const [check, setCheck] = useState(false);
  const [checkPayableTo, setCheckPayableTo] = useState('');
  const [checkAddress, setCheckAddress] = useState('');
  const [venmo, setVenmo] = useState('');
  const [zelle, setZelle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const [onboarding, setOnboarding] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);

  const fetchAll = useCallback(async (active: () => boolean) => {
    const compRes = await api.api.companies.$get();
    if (!active()) return;
    if (!compRes.ok) {
      setLoad({ state: 'error' });
      return;
    }
    const company = await pickActiveCompany((await compRes.json()).companies);
    if (!company) {
      setLoad({ state: 'error' });
      return;
    }
    const statusRes = await api.api.companies[':id']['stripe-connect'].status.$get({
      param: { id: company.id },
    });
    if (!active()) return;
    if (!statusRes.ok) {
      setLoad({ state: 'error' });
      return;
    }
    const status = (await statusRes.json()) as Status;
    if (!active()) return;
    setLoad({
      state: 'ready',
      company: {
        id: company.id,
        name: company.name,
        paymentCashEnabled: company.paymentCashEnabled,
        paymentCheckEnabled: company.paymentCheckEnabled,
        paymentCheckPayableTo: company.paymentCheckPayableTo,
        paymentCheckAddress: company.paymentCheckAddress,
        paymentVenmoHandle: company.paymentVenmoHandle,
        paymentZelleContact: company.paymentZelleContact,
      },
      status,
    });
    setCash(company.paymentCashEnabled);
    setCheck(company.paymentCheckEnabled);
    setCheckPayableTo(company.paymentCheckPayableTo ?? '');
    setCheckAddress(company.paymentCheckAddress ?? '');
    setVenmo(company.paymentVenmoHandle ?? '');
    setZelle(company.paymentZelleContact ?? '');
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      fetchAll(() => alive).catch(() => {
        if (alive) setLoad({ state: 'error' });
      });
      return () => {
        alive = false;
      };
    }, [fetchAll]),
  );

  const company = load.state === 'ready' ? load.company : null;
  const status = load.state === 'ready' ? load.status : null;
  const stage = !status?.stripeConnectAccountId
    ? 'notStarted'
    : status.stripeConnectChargesEnabled
      ? 'enabled'
      : 'submitted';
  const buttonLabel =
    stage === 'notStarted'
      ? 'Connect with Stripe'
      : stage === 'submitted'
        ? 'Continue onboarding'
        : 'Update payout details';

  async function onOnboard() {
    if (!company) return;
    setOnboarding(true);
    setOnboardError(null);
    try {
      const res = await api.api.companies[':id']['stripe-connect'].onboard.$post({
        param: { id: company.id },
      });
      if (!res.ok) {
        setOnboardError("Couldn't start onboarding. Try again.");
        return;
      }
      const { url } = await res.json();
      // Opens Stripe's hosted onboarding in the system browser. On return the
      // focus refetch picks up the webhook-updated status.
      await Linking.openURL(url);
    } catch {
      setOnboardError("Couldn't start onboarding. Try again.");
    } finally {
      setOnboarding(false);
    }
  }

  async function onSaveMethods() {
    if (!company) return;
    setSaving(true);
    setSaveStatus('idle');
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: company.id },
        json: {
          paymentCashEnabled: cash,
          paymentCheckEnabled: check,
          paymentCheckPayableTo: checkPayableTo.trim(),
          paymentCheckAddress: checkAddress.trim(),
          paymentVenmoHandle: venmo.trim(),
          paymentZelleContact: zelle.trim(),
        },
      });
      setSaveStatus(res.ok ? 'saved' : 'error');
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        <Text
          onPress={() => router.push('/more')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← More
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Payments</Text>

        {load.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : load.state === 'error' || !company || !status ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load these settings.</Text>
        ) : (
          <>
            {/* Stripe Connect */}
            {!status.stripeConfigured ? (
              <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
                <Text className="font-serif text-lg text-ink">Stripe isn't configured.</Text>
                <Text className="mt-2 text-sm text-ink/70">
                  This installation hasn't wired Stripe API keys, so card payment collection is
                  unavailable. The other ways to get paid below still work.
                </Text>
              </View>
            ) : (
              <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Stripe Connect
                </Text>
                <Text className="mt-2 font-serif text-lg text-ink">{company.name}</Text>
                <Text className="mt-3 text-sm text-ink/70">
                  {stage === 'notStarted'
                    ? 'Connect a Stripe account so contacts can pay your invoices online. Stripe runs the onboarding — bank, ID, the lot.'
                    : stage === 'submitted'
                      ? "Your details are with Stripe. They're verifying everything and will switch payments on automatically when they're done."
                      : 'Payments are live. Contacts can pay invoices using the pay link on the public invoice page.'}
                </Text>
                <View className="mt-4 flex-row justify-between">
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    Details submitted
                  </Text>
                  <Text className="text-sm text-ink/80">
                    {status.stripeConnectDetailsSubmitted ? 'yes' : 'no'}
                  </Text>
                </View>
                <View className="mt-1 flex-row justify-between">
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                    Charges enabled
                  </Text>
                  <Text className="text-sm text-ink/80">
                    {status.stripeConnectChargesEnabled ? 'yes' : 'no'}
                  </Text>
                </View>
                <Pressable
                  onPress={onOnboard}
                  disabled={onboarding}
                  className="mt-5 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-center text-sm font-medium text-cream">
                    {onboarding ? 'Opening Stripe…' : buttonLabel}
                  </Text>
                </Pressable>
                {onboardError ? (
                  <Text className="mt-3 text-sm text-oxblood">{onboardError}</Text>
                ) : null}
              </View>
            )}

            {/* Offline payment methods */}
            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Other ways to get paid
              </Text>
              <Text className="mt-2 text-sm text-ink/70">
                Shown as instructions on your public invoices. You mark these paid yourself once the
                money lands.
              </Text>

              <Checkbox
                label="Accept cash (in person)"
                value={cash}
                onToggle={() => {
                  setCash((v) => !v);
                  setSaveStatus('idle');
                }}
              />

              <Checkbox
                label="Accept check"
                value={check}
                onToggle={() => {
                  setCheck((v) => !v);
                  setSaveStatus('idle');
                }}
              />
              {check ? (
                <View className="mt-3 gap-3">
                  <TextInput
                    value={checkPayableTo}
                    onChangeText={(t) => {
                      setCheckPayableTo(t);
                      setSaveStatus('idle');
                    }}
                    placeholder={`Make payable to (defaults to ${company.name})`}
                    className="rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
                  />
                  <TextInput
                    value={checkAddress}
                    onChangeText={(t) => {
                      setCheckAddress(t);
                      setSaveStatus('idle');
                    }}
                    placeholder="Mailing address (optional)"
                    multiline
                    className="min-h-[60px] rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
                  />
                </View>
              ) : null}

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
                Venmo handle
              </Text>
              <TextInput
                value={venmo}
                onChangeText={(t) => {
                  setVenmo(t);
                  setSaveStatus('idle');
                }}
                placeholder="@your-handle"
                autoCapitalize="none"
                className="mt-2 rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
                Zelle email or phone
              </Text>
              <TextInput
                value={zelle}
                onChangeText={(t) => {
                  setZelle(t);
                  setSaveStatus('idle');
                }}
                placeholder="you@example.com or 555-0100"
                autoCapitalize="none"
                className="mt-2 rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />

              <View className="mt-5 flex-row items-center gap-4">
                <Pressable
                  onPress={onSaveMethods}
                  disabled={saving}
                  className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-cream">Save payment methods</Text>
                </Pressable>
                {saveStatus === 'saved' ? (
                  <Text className="text-sm text-ink/60">Saved.</Text>
                ) : saveStatus === 'error' ? (
                  <Text className="text-sm text-oxblood">Couldn't save.</Text>
                ) : null}
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Checkbox({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable onPress={onToggle} className="mt-4 flex-row items-center gap-3">
      <Ionicons
        name={value ? 'checkbox' : 'square-outline'}
        size={22}
        color={value ? '#9a7b4f' : '#0f162680'}
      />
      <Text className="text-sm text-ink">{label}</Text>
    </Pressable>
  );
}
