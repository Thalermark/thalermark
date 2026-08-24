import {
  BILLING_UNITS,
  billingUnitLabel,
  entryUnit,
  formatQuantity,
  formatUnitPrice,
  minutesFromClockSpan,
  minutesFromDuration,
  multiplyMoney,
  sumMoney,
  timeEntryQuantity,
} from '@thalermark/validation';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { apiErrorMessage } from '../../../../lib/api-errors';
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
    // On an invoice that exists but hasn't been sent. Reported beside billed,
    // never folded into it (TMC-202).
    drafted: string;
    costs: string;
    // Null until some revenue is recognised — there is no margin to state yet.
    made: string | null;
    minutes: number;
    hours: string;
    effectiveHourly: string | null;
  };
};

type TimeEntry = {
  id: string;
  entryDate: string;
  minutes: number | null;
  note: string | null;
  rate: string | null;
  billedInvoiceId: string | null;
  // Nullable since TMC-264 — optional on a job that does not bill by hours.
  quantity: string | null;
  // This line's own unit; null inherits the job's.
  unit: string | null;
  startTime: string | null;
  endTime: string | null;
};

// The three ways in, in the order they are offered. Same labels as web: two
// clients naming one input mode differently is the same class of drift as two
// clients rounding one duration differently.
const LOG_MODES = [
  { key: 'duration', label: 'Duration' },
  { key: 'card', label: 'Start & end' },
  { key: 'stopwatch', label: 'Stopwatch' },
] as const;

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// DISPLAY only, 2dp. Never use for money: billing converts at 4dp via
// hoursFromMinutes, and 50 minutes is 0.83 here against 0.8333 there — a nickel
// apart at $15/h. Anything that must agree with an invoice uses entryValue.
const hours = (minutes: number | null) =>
  (Math.round(((minutes ?? 0) / 60) * 100) / 100).toFixed(2);

// What an entry will actually bill, priced the way the invoice form prices it —
// which means reading the JOB's unit rather than assuming hours (TMC-264). A
// "ready to bill" that disagrees with the invoice it produces is worse than none.
const entryValue = (
  entry: { minutes: number | null; quantity: string | null },
  rate: string,
  billingUnit: string,
) => {
  const qty = timeEntryQuantity(entry, billingUnit);
  return qty === null ? '0.00' : multiplyMoney(qty, rate);
};

