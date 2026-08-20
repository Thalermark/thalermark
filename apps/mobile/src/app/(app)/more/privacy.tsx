import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Privacy → Usage data — native mirror of apps/web's /settings/privacy. The
// single per-account telemetry consent toggle (TELEMETRY.md). Saving stamps
// telemetry_decided_at server-side, so it also silences the first-run prompt
// on Home. Settings-section screen, so it inherits the same settings:manage
// gate the More hub applies before linking here.
type Telemetry = { enabled: boolean; decided: boolean; disabled: boolean };
type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; telemetry: Telemetry }
  | { state: 'error' };

export default function PrivacySettings() {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      api.api.account.telemetry
        .$get()
        .then(async (res) => {
          if (!alive) return;
          if (!res.ok) {
            setLoad({ state: 'error' });
            return;
          }
          const telemetry = (await res.json()) as Telemetry;
          setLoad({ state: 'ready', telemetry });
          setEnabled(telemetry.enabled);
        })
        .catch(() => {
          if (alive) setLoad({ state: 'error' });
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  async function onSave() {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const res = await api.api.account.telemetry.$patch({ json: { enabled } });
      if (res.ok) {
        const telemetry = (await res.json()) as Telemetry;
        setEnabled(telemetry.enabled);
        setSaveStatus('saved');
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  }

  const disabled = load.state === 'ready' && load.telemetry.disabled;

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/more')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← More
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Privacy</Text>

        {load.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : load.state === 'error' ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load these settings.</Text>
        ) : (
          <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Usage data
            </Text>
            <Text className="mt-2 text-sm text-ink-muted">
              Help us build a better product. With your consent we collect anonymous usage data —
              which features get used and where errors happen. We never collect personal or
              financial information: no names, amounts, contacts, or document contents.
            </Text>

            {disabled ? (
              <Text className="mt-5 text-sm text-ink-muted">
                Usage data is turned off for this installation by the server's TELEMETRY_DISABLED
                setting. Nothing is collected, and there's nothing to change here.
              </Text>
            ) : (
              <>
                <Pressable
                  onPress={() => {
                    setEnabled((v) => !v);
                    setSaveStatus('idle');
                  }}
                  className="mt-5 flex-row items-center gap-3"
                >
                  <Ionicons
                    name={enabled ? 'checkbox' : 'square-outline'}
                    size={22}
                    className={enabled ? 'text-gold-deep' : 'text-ink-subtle'}
                  />
                  <Text className="text-sm text-ink">Share anonymous usage data</Text>
                </Pressable>

                <View className="mt-5 flex-row items-center gap-4">
                  <Pressable
                    onPress={onSave}
                    disabled={saving}
                    className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                  >
                    <Text className="text-sm font-medium text-cream">Save</Text>
                  </Pressable>
                  {saveStatus === 'saved' ? (
                    <Text className="text-sm text-ink-subtle">Saved.</Text>
                  ) : saveStatus === 'error' ? (
                    <Text className="text-sm text-oxblood">Couldn't save.</Text>
                  ) : null}
                </View>
              </>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
