import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';

// Email settings — native mirror of apps/web's /settings/email. Two sections:
// the reply-to address (PATCHes the company), and the customizable email
// templates (invoice/estimate/statement). The editor lives at
// /more/email/[type]; here a "View" expands the rendered email TEXT inline (RN
// has no webview, so we show the text rendering the preview endpoint returns —
// same content the web shows as HTML).
type Company = { id: string; name: string; replyToEmail: string | null };
type Template = { type: string; subject: string; body: string; isCustomized: boolean };
type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; company: Company; templates: Template[] }
  | { state: 'error' };

const TEMPLATE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  statement: 'Customer statement',
};

export default function EmailSettings() {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [replyTo, setReplyTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  // Inline preview ("View"), one template at a time.
  const [previewType, setPreviewType] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'error'>('idle');

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          const cRes = await api.api.companies.$get();
          if (!active) return;
          if (!cRes.ok) {
            setLoad({ state: 'error' });
            return;
          }
          const company = (await cRes.json()).companies[0];
          if (!company) {
            setLoad({ state: 'error' });
            return;
          }
          const tRes = await api.api.companies[':id']['email-templates'].$get({
            param: { id: company.id },
          });
          const templates = tRes.ok ? (await tRes.json()).templates : [];
          if (!active) return;
          setLoad({
            state: 'ready',
            company: { id: company.id, name: company.name, replyToEmail: company.replyToEmail },
            templates,
          });
          setReplyTo(company.replyToEmail ?? '');
        } catch {
          if (active) setLoad({ state: 'error' });
        }
      })();
      return () => {
        active = false;
      };
    }, []),
  );

  const company = load.state === 'ready' ? load.company : null;
  const templates = load.state === 'ready' ? load.templates : [];

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

  async function onToggleView(tpl: Template) {
    if (!company) return;
    if (previewType === tpl.type) {
      setPreviewType(null);
      setPreviewText(null);
      setPreviewState('idle');
      return;
    }
    setPreviewType(tpl.type);
    setPreviewText(null);
    setPreviewState('loading');
    try {
      const res = await api.api.companies[':id']['email-templates'][':type'].preview.$post({
        param: { id: company.id, type: tpl.type },
        json: { subject: tpl.subject, body: tpl.body },
      });
      if (!res.ok) {
        setPreviewState('error');
        return;
      }
      setPreviewText((await res.json()).text);
      setPreviewState('idle');
    } catch {
      setPreviewState('error');
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
          <>
            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Reply-to address
              </Text>
              <Text className="mt-2 font-serif text-lg text-ink">{company.name}</Text>
              <Text className="mt-3 text-sm text-ink/70">
                Invoices and estimates go out under your business name, but from Thalermark's
                sending address. Set a reply-to so when a customer hits "reply," it reaches you.
                Leave it blank to send with no reply-to.
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

            <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm">
              <View className="border-b border-ink/10 p-6">
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Email templates
                </Text>
                <Text className="mt-2 text-sm text-ink/70">
                  Customize the wording your customers see. The Thalermark layout, buttons, and
                  footer stay the same — you edit the subject and message.
                </Text>
              </View>
              {templates.map((tpl, i) => (
                <View key={tpl.type} className={i > 0 ? 'border-t border-ink/10' : ''}>
                  <View className="flex-row items-center justify-between gap-3 p-6">
                    <View className="flex-1">
                      <Text className="font-serif text-lg text-ink">
                        {TEMPLATE_LABELS[tpl.type] ?? tpl.type}
                      </Text>
                      <Text
                        className={`mt-1 font-mono text-[0.65rem] uppercase tracking-widest ${
                          tpl.isCustomized ? 'text-gold-deep' : 'text-ink/40'
                        }`}
                      >
                        {tpl.isCustomized ? 'Customized' : 'Default'}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => onToggleView(tpl)}
                      className="rounded-sm border border-ink/20 px-3 py-2 active:bg-ink/5"
                    >
                      <Text className="text-sm text-ink">
                        {previewType === tpl.type ? 'Close' : 'View'}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => router.push(`/more/email/${tpl.type}`)}
                      className="rounded-sm border border-ink/20 px-3 py-2 active:bg-ink/5"
                    >
                      <Text className="text-sm text-ink">Edit</Text>
                    </Pressable>
                  </View>
                  {previewType === tpl.type ? (
                    <View className="border-t border-ink/10 bg-cream p-4">
                      {previewState === 'loading' ? (
                        <ActivityIndicator color="#0f1626" />
                      ) : previewState === 'error' ? (
                        <Text className="text-sm text-oxblood">Couldn't load preview.</Text>
                      ) : (
                        <Text className="font-mono text-xs leading-relaxed text-ink/80">
                          {previewText}
                        </Text>
                      )}
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
