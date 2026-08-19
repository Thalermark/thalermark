import * as ImagePicker from 'expo-image-picker';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WelcomeHeader } from '../../components/WelcomeHeader';
import { pickActiveCompany } from '../../lib/active-company';
import { api } from '../../lib/api';
import { getServerUrl } from '../../lib/server-url';
import { uploadLogo } from '../../lib/upload';
import { markWelcomeFinished } from '../../lib/welcome-progress';

// Step 3 — Make it yours. Optional logo, then the handoff into the first invoice.
// Mirror of web's welcome/brand. The logo path reuses the Business-settings
// pattern (image picker → multipart upload → signed-URL preview).
type Logo = { url: string; contentType: string };

const LOGO_ERRORS: Record<string, string> = {
  unsupported_media_type: 'Logo must be a PNG, JPEG, or WebP.',
  file_too_large: 'Logo must be under 2 MB.',
  storage_not_configured: 'Logo storage is not configured on this server.',
};

const absolutize = (url: string) => (url.startsWith('http') ? url : `${getServerUrl()}${url}`);

export default function WelcomeBrand() {
  const router = useRouter();
  const [load, setLoad] = useState<'loading' | 'ready' | 'gone' | 'error'>('loading');
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [logo, setLogo] = useState<Logo | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const bootstrapped = useRef(false);

  const fetchLogo = useCallback(async (id: string, active: () => boolean) => {
    const res = await api.api.companies[':id'].logo.$get({ param: { id } });
    if (!active()) return;
    setLogo(res.ok ? ((await res.json()) as Logo) : null);
  }, []);

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
        if (!picked) {
          setLoad('gone');
          return;
        }
        setCompanyId(picked.id);
        await fetchLogo(picked.id, () => active);
        if (active) setLoad('ready');
      })().catch(() => {
        if (active) setLoad('error');
      });
      return () => {
        active = false;
      };
    }, [fetchLogo]),
  );

  async function onPickLogo() {
    if (!companyId) return;
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
      const up = await uploadLogo(companyId, result.assets[0]);
      if (!up.ok) {
        setLogoError(LOGO_ERRORS[up.error] ?? 'Upload failed. Try again.');
        return;
      }
      await fetchLogo(companyId, () => true);
    } finally {
      setLogoBusy(false);
    }
  }

  if (load === 'gone') return <Redirect href="/" />;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <WelcomeHeader step={3} />

        {load === 'loading' ? (
          <View className="mt-16 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : load === 'error' ? (
          <Text className="mt-10 text-sm text-oxblood">Couldn't load your business.</Text>
        ) : (
          <>
            <Text className="mt-8 font-mono text-xs uppercase tracking-widest text-gold-deep">
              Almost there
            </Text>
            <Text className="mt-3 font-serif text-3xl font-light text-ink">Make it yours.</Text>
            <Text className="mt-3 text-sm text-ink-muted">
              Add a logo and it'll appear on every invoice and estimate your contacts see. Optional
              — you can always add one later from Settings.
            </Text>

            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              {logo ? (
                <Image
                  source={{ uri: absolutize(logo.url) }}
                  resizeMode="contain"
                  className="h-24 w-48 self-start rounded-sm border border-ink/10 bg-cream"
                />
              ) : (
                <Text className="text-sm text-ink-subtle">No logo yet.</Text>
              )}
              <Pressable
                onPress={onPickLogo}
                disabled={logoBusy}
                className="mt-4 self-start rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
              >
                <Text className="text-sm font-medium text-cream">
                  {logoBusy ? 'Uploading…' : logo ? 'Replace' : 'Upload a logo'}
                </Text>
              </Pressable>
              {logoError ? <Text className="mt-3 text-sm text-oxblood">{logoError}</Text> : null}
            </View>

            <View className="mt-10 gap-4">
              <Pressable
                onPress={() => {
                  markWelcomeFinished();
                  router.replace('/invoices/new');
                }}
                className="rounded-sm bg-ink px-6 py-3 active:bg-gold-deep"
              >
                <Text className="text-center text-sm font-medium text-cream">
                  Send your first invoice →
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  markWelcomeFinished();
                  router.replace('/');
                }}
                className="py-2"
              >
                <Text className="text-center font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Go to dashboard
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
