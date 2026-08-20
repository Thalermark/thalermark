import { Ionicons } from '@expo/vector-icons';
import {
  MAX_REMINDER_OFFSET,
  MAX_REMINDER_STAGES,
  MIN_REMINDER_OFFSET,
} from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';

// Settings → Payment reminders — native mirror of apps/web's
// /settings/reminders. Chase unpaid invoices automatically.
//
// THE SHAPE THAT MATTERS: the API stores ONE signed array, `reminderOffsets`.
// Negative is before the due date, positive is on or after it. The user never
// sees a minus sign — the screen splits the array into two groups and the group
// carries the sign, the same way the refund control offers a direction rather
// than asking anyone to type a negative number. Re-joined on save.
//
// The caps (max stages, min/max offset) come from @thalermark/validation so the
// Add button can stop at the limit, but they are NOT re-validated here on
// submit: the API is the authority, and a duplicate day or an out-of-range
// value comes back as a save error rather than being checked in two places that
// can disagree.
type Company = { id: string; name: string; remindersEnabled?: boolean | null };

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; company: Company; emailConfigured: boolean };

export default function Reminders() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [enabled, setEnabled] = useState(false);
  const [before, setBefore] = useState<number[]>([]);
  const [after, setAfter] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await api.api.companies.$get();
    if (!res.ok) return setState({ kind: 'error' });
    const { companies } = await res.json();
    const company = await pickActiveCompany(companies);
    if (!company) return setState({ kind: 'error' });

    // Can this server actually send them? Reminders are HELD rather than banked
    // when it cannot, so the screen must not promise chasing that will not
    // happen (TMC-212). Best-effort: assume yes if the read fails.
    const tplRes = await api.api.companies[':id']['email-templates'].$get({
      param: { id: company.id },
    });
    const emailConfigured = tplRes.ok ? ((await tplRes.json()).emailConfigured ?? true) : true;

    const offsets = company.reminderOffsets ?? [];
    setEnabled(company.remindersEnabled ?? false);
    setBefore(offsets.filter((d) => d < 0).map((d) => Math.abs(d)));
    setAfter(offsets.filter((d) => d >= 0));
    setState({ kind: 'ready', company, emailConfigured });
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load().catch(() => {
        if (alive) setState({ kind: 'error' });
      });
      return () => {
        alive = false;
      };
    }, [load]),
  );

  const total = before.length + after.length;
  const atLimit = total >= MAX_REMINDER_STAGES;

  async function onSave() {
    if (state.kind !== 'ready') return;
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      const res = await api.api.companies[':id'].$patch({
        param: { id: state.company.id },
        json: {
          remindersEnabled: enabled,
          // Re-join: the group supplies the sign the user never typed.
          reminderOffsets: [...before.map((n) => -Math.abs(n)), ...after.map((n) => Math.abs(n))],
        },
      });
      if (!res.ok) {
        setSaveError(true);
        return;
      }
      setSaved(true);
      await load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/more')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← More
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Payment reminders</Text>
        <Text className="mt-3 text-sm leading-relaxed text-ink-muted">
          Chase unpaid invoices automatically. Reminders are sent to your customer, from you, and
          stop as soon as an invoice is paid in full.
        </Text>

        {state.kind === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : state.kind === 'error' ? (
          <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
            <Text className="text-sm text-ink-muted">Couldn't load your reminder schedule.</Text>
            <Pressable onPress={() => void load()} className="mt-3 self-start">
              <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                Try again
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            {!state.emailConfigured ? (
              <View className="mt-6 rounded-sm border border-gold-deep/40 bg-gold/10 p-4">
                <Text className="text-sm text-ink">
                  <Text className="font-medium">No reminders are going out.</Text> This server can't
                  send email yet, so due reminders are held rather than sent. Nothing is marked as
                  chased, and they resume for real once email works. Set the schedule up now if you
                  like; it takes effect then.
                </Text>
              </View>
            ) : null}

            <Pressable
              onPress={() => {
                setEnabled((v) => !v);
                setSaved(false);
              }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: enabled }}
              className="mt-8 flex-row items-start gap-3"
            >
              <Ionicons
                name={enabled ? 'checkbox' : 'square-outline'}
                size={22}
                className={enabled ? 'text-gold-deep' : 'text-ink-subtle'}
              />
              <View className="flex-1">
                <Text className="text-ink">Send payment reminders automatically</Text>
                <Text className="mt-1 text-sm text-ink-subtle">
                  Off by default. Nothing is sent until you turn this on.
                </Text>
              </View>
            </Pressable>

            <View className={enabled ? 'mt-8' : 'mt-8 opacity-50'}>
              <StageGroup
                legend="Before it's due"
                hint="A gentle heads-up while there's still time."
                unit="days before"
                values={before}
                onChange={(next) => {
                  setBefore(next);
                  setSaved(false);
                }}
                disabled={!enabled}
                atLimit={atLimit}
                defaultValue={5}
                max={Math.abs(MIN_REMINDER_OFFSET)}
              />
              <StageGroup
                legend="After it's due"
                hint="A nudge once it's late."
                unit="days after"
                values={after}
                onChange={(next) => {
                  setAfter(next);
                  setSaved(false);
                }}
                disabled={!enabled}
                atLimit={atLimit}
                defaultValue={7}
                max={MAX_REMINDER_OFFSET}
              />
            </View>

            {atLimit ? (
              <Text className="mt-6 text-sm text-ink-subtle">
                That's the maximum of {MAX_REMINDER_STAGES} reminders. More than this reads as
                harassment to a customer, and it puts your email deliverability at risk.
              </Text>
            ) : null}

            <Text className="mt-6 text-sm leading-relaxed text-ink-subtle">
              Reminders quote what's still owed, not the invoice total, so a customer who paid a
              deposit is only chased for the balance. Nothing is sent within a few days of a payment
              arriving, and you can turn reminders off for any single invoice from that invoice.
            </Text>

            {saveError ? (
              <Text className="mt-4 text-sm text-oxblood">
                Couldn't save that. Check each reminder is a different number of days.
              </Text>
            ) : saved ? (
              <Text className="mt-4 text-sm text-ink-muted">Saved.</Text>
            ) : null}

            <View className="mt-6 flex-row items-center gap-3">
              <Pressable
                onPress={onSave}
                disabled={saving}
                className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
              >
                <Text className="text-sm font-medium text-cream">Save</Text>
              </Pressable>
              {saving ? <ActivityIndicator className="text-ink" /> : null}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StageGroup({
  legend,
  hint,
  unit,
  values,
  onChange,
  disabled,
  atLimit,
  defaultValue,
  max,
}: {
  legend: string;
  hint: string;
  unit: string;
  values: number[];
  onChange: (next: number[]) => void;
  disabled: boolean;
  atLimit: boolean;
  defaultValue: number;
  max: number;
}) {
  return (
    <View className="mt-6">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{legend}</Text>
      <Text className="mt-1 text-sm text-ink-subtle">{hint}</Text>
      {values.map((days, i) => (
        // Index key: these rows are positional and reorderable only by
        // add/remove, so the index IS the identity. Same as web's `(i)` key.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows, no stable id
        <View key={i} className="mt-3 flex-row items-center gap-3">
          <TextInput
            value={String(days)}
            onChangeText={(v) => {
              const n = Number.parseInt(v.replace(/[^0-9]/g, ''), 10);
              const next = [...values];
              next[i] = Number.isFinite(n) ? Math.min(n, max) : 0;
              onChange(next);
            }}
            editable={!disabled}
            keyboardType="number-pad"
            className="w-20 border-b border-field py-2 text-center text-ink"
          />
          <Text className="flex-1 text-sm text-ink-muted">{unit}</Text>
          <Pressable
            onPress={() => onChange(values.filter((_, n) => n !== i))}
            disabled={disabled}
            accessibilityRole="button"
          >
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Remove
            </Text>
          </Pressable>
        </View>
      ))}
      {!atLimit ? (
        <Pressable
          onPress={() => onChange([...values, defaultValue])}
          disabled={disabled}
          className="mt-3 self-start rounded-sm border border-ink/20 px-3 py-2 active:bg-cream-warm"
        >
          <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
            Add a reminder
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
