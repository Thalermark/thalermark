import {
  formatUnitPrice,
  hoursFromMinutes,
  minutesFromDuration,
  multiplyMoney,
  sumMoney,
} from '@thalermark/validation';
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
  rate: string | null;
  billedInvoiceId: string | null;
};

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// DISPLAY only, 2dp. Never use for money: billing converts at 4dp via
// hoursFromMinutes, and 50 minutes is 0.83 here against 0.8333 there — a nickel
// apart at $15/h. Anything that must agree with an invoice uses entryValue.
const hours = (minutes: number) => (Math.round((minutes / 60) * 100) / 100).toFixed(2);

// What an entry will actually bill, priced the way the invoice form prices it.
const entryValue = (minutes: number, rate: string) =>
  multiplyMoney(hoursFromMinutes(minutes), rate);

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
  // Prefilled from the last rate used on this job — most work is billed at one
  // rate, and retyping it every entry is the friction that stops people logging.
  const [ratePrefilled, setRatePrefilled] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);

  // Tracked hours not yet on an invoice — what billing would add right now.
  // Only rated entries: unrated hours bill nothing.
  const readyToBill = sumMoney(
    entries
      .filter((e) => !e.billedInvoiceId && e.rate !== null)
      .map((e) => entryValue(e.minutes, e.rate ?? '0')),
  );
  // Unbilled hours with no rate, so "ready to bill" is never mistaken for
  // everything uncharged.
  const unratedMinutes = entries
    .filter((e) => !e.billedInvoiceId && !e.rate)
    .reduce((total, e) => total + e.minutes, 0);
  // An unsent draft already on this job — billing again would start a second one
  // and burn another invoice number on a blank.
  const openDraft = job?.invoices.find((i) => i.status === 'draft');

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
    if (timeRes.ok) {
      const rows = ((await timeRes.json()).timeEntries ?? []) as TimeEntry[];
      setEntries(rows);
      // Newest-first, so the first row carrying a rate is the last one used.
      // Only seeds once, so it never overwrites what the user is typing.
      const last = rows.find((r) => r.rate)?.rate;
      if (last) {
        setRatePrefilled((already) => {
          if (!already) setRate(formatUnitPrice(last));
          return true;
        });
      }
    }
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

  // Closing takes the job out of the default list and its unbilled work with
  // it, so the API refuses the first attempt and names the amount. Asked once,
  // then honoured — not blocked, and never silent.
  async function toggleStatus(confirmed = false) {
    if (!job) return;
    const next = job.status === 'open' ? 'closed' : 'open';
    const res = await api.api.jobs[':id'].$patch({
      param: { id },
      query: { confirm: confirmed ? 'true' : undefined },
      json: { status: next },
    });
    if (res.ok) {
      setConfirmClose(null);
      await load();
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      readyToBill?: string;
    } | null;
    if (body?.error === 'job_has_unbilled_time') {
      setConfirmClose(body.readyToBill ?? '0.00');
    }
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
            {/*
              Ready to bill leads on a phone too, and gets the big type: it is the
              only number here you act on — the rest are history.
            */}
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
              Ready to bill
            </Text>
            <Text
              className={`mt-1 font-serif text-3xl font-light ${
                Number(readyToBill) > 0 ? 'text-gold-deep' : 'text-ink'
              }`}
            >
              {fmt(readyToBill)}
            </Text>
            {/*
              The caveat lives WITH the number. Only rated hours can be billed, so
              a job with a day of unrated work shows $0.00 and would read as
              "nothing to invoice" when there is plenty — just nothing priced yet.
            */}
            <Text className="mt-1 text-xs text-ink/50">
              {unratedMinutes > 0
                ? `${hours(unratedMinutes)} h needs a rate`
                : Number(readyToBill) > 0
                  ? 'not on an invoice yet'
                  : 'nothing waiting'}
            </Text>

            <View className="mt-5 flex-row justify-between border-t border-ink/10 pt-4">
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
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                  Per hour
                </Text>
                {/*
                  A dash, never $0.00. Zero would read as "this job paid you
                  nothing an hour"; the truth until it bills is "no answer yet".
                */}
                <Text className="mt-1 font-mono text-lg text-ink">
                  {job.margin.effectiveHourly ? fmt(job.margin.effectiveHourly) : '—'}
                </Text>
              </View>
            </View>
            <Text className="mt-3 text-xs text-ink/50">
              {job.margin.minutes > 0 ? `${job.margin.hours} h logged` : 'no hours logged'}
            </Text>
          </View>

          {canWrite ? (
            <View className="mt-4 flex-row gap-2">
              {/*
                Three states, one button position:
                - an unsent draft exists -> continue THAT, never start a second
                  one and burn another invoice number on a blank
                - hours waiting          -> bill them
                - nothing waiting        -> disabled. Pushing to a form with no
                  hours to prefill produces an empty invoice and wastes the trip.
                The flat-fee path still exists from the invoices tab, which has a
                job picker.
              */}
              {openDraft ? (
                <Pressable
                  onPress={() => router.push(`/invoices/${openDraft.id}/edit`)}
                  className="flex-1 items-center rounded-sm bg-ink px-4 py-3 active:bg-gold-deep"
                >
                  <Text className="text-sm font-medium text-cream">
                    Continue {openDraft.number}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => router.push(`/invoices/new?jobId=${job.id}`)}
                  disabled={Number(readyToBill) <= 0}
                  className={`flex-1 items-center rounded-sm bg-ink px-4 py-3 active:bg-gold-deep ${
                    Number(readyToBill) <= 0 ? 'opacity-40' : ''
                  }`}
                >
                  <Text className="text-sm font-medium text-cream">Bill this job</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => toggleStatus()}
                className="items-center rounded-sm border border-ink/20 px-4 py-3"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                  {job.status === 'open' ? 'Close' : 'Reopen'}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {confirmClose ? (
            <View className="mt-4 rounded-sm border border-gold-deep/40 bg-gold-deep/5 p-4">
              <Text className="text-sm text-ink/80">
                This job still has {fmt(confirmClose)} ready to bill. Closing it hides the job from
                the default list, and that money with it.
              </Text>
              <View className="mt-3 flex-row gap-2">
                <Pressable
                  onPress={() => toggleStatus(true)}
                  className="items-center rounded-sm bg-ink px-4 py-2.5 active:bg-gold-deep"
                >
                  <Text className="text-sm font-medium text-cream">Close anyway</Text>
                </Pressable>
                <Pressable
                  onPress={() => setConfirmClose(null)}
                  className="items-center rounded-sm border border-ink/20 px-4 py-2.5"
                >
                  <Text className="text-sm text-ink/70">Keep it open</Text>
                </Pressable>
              </View>
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
                  {/*
                    Silent when no rate was set — those hours still count toward
                    the job's time, and "$0.00/h" would look like a mistake.
                  */}
                  {entry.rate ? (
                    <Text className="pr-2 font-mono text-xs text-ink/60">
                      ${formatUnitPrice(entry.rate)}/h
                    </Text>
                  ) : null}
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
