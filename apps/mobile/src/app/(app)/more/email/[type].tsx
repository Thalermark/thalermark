import {
  EMAIL_TEMPLATE_TYPES,
  type EmailTemplateType,
  emailTemplateUpdateSchema,
  unknownPlaceholders,
} from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../../lib/active-company';
import { api } from '../../../../lib/api';

// Per-template editor — native mirror of apps/web's /settings/email/[type].
// Edit the subject + message (plain text with {{placeholders}}); the branded
// shell stays server-side. Save (PUT) / Preview (renders the text the contact
// gets) / Reset to default (DELETE the override).
const LABELS: Record<string, string> = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  statement: 'Customer statement',
};
const PLACEHOLDER_HELP: Record<string, string> = {
  customer_name: "the customer's name",
  invoice_number: 'invoice number',
  estimate_number: 'estimate number',
  amount: 'total with currency',
  due_date: 'invoice due date',
  statement_date: 'statement date',
  balance_due: 'balance owed',
  company_name: 'your business name',
};

type Ready = {
  state: 'ready';
  companyId: string;
  subject: string;
  body: string;
  isCustomized: boolean;
  placeholders: readonly string[];
};
type LoadState = { state: 'loading' } | Ready | { state: 'error' };

export default function EmailTemplateEditor() {
  const router = useRouter();
  const params = useLocalSearchParams<{ type: string }>();
  const type: EmailTemplateType | null = (EMAIL_TEMPLATE_TYPES as readonly string[]).includes(
    params.type ?? '',
  )
    ? (params.type as EmailTemplateType)
    : null;

  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!type) {
        setLoad({ state: 'error' });
        return;
      }
      let active = true;
      (async () => {
        try {
          const cRes = await api.api.companies.$get();
          if (!active) return;
          if (!cRes.ok) {
            setLoad({ state: 'error' });
            return;
          }
          const company = await pickActiveCompany((await cRes.json()).companies);
          if (!company) {
            setLoad({ state: 'error' });
            return;
          }
          const tRes = await api.api.companies[':id']['email-templates'].$get({
            param: { id: company.id },
          });
          if (!tRes.ok) {
            setLoad({ state: 'error' });
            return;
          }
          const tpl = (await tRes.json()).templates.find((t) => t.type === type);
          if (!active || !tpl) {
            if (active) setLoad({ state: 'error' });
            return;
          }
          setLoad({
            state: 'ready',
            companyId: company.id,
            subject: tpl.subject,
            body: tpl.body,
            isCustomized: tpl.isCustomized,
            placeholders: tpl.placeholders,
          });
          setSubject(tpl.subject);
          setBody(tpl.body);
        } catch {
          if (active) setLoad({ state: 'error' });
        }
      })();
      return () => {
        active = false;
      };
    }, [type]),
  );

  const ready = load.state === 'ready' ? load : null;

  // Client-side mirror of the API's validation, for a fast inline error.
  function validate(): { subject: string; body: string } | null {
    if (!type) return null;
    const s = subject.trim();
    const b = body.trim();
    const parsed = emailTemplateUpdateSchema.safeParse({ subject: s, body: b });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Subject and message are required.');
      return null;
    }
    const bad = unknownPlaceholders(type, s, b);
    if (bad.length) {
      setError(
        `Unknown placeholder${bad.length > 1 ? 's' : ''}: ${bad.map((x) => `{{${x}}}`).join(', ')}`,
      );
      return null;
    }
    return parsed.data;
  }

  async function onSave() {
    if (!ready || !type) return;
    setSaved(false);
    setError(null);
    const data = validate();
    if (!data) return;
    setBusy(true);
    try {
      const res = await api.api.companies[':id']['email-templates'][':type'].$put({
        param: { id: ready.companyId, type },
        json: data,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(b?.error ?? 'Could not save.');
        return;
      }
      setLoad({ ...ready, subject: data.subject, body: data.body, isCustomized: true });
      setSaved(true);
    } catch {
      setError('Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function onPreview() {
    if (!ready || !type) return;
    setSaved(false);
    setError(null);
    const data = validate();
    if (!data) return;
    setBusy(true);
    try {
      const res = await api.api.companies[':id']['email-templates'][':type'].preview.$post({
        param: { id: ready.companyId, type },
        json: data,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(b?.error ?? 'Could not render preview.');
        return;
      }
      setPreview((await res.json()).text);
    } catch {
      setError('Could not render preview.');
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    if (!ready || !type) return;
    setSaved(false);
    setError(null);
    setBusy(true);
    try {
      const res = await api.api.companies[':id']['email-templates'][':type'].$delete({
        param: { id: ready.companyId, type },
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(b?.error ?? 'Could not reset.');
        return;
      }
      const def = await res.json();
      setLoad({ ...ready, subject: def.subject, body: def.body, isCustomized: false });
      setSubject(def.subject);
      setBody(def.body);
      setPreview(null);
    } catch {
      setError('Could not reset.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        <Text
          onPress={() => router.push('/more/email')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← All templates
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">
          {type ? (LABELS[type] ?? type) : 'Template'} email
        </Text>

        {load.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : !ready ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this template.</Text>
        ) : (
          <>
            <Text className="mt-3 text-sm text-ink/70">
              Edit the subject and message your contacts see. The Thalermark layout, button, and
              footer stay the same. Use the placeholders below.
            </Text>

            <Text className="mt-6 font-mono text-xs uppercase tracking-widest text-ink/50">
              Subject
            </Text>
            <TextInput
              value={subject}
              onChangeText={(t) => {
                setSubject(t);
                setSaved(false);
              }}
              className="mt-2 rounded-sm border border-ink/20 bg-cream-warm px-3 py-2 text-ink"
            />

            <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
              Message
            </Text>
            <TextInput
              value={body}
              onChangeText={(t) => {
                setBody(t);
                setSaved(false);
              }}
              multiline
              textAlignVertical="top"
              className="mt-2 min-h-40 rounded-sm border border-ink/20 bg-cream-warm px-3 py-2 font-mono text-sm leading-relaxed text-ink"
            />

            <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink/50">
              Placeholders
            </Text>
            <View className="mt-2 gap-1">
              {ready.placeholders.map((p) => (
                <Text key={p} className="font-mono text-xs text-ink/60">
                  {`{{${p}}}`} — {PLACEHOLDER_HELP[p] ?? p}
                </Text>
              ))}
            </View>

            {error ? <Text className="mt-4 text-sm text-oxblood">{error}</Text> : null}

            <View className="mt-6 flex-row items-center gap-3">
              <Pressable
                onPress={onSave}
                disabled={busy}
                className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
              >
                <Text className="text-sm font-medium text-cream">Save</Text>
              </Pressable>
              <Pressable
                onPress={onPreview}
                disabled={busy}
                className="rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
              >
                <Text className="text-sm text-ink">Preview</Text>
              </Pressable>
              {saved ? <Text className="text-sm text-ink/60">Saved.</Text> : null}
            </View>

            {preview ? (
              <View className="mt-6 rounded-sm border border-ink/15 bg-cream-warm">
                <Text className="border-b border-ink/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-ink/50">
                  Preview
                </Text>
                <Text className="p-4 font-mono text-xs leading-relaxed text-ink/80">{preview}</Text>
              </View>
            ) : null}

            {ready.isCustomized ? (
              <Pressable onPress={onReset} disabled={busy} className="mt-6">
                <Text className="text-sm text-oxblood">Reset to default wording</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
