import { minutesFromDuration } from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';

// Mirror of apps/web's /jobs/[id]. The margin block leads, and the number it
// exists for is PER HOUR, not made.
//
// Hours are never subtracted into margin — a sole proprietor cannot deduct their
// own labour, so there is no wage expense and no journal entry. They divide it
// instead, which is what answers "was this job worth my time".
//
// INTERNAL ONLY. Nothing on this screen reaches the customer.
type JobDetail = {
  id: string;
  name: string;
  status: string;
  contactName: string | null;
  invoices: { id: string; number: string; issueDate: string; status: string; total: string }[];
  margin: {
    billed: string;
    costs: string;
    made: string;
    minutes: number;
    hours: string;
    effectiveHourly: string | null;
  };
};

type TimeEntry = {
  id: string;
  entryDate: string;
  minutes: number;
  note: string | null;
  billedInvoiceId: string | null;
};

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const hours = (minutes: number) => (Math.round((minutes / 60) * 100) / 100).toFixed(2);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function JobDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const canWrite = useMay('sales:write');

  const [job, setJob] = useState<JobDetail | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [rate, setRate] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  const load = useCallback(async () => {
    const [jobRes, timeRes] = await Promise.all([
      api.api.jobs[':id'].$get({ param: { id } }),
      api.api.jobs[':id'].time.$get({ param: { id }, query: { unbilled: undefined } }),
    ]);
    if (!jobRes.ok) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setJob((await jobRes.json()) as JobDetail);
    if (timeRes.ok) setEntries(((await timeRes.json()).timeEntries ?? []) as TimeEntry[]);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      load().catch(() => {
        if (active) {
          setFailed(true);
          setLoading(false);
        }
      });
      return () => {
        active = false;
      };
    }, [load]),
  );

  async function logTime() {
    setTimeError(null);
    // Shared with web (@thalermark/validation) so the same typed string cannot
    // become two different durations.
    const minutes = minutesFromDuration(duration);
    if (minutes === null) {
      setTimeError('Enter hours like 3.25 or 3:15.');
      return;
    }
    setLogging(true);
    try {
      const res = await api.api.jobs[':id'].time.$post({
        param: { id },
        json: {
          entryDate: todayIso(),
          minutes,
          note: note.trim() || undefined,
          rate: rate.trim() || undefined,
        },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setTimeError(body?.error ?? 'Could not log those hours.');
        return;
      }
      setDuration('');
      setNote('');
      await load();
    } catch {
      setTimeError('Could not log those hours.');
    } finally {
      setLogging(false);
    }
  }

  async function removeEntry(entryId: string) {
    const res = await api.api['time-entries'][':id'].$delete({ param: { id: entryId } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setTimeError(
        body?.error === 'time_entry_billed'
          ? 'Those hours are already on an invoice. Take them off it first.'
          : 'Could not remove those hours.',
      );
      return;
    }
    await load();
  }

  async function toggleStatus() {
    if (!job) return;
    const res = await api.api.jobs[':id'].$patch({
      param: { id },
      json: { status: job.status === 'open' ? 'closed' : 'open' },
    });
    if (res.ok) await load();
  }

  if (loading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-cream" edges={['top']}>
        <ActivityIndicator color="#0f1626" />
      </SafeAreaView>
    );
  }

  if (failed || !job) {
    return (
      <SafeAreaView className="flex-1 bg-cream px-6 pt-6" edges={['top']}>
        <Pressable onPress={() => router.back()}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">← Jobs</Text>
        </Pressable>
        <Text className="mt-8 text-sm text-oxblood">Couldn't load this job.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <ScrollView contentContainerClassName="px-6 pb-12 pt-6" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">← Jobs</Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">{job.name}</Text>
          {/*
            The customer is asked for at create, so it has to show back here —
            not showing it reads as "that field did nothing".
          */}
          {job.contactName ? (
            <Text className="mt-1 text-sm text-ink/60">for {job.contactName}</Text>
          ) : null}

          <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-5">
            <View className="flex-row justify-between">
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Billed
                </Text>
                <Text className="mt-1 font-mono text-lg text-ink/80">{fmt(job.margin.billed)}</Text>
              </View>
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Cost
                </Text>
                <Text className="mt-1 font-mono text-lg text-ink/80">{fmt(job.margin.costs)}</Text>
              </View>
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Made
                </Text>
                <Text className="mt-1 font-mono text-lg text-ink">{fmt(job.margin.made)}</Text>
              </View>
            </View>
            <View className="mt-5 border-t border-ink/10 pt-4">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Per hour
              </Text>
              {/*
                A dash, not $0.00, when nothing is logged. Zero would read as
                "this job paid you nothing an hour" rather than "you haven't told
                me the hours".
              */}
              <Text className="mt-1 font-serif text-3xl font-light text-ink">
                {job.margin.effectiveHourly ? fmt(job.margin.effectiveHourly) : '—'}
              </Text>
              <Text className="mt-1 text-xs text-ink/50">
                {job.margin.minutes > 0 ? `over ${job.margin.hours} h` : 'no hours logged'}
              </Text>
            </View>
          </View>

          {canWrite ? (
            <View className="mt-4 flex-row gap-2">
              <Pressable
                onPress={() => router.push(`/invoices/new?jobId=${job.id}`)}
                className="flex-1 items-center rounded-sm bg-ink px-4 py-3 active:bg-gold-deep"
              >
                <Text className="text-sm font-medium text-cream">Bill this job</Text>
              </Pressable>
              <Pressable
                onPress={toggleStatus}
                className="items-center rounded-sm border border-ink/20 px-4 py-3"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  {job.status === 'open' ? 'Close' : 'Reopen'}
                </Text>
              </Pressable>
            </View>
          ) : null}

          <Text className="mt-10 font-serif text-2xl font-light text-ink">Invoices</Text>
          {job.invoices.length === 0 ? (
            <Text className="mt-2 text-sm text-ink/60">
              Nothing billed yet. A job can carry as many invoices as it needs.
            </Text>
          ) : (
            <View className="mt-3 rounded-sm border border-ink/10 bg-cream-warm">
              {job.invoices.map((inv, i) => (
                <Pressable
                  key={inv.id}
                  onPress={() => router.push(`/invoices/${inv.id}`)}
                  className={`flex-row items-center justify-between px-5 py-3 ${
                    i > 0 ? 'border-t border-ink/10' : ''
                  }`}
                >
                  <Text className="font-mono text-xs text-ink/50">{inv.number}</Text>
                  <Text className="text-sm text-ink/60">{inv.issueDate}</Text>
                  <Text className="font-mono text-sm text-ink/80">{fmt(inv.total)}</Text>
                </Pressable>
              ))}
            </View>
          )}

          <Text className="mt-10 font-serif text-2xl font-light text-ink">Hours</Text>

          {canWrite ? (
            <View className="mt-3">
              {/*
                A plain duration field, not a timer. Reconstructing "3 hours
                yesterday" has to be as easy as running a stopwatch live, because
                the start of a job is exactly when nobody is thinking about an app.
              */}
              <View className="flex-row gap-2">
                <TextInput
                  value={duration}
                  onChangeText={setDuration}
                  placeholder="3.25"
                  keyboardType="decimal-pad"
                  className="w-24 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5 text-ink"
                />
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="What you did"
                  maxLength={1000}
                  className="flex-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5 text-ink"
                />
              </View>
              <TextInput
                value={rate}
                onChangeText={setRate}
                placeholder="Rate per hour — optional"
                keyboardType="decimal-pad"
                className="mt-2 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5 text-ink"
              />
              <Pressable
                onPress={logTime}
                disabled={logging}
                className="mt-2 items-center rounded-sm border border-ink/20 px-4 py-2.5 active:bg-cream-warm disabled:opacity-50"
              >
                {logging ? (
                  <ActivityIndicator color="#0f1626" />
                ) : (
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                    Log hours
                  </Text>
                )}
              </Pressable>
              {timeError ? <Text className="mt-2 text-xs text-oxblood">{timeError}</Text> : null}
            </View>
          ) : null}

          {entries.length === 0 ? (
            <Text className="mt-4 text-sm text-ink/60">No hours logged against this job yet.</Text>
          ) : (
            <View className="mt-4 rounded-sm border border-ink/10 bg-cream-warm">
              {entries.map((entry, i) => (
                <View
                  key={entry.id}
                  className={`flex-row items-center justify-between px-5 py-3 ${
                    i > 0 ? 'border-t border-ink/10' : ''
                  }`}
                >
                  <Text className="w-24 text-sm text-ink/60">{entry.entryDate}</Text>
                  <Text className="w-16 font-mono text-sm text-ink/80">
                    {hours(entry.minutes)} h
                  </Text>
                  <Text className="flex-1 pr-2 text-sm text-ink/70" numberOfLines={1}>
                    {entry.note ?? ''}
                  </Text>
                  {entry.billedInvoiceId ? (
                    <Text className="font-mono text-[0.6rem] uppercase tracking-widest text-ink/40">
                      Billed
                    </Text>
                  ) : canWrite ? (
                    <Pressable onPress={() => removeEntry(entry.id)}>
                      <Text className="font-mono text-[0.6rem] uppercase tracking-widest text-oxblood">
                        Remove
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
