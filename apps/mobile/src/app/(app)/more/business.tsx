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
import { api } from '../../../lib/api';
import { uploadLogo } from '../../../lib/upload';

// Business identity settings — native mirror of apps/web's /settings/business.
// Address + phone (shown on invoices/estimates) via company PATCH, plus the
// logo: a signed-URL preview with image-picker upload/replace and remove.
type Company = {
  id: string;
  name: string;
  businessAddress: string | null;
  businessPhone: string | null;
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

const apiOrigin = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const absolutize = (url: string) => (url.startsWith('http') ? url : `${apiOrigin}${url}`);

export default function BusinessSettings() {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
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
      },
      logo,
    });
    setAddress(company.businessAddress ?? '');
    setPhone(company.businessPhone ?? '');
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
        json: { businessAddress: address.trim(), businessPhone: phone.trim() },
      });
      setStatus(res.ok ? 'saved' : 'error');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
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
                These appear on the invoices and estimates your customers see, under your business
                name. Leave them blank to show just the name.
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

            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Logo</Text>
              <Text className="mt-2 text-sm text-ink/70">
                Shown on the invoices and estimates your customers see. PNG, JPEG, or WebP, up to 2
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
