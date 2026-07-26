import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Checkbox } from '../../../components/Checkbox';
import { api } from '../../../lib/api';
import { getServerUrl } from '../../../lib/server-url';
import { uploadLogo } from '../../../lib/upload';

// Business identity settings — native mirror of apps/web's /settings/business.
// Address / phone / email (shown on invoices + estimates) via company PATCH,
// each with separate per-document-type "show on" defaults, plus the logo: a
// signed-URL preview with image-picker upload/replace and remove.
type Company = {
  id: string;
  name: string;
  businessAddress: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  replyToEmail: string | null;
  accountingMethod: string;
  timezone: string;
  showAddressOnInvoice: boolean;
  showPhoneOnInvoice: boolean;
  showEmailOnInvoice: boolean;
  showAddressOnEstimate: boolean;
  showPhoneOnEstimate: boolean;
  showEmailOnEstimate: boolean;
};
type Logo = { url: string; contentType: string };
type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; company: Company; logo: Logo | null }
  | { state: 'error' };

const LOGO_ERRORS: Record<string, string> = {
  unsupported_media_type: 'Logo must be a PNG, JPEG, or WebP.',
  file_too_large: 'Logo must be under 2 MB.',
  storage_not_configured: 'Logo storage is not configured on this server.',
};

const absolutize = (url: string) => (url.startsWith('http') ? url : `${getServerUrl()}${url}`);

// The device's own IANA zone, used only as a one-tap suggestion — never applied
// silently, since it would change which period a user's figures land in. Guarded
// because Hermes' Intl surface has varied across Expo SDKs.
function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

