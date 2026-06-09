import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';

// Reply-to address settings — native mirror of apps/web's /settings/email.
// Loads the account's (single, MVP) company and PATCHes replyToEmail. The
// server coerces '' → null, which drops the Reply-To header from outbound mail.
type Company = { id: string; name: string; replyToEmail: string | null };
type LoadState = { state: 'loading' } | { state: 'ready'; company: Company } | { state: 'error' };

export default function EmailSettings() {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [replyTo, setReplyTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.companies
        .$get()
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setLoad({ state: 'error' });
            return;
          }
          const company = (await res.json()).companies[0];
          if (!company) {
            setLoad({ state: 'error' });
            return;
          }
          setLoad({
            state: 'ready',
            company: { id: company.id, name: company.name, replyToEmail: company.replyToEmail },
          });
          setReplyTo(company.replyToEmail ?? '');
        })
        .catch(() => {
          if (active) setLoad({ state: 'error' });
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const company = load.state === 'ready' ? load.company : null;

  async function onSave() {
    if (!company) return;
    setSaving(true);
    setStatus('idle');
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: company.id },
        json: { replyToEmail: replyTo.trim() },
      });
      setStatus(res.ok ? 'saved' : 'error');
    } catch {
      setStatus('error');
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
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Email</Text>

        {load.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : load.state === 'error' || !company ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load these settings.</Text>
        ) : (
          <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
              Reply-to address
            </Text>
            <Text className="mt-2 font-serif text-lg text-ink">{company.name}</Text>
            <Text className="mt-3 text-sm text-ink/70">
              Invoices and estimates go out under your business name, but from Thalermark's sending
              address. Set a reply-to so when a customer hits "reply," it reaches you. Leave it
              blank to send with no reply-to.
            </Text>

            <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
              Reply-to email
            </Text>
            <TextInput
              value={replyTo}
              onChangeText={(t) => {
                setReplyTo(t);
                setStatus('idle');
              }}
              placeholder="you@yourbusiness.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
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
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