// How an entry reads in the list: "3.25 h" on an hourly job, "3 visits" other.
// Each row reads in the unit IT was logged in, not the job's and not the one
// currently selected in the form above.
const entryAmountLabel = (
  entry: { minutes: number | null; quantity: string | null; unit: string | null },
  jobUnit: string,
) => {
  const u = entryUnit(entry, jobUnit);
  if (u === 'hour') return `${hours(entry.minutes)} h`;
  const qty = entry.quantity ?? '0';
  return `${formatQuantity(qty)} ${billingUnitLabel(u, qty)}`;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function JobDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const canWrite = useMay('sales:write');

  const [job, setJob] = useState<JobDetail | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  // How this job bills (TMC-264). 'hour' until the job says otherwise, which is
  // what every job written before this means.
  const [billingUnit, setBillingUnit] = useState('hour');
  // What the line being typed right now bills in (TMC-264, revised). Seeded from
  // the job's default, then the user's to change per entry — one job can mix
  // them, which is the point of the revision.
  const [lineUnit, setLineUnit] = useState('hour');
  // Seeded once. Following the job's default forever would overwrite a
  // deliberate override every time the screen refreshed.
  const lineUnitSeeded = useRef(false);
  const billsByHour = lineUnit === 'hour';
  // "Hours" was hard-coded, which reads as a lie on a job billing by the visit.
  const unitPlural = billingUnitLabel(billingUnit, '2');
  const workHeading = unitPlural.charAt(0).toUpperCase() + unitPlural.slice(1);

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [duration, setDuration] = useState('');
  // The time card (TMC-265): a third way in, beside the duration box and the
  // stopwatch, and the only one that is both after-the-fact and arithmetic-free.
  const [cardStart, setCardStart] = useState('');
  const [cardEnd, setCardEnd] = useState('');
  // The count, in the job's own unit (TMC-264). Defaulted to 1 because one entry
  // is almost always one visit.
  const [quantity, setQuantity] = useState('1');
  // Mirrors web's wording exactly. Two clients describing one overnight shift
  // differently is the same class of bug as two clients rounding it differently.
  const cardSpan = cardStart && cardEnd ? minutesFromClockSpan(cardStart, cardEnd) : null;
  const cardSummary = (() => {
    if (!cardStart || !cardEnd) return '';
    if (!cardSpan) return 'Check those times.';
    const h = Math.floor(cardSpan.minutes / 60);
    const m = cardSpan.minutes % 60;
    const span = m === 0 ? `${h}h` : `${h}h ${m}m`;
    return cardSpan.crossesMidnight
      ? `${span}, running past midnight. Logged on the start date.`
      : span;
  })();
  const [note, setNote] = useState('');
  const [rate, setRate] = useState('');
  // Prefilled from the last rate used on this job — most work is billed at one
  // rate, and retyping it every entry is the friction that stops people logging.
  const [ratePrefilled, setRatePrefilled] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);
  const hasEntryInput = Boolean(duration || note || cardStart || cardEnd);

  // Empties the per-entry fields and LEAVES THE MODE ALONE. Clearing while in
  // Start & end almost always means the times were wrong, so snapping back to
  // Duration would take away the input about to be reused. Date has no field
  // here (entries stamp today) and the rate is a sticky prefill, so neither is
  // touched — same split as web.
  function clearEntry() {
    setDuration('');
    setNote('');
    setCardStart('');
    setCardEnd('');
    setTimeError(null);
  }
  const [unitError, setUnitError] = useState<string | null>(null);
  // Once per screen: the first load that finds a timer already running on this
  // job opens on Stopwatch. Guarded so it can never yank the user back there on
  // a later refresh — that guard IS the web bug, avoided rather than repeated.
  //
  // A ref, not state: it must not re-render and must not enter load()'s dep
  // array, or flipping it would rebuild load and fetch the screen twice.
  const openedOnTimer = useRef(false);
  const [logging, setLogging] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);

  // The caller's running stopwatch — on this job or another. Persisted server
  // side, so one started on this phone can be stopped from a laptop later.
  const [timer, setTimer] = useState<{
    jobId: string;
    jobName: string;
    startedAt: string;
  } | null>(null);
  const [timerError, setTimerError] = useState<string | null>(null);
  // WHICH INPUT IS ON SCREEN (matching web, TMC-265). The three modes are
  // exclusive — only the chosen one renders — which is what removes the
  // precedence rule the stacked layout had to explain in prose.
  //
  // Replaces the old `showTimer` disclosure. On web the equivalent override
  // ("force stopwatch while a timer runs") turned out to LOCK the selector, so
  // this deliberately has no override: a running timer decides the INITIAL mode
  // and nothing more. The lazy useState initialiser is the same "read once on
  // arrival" semantics web gets from a $state initialiser.
  const [logMode, setLogMode] = useState<'duration' | 'card' | 'stopwatch'>('duration');
  // Ticks locally off startedAt. Elapsed is never accumulated, so a backgrounded
  // app or a device clock that disagrees cannot drift it.
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!timer) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timer]);

  const elapsed = timer
    ? (() => {
        const secs = Math.max(0, Math.floor((nowMs - new Date(timer.startedAt).getTime()) / 1000));
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
      })()
    : '';

  // Tracked hours not yet on an invoice — what billing would add right now.
  // Only rated entries: unrated hours bill nothing.
  const readyToBill = sumMoney(
    entries
      .filter((e) => !e.billedInvoiceId && e.rate !== null)
      .map((e) => entryValue(e, e.rate ?? '0', billingUnit)),
  );
  // Unbilled hours with no rate, so "ready to bill" is never mistaken for
  // everything uncharged.
  const unratedMinutes = entries
    .filter((e) => !e.billedInvoiceId && !e.rate)
    // Null minutes contribute nothing rather than poisoning the sum: on a
    // non-hourly job the duration is optional (TMC-264).
    .reduce((total, e) => total + (e.minutes ?? 0), 0);
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
      const timeBody = await timeRes.json();
      const rows = (timeBody.timeEntries ?? []) as TimeEntry[];
      setEntries(rows);
      const jobUnit = timeBody.billingUnit ?? 'hour';
      setBillingUnit(jobUnit);
      if (!lineUnitSeeded.current) {
        lineUnitSeeded.current = true;
        setLineUnit(jobUnit);
      }
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
    const timerRes = await api.api.timer.$get();
    if (timerRes.ok) {
      const { timer: running } = await timerRes.json();
      setTimer(running);
      // A timer already running on THIS job decides the mode we ARRIVE in, and
      // nothing after that. Guarded by openedOnTimer so a later refresh can
      // never yank the user back — web shipped that as a permanent override and
      // it silently ate every mode click until it was found by hand.
      if (running && running.jobId === id && !openedOnTimer.current) {
        openedOnTimer.current = true;
        setLogMode('stopwatch');
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

    // THREE WAYS IN, ONE RECORD OUT — the same resolution order web uses, and it
    // has to stay the same order or the two clients turn one typed thing into
    // two different durations. A time card wins over the duration box, because
    // someone who typed clock times meant them and the box may still hold a
    // stale stopwatch value.
    let minutes: number | null = null;
    if (cardStart && cardEnd) {
      const span = minutesFromClockSpan(cardStart, cardEnd);
      if (span === null) {
        setTimeError('Check the start and end times.');
        return;
      }
      // Overnight stays ONE entry, dated by its start (owner decision). The
      // summary below the fields already said so before this ran.
      minutes = span.minutes;
    } else if (cardStart || cardEnd) {
      setTimeError('Enter both a start and an end time, or neither.');
      return;
    } else if (duration.trim()) {
      // Shared with web (@thalermark/validation) so the same typed string cannot
      // become two different durations.
      minutes = minutesFromDuration(duration);
      if (minutes === null) {
        setTimeError('Enter hours like 3.25 or 3:15.');
        return;
      }
    }

    // On an hourly job the duration IS what gets billed, so it is required. On
    // any other unit it is optional context for effective-hourly (TMC-264).
    if (billsByHour && minutes === null) {
      setTimeError('Enter hours like 3.25 or 3:15.');
      return;
    }
    if (!billsByHour && !quantity.trim()) {
      setTimeError(`Enter how many ${billingUnitLabel(lineUnit, '2')} you did.`);
      return;
    }

    setLogging(true);
    try {
      const res = await api.api.jobs[':id'].time.$post({
        param: { id },
        json: {
          entryDate: todayIso(),
          minutes,
          quantity: billsByHour ? undefined : quantity.trim(),
          unit: lineUnit as 'hour' | 'visit' | 'day' | 'night' | 'job',
          startTime: cardStart || undefined,
          endTime: cardEnd || undefined,
          note: note.trim() || undefined,
          rate: rate.trim() || undefined,
        },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // Was `body?.error`, which printed the raw code — hitting the one-day cap
        // showed the user the literal string "invalid_body". That is exactly the
        // class TMC-219 / TMC-220 exist to prevent, and every other mobile screen
        // already routes through this helper.
        setTimeError(apiErrorMessage(body?.error, 'Could not log that.', body));
        return;
      }
      setDuration('');
      setNote('');
      setCardStart('');
      setCardEnd('');
      setQuantity('1');
      await load();
    } catch {
      setTimeError('Could not log those hours.');
    } finally {
      setLogging(false);
    }
  }

  // How this job bills (TMC-264). Mobile could READ the unit but had no way to
  // SET it, so every job on a phone was permanently by-the-hour and the feature
  // was unreachable without opening the web app. Same PATCH the web action makes.
  async function changeBillingUnit(next: string) {
    if (next === billingUnit) return;
    setUnitError(null);
    const previous = billingUnit;
    // Optimistic: the row re-labels immediately, and reverts if the API refuses.
    setBillingUnit(next);
    // The line follows: changing what the job usually bills by is a statement
    // about the next entry too, and leaving the line on the old unit would make
    // the picker look broken.
    setLineUnit(next);
    const res = await api.api.jobs[':id'].$patch({
      param: { id },
      query: { confirm: undefined },
      json: { billingUnit: next as 'hour' | 'visit' | 'day' | 'night' | 'job' },
    });
    if (!res.ok) {
      setBillingUnit(previous);
      setLineUnit(previous);
      setUnitError('That could not be changed. Try again.');
      return;
    }
    // Re-read rather than trust the optimistic value: the unit decides which
    // stored figure reaches an invoice, so every derived total on this screen
    // has to be recomputed from the server rather than guessed at.
    await load();
  }

  async function startTimer() {
    setTimerError(null);
    // No body: the API accepts an optional note at start, but neither client
    // offers one, and the route reads it manually so hc does not type `json`.
    const res = await api.api.jobs[':id'].timer.$post({ param: { id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        jobName?: string;
      } | null;
      // A refusal has to name the job holding the timer, or the user is stranded
      // — they are at THIS job and the thing blocking them is somewhere else.
      setTimerError(
        body?.error === 'timer_already_running'
          ? `A timer is already running on "${body.jobName}". Stop it there first.`
          : 'Could not start the timer.',
      );
      return;
    }
    await load();
  }

  // Stop hands back the minutes and fills the duration field — it does NOT log.
  // The note and rate are still the user's to give, and a stopwatch that
  // silently became a billable entry is the easiest way to invoice someone for
  // a drive home.
  async function stopTimer() {
    setTimerError(null);
    const res = await api.api.jobs[':id'].timer.$delete({ param: { id } });
    if (!res.ok) {
      setTimerError('Could not stop the timer.');
      return;
    }
    const { minutes } = await res.json();
    setDuration((Math.round((minutes / 60) * 100) / 100).toFixed(2));
    // Show where the stop put its value. ONCE, as a plain state change rather
    // than a rule — the user can move straight off it again, which is exactly
    // what web's version got wrong by expressing the same intent as an override.
    setLogMode('duration');
    await load();
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
        <ActivityIndicator className="text-ink" />
      </SafeAreaView>
    );
  }

  if (failed || !job) {
    return (
      <SafeAreaView className="flex-1 bg-cream px-6 pt-6" edges={['top']}>
        <Pressable onPress={() => router.back()}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
            ← Jobs
          </Text>
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
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              ← Jobs
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">{job.name}</Text>
          {/*
            The customer is asked for at create, so it has to show back here —
            not showing it reads as "that field did nothing".
          */}
          {job.contactName ? (
            <Text className="mt-1 text-sm text-ink-subtle">for {job.contactName}</Text>
          ) : null}

          <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-5">
            {/*
              Ready to bill leads on a phone too, and gets the big type: it is the
              only number here you act on — the rest are history.
            */}
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
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
            <Text className="mt-1 text-xs text-ink-subtle">
              {unratedMinutes > 0
                ? `${hours(unratedMinutes)} h needs a rate`
                : Number(readyToBill) > 0
                  ? 'not on an invoice yet'
                  : 'nothing waiting'}
            </Text>

            <View className="mt-5 flex-row justify-between border-t border-ink/10 pt-4">
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Billed
                </Text>
                <Text className="mt-1 font-mono text-lg text-ink/80">{fmt(job.margin.billed)}</Text>
                {/* Written but not sent (TMC-202) — rendered only when there is
                    one, since a row of three figures has no space to spare and
                    "$0.00 drafted" is noise on the usual send-it-now path. */}
                {Number(job.margin.drafted) > 0 && (
                  <Text className="mt-1 font-mono text-[10px] text-ink-subtle">
                    +{fmt(job.margin.drafted)} drafted
                  </Text>
                )}
              </View>
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Cost
                </Text>
                <Text className="mt-1 font-mono text-lg text-ink/80">{fmt(job.margin.costs)}</Text>
              </View>
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  Made
                </Text>
                {/* A dash until something is billed, matching Per hour beside
                    it. `billed - costs` with nothing billed is the negative of
                    the costs — a loss the job never took (TMC-203). */}
                <Text className="mt-1 font-mono text-lg text-ink">
                  {job.margin.made === null ? '—' : fmt(job.margin.made)}
                </Text>
              </View>
              <View>
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
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
            <Text className="mt-3 text-xs text-ink-subtle">
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
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
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
                  <Text className="text-sm text-ink-muted">Keep it open</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <Text className="mt-10 font-serif text-2xl font-light text-ink">Invoices</Text>
          {job.invoices.length === 0 ? (
            <Text className="mt-2 text-sm text-ink-subtle">
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
                  <Text className="font-mono text-xs text-ink-subtle">{inv.number}</Text>
                  <Text className="text-sm text-ink-subtle">{inv.issueDate}</Text>
                  <Text className="font-mono text-sm text-ink/80">{fmt(inv.total)}</Text>
                </Pressable>
              ))}
            </View>
          )}

          <Text className="mt-10 font-serif text-2xl font-light text-ink">{workHeading}</Text>

          {canWrite ? (
            <View className="mt-3">
              {/*
                HOW THIS JOB BILLS (TMC-264). Mobile could read the unit but had
                no way to set it, so every job on a phone was stuck by-the-hour
                and the feature was unreachable without opening the web app.

                Web puts this in the page header beside Close job. Here it sits
                with the entry form instead: a phone header has no room for a
                fifth control, and this is the thing that decides what the field
                below is asking for, so it reads better next to it.
              */}
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                This job usually bills by the
              </Text>
              <View className="mt-2 flex-row flex-wrap gap-2">
                {BILLING_UNITS.map((u) => (
                  <Pressable
                    key={u}
                    onPress={() => changeBillingUnit(u)}
                    className={
                      billingUnit === u
                        ? 'rounded-sm border border-gold-deep px-3 py-1.5'
                        : 'rounded-sm border border-ink/15 px-3 py-1.5'
                    }
                  >
                    <Text
                      className={`font-mono text-xs uppercase tracking-widest ${
                        billingUnit === u ? 'text-gold-deep' : 'text-ink-subtle'
                      }`}
                    >
                      {u}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {unitError ? <Text className="mt-2 text-xs text-oxblood">{unitError}</Text> : null}

              {/*
                WHAT THIS LINE BILLS IN (TMC-264, revised).

                The unit began on the job, asked once and inherited. That holds
                for a lawn crew and breaks for the audience the feature was built
                for: a sitter charges a flat rate for a drop-in visit AND an
                hourly rate when she stays the afternoon, on one job for one
                customer.

                Per line, seeded from the job — which is why the job picker above
                survives. Answering it once still covers the common case; this row
                is the exception to it.
              */}
              <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                This line bills by the
              </Text>
              <View className="mt-2 flex-row flex-wrap items-center gap-2">
                {BILLING_UNITS.map((u) => (
                  <Pressable
                    key={u}
                    onPress={() => setLineUnit(u)}
                    className={
                      lineUnit === u
                        ? 'rounded-sm border border-gold-deep px-3 py-1.5'
                        : 'rounded-sm border border-ink/15 px-3 py-1.5'
                    }
                  >
                    <Text
                      className={`font-mono text-xs uppercase tracking-widest ${
                        lineUnit === u ? 'text-gold-deep' : 'text-ink-subtle'
                      }`}
                    >
                      {u}
                    </Text>
                  </Pressable>
                ))}
                {lineUnit === billingUnit ? null : (
                  <Pressable onPress={() => setLineUnit(billingUnit)} className="justify-center">
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle underline">
                      Reset
                    </Text>
                  </Pressable>
                )}
              </View>

              {/*
                ONE WAY IN AT A TIME, matching web. The duration box, the time
                card and the stopwatch used to be stacked and all visible, two of
                them writing the same field — so the form carried an implicit
                precedence nobody could see. Picking the mode makes them
                exclusive and the precedence disappears.
              */}
              <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
                How long?
              </Text>
              <View className="mt-2 flex-row flex-wrap gap-2">
                {LOG_MODES.map((m) => (
                  <Pressable
                    key={m.key}
                    onPress={() => setLogMode(m.key)}
                    className={
                      logMode === m.key
                        ? 'rounded-sm border border-gold-deep px-3 py-1.5'
                        : 'rounded-sm border border-ink/15 px-3 py-1.5'
                    }
                  >
                    <Text
                      className={`font-mono text-xs uppercase tracking-widest ${
                        logMode === m.key ? 'text-gold-deep' : 'text-ink-subtle'
                      }`}
                    >
                      {m.label}
                    </Text>
                  </Pressable>
                ))}
                {/*
                  Nothing forces the stopwatch view any more, so a timer could be
                  left running out of sight. This says it is still going and
                  jumps back to it.
                */}
                {timer && timer.jobId === id && logMode !== 'stopwatch' ? (
                  <Pressable onPress={() => setLogMode('stopwatch')} className="justify-center">
                    <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                      Timer · {elapsed}
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              <View className="mt-3 flex-row gap-2">
                {billsByHour ? null : (
                  /*
                    A per-visit, per-night or per-day job bills a COUNT, and the
                    count is what reaches the invoice. Always shown whatever the
                    mode: the mode picks how the DURATION is entered, and on
                    these jobs the duration is only optional context.
                  */
                  <TextInput
                    value={quantity}
                    onChangeText={setQuantity}
                    placeholder="1"
                    keyboardType="decimal-pad"
                    className="w-20 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
                  />
                )}
                {logMode === 'card' ? (
                  <>
                    {/*
                      Plain text rather than a native time picker: two pickers
                      would be four taps and a modal each, where the whole point
                      is that typing 8:15 beats working out 8.25.
                    */}
                    <TextInput
                      value={cardStart}
                      onChangeText={setCardStart}
                      placeholder="Started 08:15"
                      className="flex-1 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
                    />
                    <TextInput
                      value={cardEnd}
                      onChangeText={setCardEnd}
                      placeholder="Finished 16:30"
                      className="flex-1 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
                    />
                  </>
                ) : logMode === 'stopwatch' ? (
                  /*
                    THE STOPWATCH SITS IN THE ROW, where the duration field
                    would be, rather than in a separate disclosure underneath —
                    two controls for one number, visually unrelated, is the
                    disconnection the mode selector exists to end.
                  */
                  <View className="flex-1 flex-row items-center gap-3">
                    {timer && timer.jobId === id ? (
                      <>
                        <Text className="font-mono text-2xl text-gold-deep">{elapsed}</Text>
                        <Pressable
                          onPress={stopTimer}
                          className="rounded-sm border border-gold-deep px-4 py-2.5"
                        >
                          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                            Stop
                          </Text>
                        </Pressable>
                      </>
                    ) : timer ? (
                      <Pressable onPress={() => router.push(`/jobs/${timer.jobId}`)}>
                        <Text className="text-sm text-ink-muted">
                          Running on {timer.jobName} for {elapsed}. Stop it there first — only one
                          timer runs at a time, or the same minute gets billed to two customers.
                        </Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        onPress={startTimer}
                        className="rounded-sm border border-ink/25 px-4 py-2.5"
                      >
                        <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                          Start
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ) : (
                  <TextInput
                    value={duration}
                    onChangeText={setDuration}
                    // NAMES THE UNIT. Mobile has no field labels — placeholders
                    // are the labels here — so "Time spent" named neither the
                    // unit nor a format, and the placeholder vanishes the moment
                    // you type. Someone billing by the job typed 30 for half an
                    // hour and got thirty hours (owner report, 2026-08-23); web
                    // had a label to fix, mobile has only this.
                    placeholder={billsByHour ? 'Hours, like 3.25' : 'Hours (optional)'}
                    keyboardType="decimal-pad"
                    className="flex-1 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
                  />
                )}
              </View>

              {logMode === 'card' && cardSummary ? (
                /*
                  Shown live, before anything is submitted. That sighting IS the
                  confirm half of the owner's detect-and-confirm call on an
                  overnight shift: no modal, no second question.
                */
                <Text className="mt-1 text-sm text-ink-muted">{cardSummary}</Text>
              ) : null}
              {logMode === 'stopwatch' && timer && timer.jobId === id ? (
                <Text className="mt-1 text-xs text-ink-subtle">
                  Stopping fills in the hours — it doesn't log them.
                </Text>
              ) : null}

              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="What you did"
                maxLength={1000}
                className="mt-2 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
              />
              <TextInput
                value={rate}
                onChangeText={setRate}
                placeholder={`Rate per ${billingUnitLabel(billingUnit, '1')} — optional`}
                keyboardType="decimal-pad"
                className="mt-2 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
              />

              <View className="mt-2 flex-row items-center gap-3">
                <Pressable
                  onPress={logTime}
                  disabled={logging}
                  className="flex-1 items-center rounded-sm border border-ink/20 px-4 py-2.5 active:bg-cream-warm disabled:opacity-50"
                >
                  {logging ? (
                    <ActivityIndicator className="text-ink" />
                  ) : (
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">
                      Log
                    </Text>
                  )}
                </Pressable>
                {/*
                  Always rendered, disabled when empty, rather than appearing and
                  vanishing: a control that disappears the moment it works cannot
                  be told apart from one that did nothing.
                */}
                <Pressable
                  onPress={clearEntry}
                  disabled={!hasEntryInput}
                  className={hasEntryInput ? '' : 'opacity-40'}
                >
                  <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                    Clear
                  </Text>
                </Pressable>
              </View>
              {timeError ? <Text className="mt-2 text-xs text-oxblood">{timeError}</Text> : null}
              {timerError ? <Text className="mt-2 text-xs text-oxblood">{timerError}</Text> : null}
            </View>
          ) : null}

          {entries.length === 0 ? (
            <Text className="mt-4 text-sm text-ink-subtle">
              No hours logged against this job yet.
            </Text>
          ) : (
            <View className="mt-4 rounded-sm border border-ink/10 bg-cream-warm">
              {entries.map((entry, i) => (
                <View
                  key={entry.id}
                  className={`flex-row items-center justify-between px-5 py-3 ${
                    i > 0 ? 'border-t border-ink/10' : ''
                  }`}
                >
                  <Text className="w-24 text-sm text-ink-subtle">{entry.entryDate}</Text>
                  <Text className="w-20 font-mono text-sm text-ink/80">
                    {entryAmountLabel(entry, billingUnit)}
                  </Text>
                  <Text className="flex-1 pr-2 text-sm text-ink-muted" numberOfLines={1}>
                    {entry.note ?? ''}
                  </Text>
                  {/*
                    Silent when no rate was set — those hours still count toward
                    the job's time, and "$0.00/h" would look like a mistake.
                  */}
                  {entry.rate ? (
                    <Text className="pr-2 font-mono text-xs text-ink-subtle">
                      ${formatUnitPrice(entry.rate)}/
                      {billingUnitLabel(entryUnit(entry, billingUnit), '1')}
                    </Text>
                  ) : null}
                  {entry.billedInvoiceId ? (
                    <Text className="font-mono text-[0.6rem] uppercase tracking-widest text-ink-subtle">
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