export default function BusinessSettings() {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  // Reply-to has its own card + save (separate concern from the invoice "from"
  // block above it), so it carries its own saving/status state.
  const [replyTo, setReplyTo] = useState('');
  const [replySaving, setReplySaving] = useState(false);
  const [replyStatus, setReplyStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  // Accounting method + timezone each get their own card and save. Both quietly
  // change which period figures land in, so neither should ride along with an
  // address edit.
  const [method, setMethod] = useState<'cash' | 'accrual'>('cash');
  const [methodSaving, setMethodSaving] = useState(false);
  const [methodStatus, setMethodStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [timezone, setTimezone] = useState('UTC');
  const deviceTimezone = deviceZone();
  const [tzSaving, setTzSaving] = useState(false);
  const [tzStatus, setTzStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  // Per-field "show on" defaults, split by document type (invoice vs estimate).
  const [showAddrInv, setShowAddrInv] = useState(true);
  const [showPhoneInv, setShowPhoneInv] = useState(true);
  const [showEmailInv, setShowEmailInv] = useState(true);
  const [showAddrEst, setShowAddrEst] = useState(true);
  const [showPhoneEst, setShowPhoneEst] = useState(true);
  const [showEmailEst, setShowEmailEst] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const fetchCompany = useCallback(async (active: () => boolean) => {
    const res = await api.api.companies.$get();
    if (!active()) return;
    if (!res.ok) {
      setLoad({ state: 'error' });
      return;
    }
    const company = (await res.json()).companies[0];
    if (!company) {
      setLoad({ state: 'error' });
      return;
    }
    // Signed logo URL — best-effort; a 404 (no logo) renders the empty state.
    let logo: Logo | null = null;
    const logoRes = await api.api.companies[':id'].logo.$get({ param: { id: company.id } });
    if (active() && logoRes.ok) logo = (await logoRes.json()) as Logo;
    if (!active()) return;
    setLoad({
      state: 'ready',
      company: {
        id: company.id,
        name: company.name,
        businessAddress: company.businessAddress,
        businessPhone: company.businessPhone,
        businessEmail: company.businessEmail,
        replyToEmail: company.replyToEmail,
        accountingMethod: company.accountingMethod,
        timezone: company.timezone,
        showAddressOnInvoice: company.showAddressOnInvoice,
        showPhoneOnInvoice: company.showPhoneOnInvoice,
        showEmailOnInvoice: company.showEmailOnInvoice,
        showAddressOnEstimate: company.showAddressOnEstimate,
        showPhoneOnEstimate: company.showPhoneOnEstimate,
        showEmailOnEstimate: company.showEmailOnEstimate,
      },
      logo,
    });
    setAddress(company.businessAddress ?? '');
    setPhone(company.businessPhone ?? '');
    setEmail(company.businessEmail ?? '');
    setReplyTo(company.replyToEmail ?? '');
    setMethod(company.accountingMethod === 'accrual' ? 'accrual' : 'cash');
    setTimezone(company.timezone ?? 'UTC');
    setShowAddrInv(company.showAddressOnInvoice);
    setShowPhoneInv(company.showPhoneOnInvoice);
    setShowEmailInv(company.showEmailOnInvoice);
    setShowAddrEst(company.showAddressOnEstimate);
    setShowPhoneEst(company.showPhoneOnEstimate);
    setShowEmailEst(company.showEmailOnEstimate);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      fetchCompany(() => alive).catch(() => {
        if (alive) setLoad({ state: 'error' });
      });
      return () => {
        alive = false;
      };
    }, [fetchCompany]),
  );

  const company = load.state === 'ready' ? load.company : null;
  const logo = load.state === 'ready' ? load.logo : null;

  async function onSave() {
    if (!company) return;
    setSaving(true);
    setStatus('idle');
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: company.id },
        json: {
          businessAddress: address.trim(),
          businessPhone: phone.trim(),
          businessEmail: email.trim(),
          showAddressOnInvoice: showAddrInv,
          showPhoneOnInvoice: showPhoneInv,
          showEmailOnInvoice: showEmailInv,
          showAddressOnEstimate: showAddrEst,
          showPhoneOnEstimate: showPhoneEst,
          showEmailOnEstimate: showEmailEst,
        },
      });
      setStatus(res.ok ? 'saved' : 'error');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  async function onSaveReplyTo() {
    if (!company) return;
    setReplySaving(true);
    setReplyStatus('idle');
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: company.id },
        json: { replyToEmail: replyTo.trim() },
      });
      setReplyStatus(res.ok ? 'saved' : 'error');
    } catch {
      setReplyStatus('error');
    } finally {
      setReplySaving(false);
    }
  }

  async function onSaveMethod(next: 'cash' | 'accrual') {
    if (!company) return;
    setMethod(next);
    setMethodSaving(true);
    setMethodStatus('idle');
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: company.id },
        json: { accountingMethod: next },
      });
      setMethodStatus(res.ok ? 'saved' : 'error');
    } catch {
      setMethodStatus('error');
    } finally {
      setMethodSaving(false);
    }
  }

  async function onSaveTimezone(next: string) {
    if (!company) return;
    setTzSaving(true);
    setTzStatus('idle');
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: company.id },
        json: { timezone: next },
      });
      if (res.ok) {
        setTimezone(next);
        setTzStatus('saved');
      } else {
        setTzStatus('error');
      }
    } catch {
      setTzStatus('error');
    } finally {
      setTzSaving(false);
    }
  }

  async function onPickLogo() {
    if (!company) return;
    setLogoError(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setLogoError('Photo access denied.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.9,
      mediaTypes: ['images'],
    });
    if (result.canceled || !result.assets[0]) return;

    setLogoBusy(true);
    try {
      const up = await uploadLogo(company.id, result.assets[0]);
      if (!up.ok) {
        setLogoError(LOGO_ERRORS[up.error] ?? 'Upload failed. Try again.');
        return;
      }
      await fetchCompany(() => true);
    } finally {
      setLogoBusy(false);
    }
  }

  async function onRemoveLogo() {
    if (!company) return;
    setLogoError(null);
    setLogoBusy(true);
    try {
      const res = await api.api.companies[':id'].logo.$delete({ param: { id: company.id } });
      if (!res.ok) {
        setLogoError('Could not remove the logo.');
        return;
      }
      await fetchCompany(() => true);
    } finally {
      setLogoBusy(false);
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
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Business</Text>

        {load.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : load.state === 'error' || !company ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load these settings.</Text>
        ) : (
          <>
            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Address & contact
              </Text>
              <Text className="mt-2 font-serif text-lg text-ink">{company.name}</Text>
              <Text className="mt-3 text-sm text-ink/70">
                These show in the "from" block on the invoices and estimates your contacts see,
                under your business name. The checkboxes set the default for new documents — you can
                still change it on any individual invoice or estimate. Leave a field blank to omit
                it entirely.
              </Text>

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
                Business address
              </Text>
              <TextInput
                value={address}
                onChangeText={(t) => {
                  setAddress(t);
                  setStatus('idle');
                }}
                placeholder={'123 Main St\nSpringfield, IL 62704'}
                multiline
                className="mt-2 min-h-[72px] rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />
              <View className="mt-2 flex-row flex-wrap gap-x-6 gap-y-2">
                <Checkbox
                  label="Show on invoices"
                  value={showAddrInv}
                  onToggle={() => {
                    setShowAddrInv((v) => !v);
                    setStatus('idle');
                  }}
                />
                <Checkbox
                  label="Show on estimates"
                  value={showAddrEst}
                  onToggle={() => {
                    setShowAddrEst((v) => !v);
                    setStatus('idle');
                  }}
                />
              </View>

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
                Phone
              </Text>
              <TextInput
                value={phone}
                onChangeText={(t) => {
                  setPhone(t);
                  setStatus('idle');
                }}
                placeholder="(555) 123-4567"
                keyboardType="phone-pad"
                className="mt-2 rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />
              <View className="mt-2 flex-row flex-wrap gap-x-6 gap-y-2">
                <Checkbox
                  label="Show on invoices"
                  value={showPhoneInv}
                  onToggle={() => {
                    setShowPhoneInv((v) => !v);
                    setStatus('idle');
                  }}
                />
                <Checkbox
                  label="Show on estimates"
                  value={showPhoneEst}
                  onToggle={() => {
                    setShowPhoneEst((v) => !v);
                    setStatus('idle');
                  }}
                />
              </View>

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
                Email
              </Text>
              <TextInput
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  setStatus('idle');
                }}
                placeholder="hello@yourbusiness.com"
                keyboardType="email-address"
                autoCapitalize="none"
                className="mt-2 rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />
              <View className="mt-2 flex-row flex-wrap gap-x-6 gap-y-2">
                <Checkbox
                  label="Show on invoices"
                  value={showEmailInv}
                  onToggle={() => {
                    setShowEmailInv((v) => !v);
                    setStatus('idle');
                  }}
                />
                <Checkbox
                  label="Show on estimates"
                  value={showEmailEst}
                  onToggle={() => {
                    setShowEmailEst((v) => !v);
                    setStatus('idle');
                  }}
                />
              </View>

              <View className="mt-5 flex-row items-center gap-4">
                <Pressable
                  onPress={onSave}
                  disabled={saving}
                  className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-cream">Save</Text>
                </Pressable>
                {status === 'saved' ? (
                  <Text className="text-sm text-ink/60">Saved.</Text>
                ) : status === 'error' ? (
                  <Text className="text-sm text-oxblood">Couldn't save.</Text>
                ) : null}
              </View>
            </View>

            {/* Timezone. Deliberately not a 400-entry picker on a phone: the
                device's own zone is the answer in virtually every case, so we
                show what's stored and offer a one-tap correction. */}
            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Your time zone
              </Text>
              <Text className="mt-2 font-serif text-lg text-ink">{timezone}</Text>
              <Text className="mt-3 text-sm text-ink/70">
                Reports count a day from midnight where you are. Get this wrong and a payment taken
                on the evening of 31 December can land in the wrong tax year.
              </Text>
              {deviceTimezone && deviceTimezone !== timezone ? (
                <View className="mt-5 flex-row items-center gap-4">
                  <Pressable
                    onPress={() => onSaveTimezone(deviceTimezone)}
                    disabled={tzSaving}
                    className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                  >
                    <Text className="text-sm font-medium text-cream">Use {deviceTimezone}</Text>
                  </Pressable>
                  {tzStatus === 'error' ? (
                    <Text className="text-sm text-oxblood">Couldn't save.</Text>
                  ) : null}
                </View>
              ) : (
                <Text className="mt-4 text-sm text-ink/60">
                  {tzStatus === 'saved'
                    ? 'Saved.'
                    : tzStatus === 'error'
                      ? "Couldn't save."
                      : 'Matches this device.'}
                </Text>
              )}
            </View>

            {/* Accounting method, in plain words — the user never sees
                "cash"/"accrual" as a label, only what it means. Saves on tap
                since it's a two-option choice. */}
            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                When you count income
              </Text>
              <Text className="mt-2 font-serif text-lg text-ink">{company.name}</Text>
              <Text className="mt-3 text-sm text-ink/70">
                This decides which year money lands in on your Schedule C worksheet. Most people
                count income when they get paid — the usual choice for freelancers and trades. Only
                change it if whoever files your taxes told you to.
              </Text>
              <View className="mt-5 gap-3">
                {(
                  [
                    ['cash', 'When you get paid', 'Most common.'],
                    ['accrual', 'When you send the invoice', 'Even if the money arrives later.'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <Pressable
                    key={value}
                    onPress={() => onSaveMethod(value)}
                    disabled={methodSaving}
                    className={`rounded-sm border px-4 py-3 ${
                      method === value ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15'
                    }`}
                  >
                    <Text className="text-ink">{label}</Text>
                    <Text className="mt-0.5 text-xs text-ink/60">{hint}</Text>
                  </Pressable>
                ))}
              </View>
              {methodStatus === 'saved' ? (
                <Text className="mt-4 text-sm text-ink/60">Saved.</Text>
              ) : methodStatus === 'error' ? (
                <Text className="mt-4 text-sm text-oxblood">Couldn't save.</Text>
              ) : null}
            </View>

            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Reply-to address
              </Text>
              <Text className="mt-2 font-serif text-lg text-ink">{company.name}</Text>
              <Text className="mt-3 text-sm text-ink/70">
                Invoices and estimates go out under your business name, but from Thalermark's
                sending address. Set a reply-to so when a contact hits "reply," it reaches you.
                Leave it blank to send with no reply-to.
              </Text>

              <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
                Reply-to email
              </Text>
              <TextInput
                value={replyTo}
                onChangeText={(t) => {
                  setReplyTo(t);
                  setReplyStatus('idle');
                }}
                placeholder="you@yourbusiness.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                className="mt-2 rounded-sm border border-ink/20 bg-cream px-3 py-2 text-ink"
              />

              <View className="mt-5 flex-row items-center gap-4">
                <Pressable
                  onPress={onSaveReplyTo}
                  disabled={replySaving}
                  className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-cream">Save</Text>
                </Pressable>
                {replyStatus === 'saved' ? (
                  <Text className="text-sm text-ink/60">Saved.</Text>
                ) : replyStatus === 'error' ? (
                  <Text className="text-sm text-oxblood">Couldn't save.</Text>
                ) : null}
              </View>
            </View>

            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Logo</Text>
              <Text className="mt-2 text-sm text-ink/70">
                Shown on the invoices and estimates your contacts see. PNG, JPEG, or WebP, up to 2
                MB.
              </Text>

              {logo ? (
                <Image
                  source={{ uri: absolutize(logo.url) }}
                  resizeMode="contain"
                  className="mt-4 h-24 w-48 self-start rounded-sm border border-ink/10 bg-cream"
                />
              ) : (
                <Text className="mt-4 text-sm text-ink/50">No logo yet.</Text>
              )}

              <View className="mt-4 flex-row gap-2">
                <Pressable
                  onPress={onPickLogo}
                  disabled={logoBusy}
                  className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-cream">
                    {logoBusy ? '…' : logo ? 'Replace' : 'Upload'}
                  </Text>
                </Pressable>
                {logo ? (
                  <Pressable
                    onPress={onRemoveLogo}
                    disabled={logoBusy}
                    className="rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                  >
                    <Text className="text-sm font-medium text-ink">Remove</Text>
                  </Pressable>
                ) : null}
              </View>
              {logoError ? <Text className="mt-3 text-sm text-oxblood">{logoError}</Text> : null}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
