import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../../components/AuditHistory';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';
import { getServerUrl } from '../../../../lib/server-url';
import { uploadReceipt } from '../../../../lib/upload';

// Expense detail + receipt capture/extraction (mirror of apps/web's
// /expenses/[id] receipt block). Attach a photo → view it → vision-extract →
// apply the suggested merchant/amount/date. Full field edit lands in M11b;
// category-suggest (AI) is deferred.
type Expense = {
  companyId: string;
  merchant: string;
  amount: string;
  expenseDate: string;
  memo: string | null;
  categoryAccountId: string;
  paymentAccountId: string;
  receiptStorageKey: string | null;
  vendorContactId: string | null;
  vendorReview: string | null;
};
type Receipt = { url: string; contentType: string };
// Job costing (TMC-174). A job is an issued invoice, labelled by customer so the
// option reads like the work the user remembers. `target` is the current answer:
// an invoice id, 'shared', or null for never-answered — shared being a real
// answer, not a skipped question.
type Job = { id: string; number: string; issueDate: string; customerName: string | null };
type Extraction = { merchant: string | null; total: string | null; expenseDate: string | null };
type DetailState =
  | { state: 'loading' }
  | {
      state: 'ready';
      expense: Expense;
      categoryName: string | null;
      paymentName: string | null;
      receipt: Receipt | null;
    }
  | { state: 'error' };

const RECEIPT_ERRORS: Record<string, string> = {
  storage_not_configured: "Receipts aren't configured on this server.",
  ai_not_configured: 'AI receipt extraction is not configured on this server.',
  file_too_large: 'That image is too large.',
  unsupported_media_type: 'Use a JPEG, PNG, or PDF.',
  no_receipt: 'Attach a receipt first.',
  extraction_failed: "Couldn't read that receipt. Try a clearer photo.",
};

const absolutize = (url: string) => (url.startsWith('http') ? url : `${getServerUrl()}${url}`);

export default function ExpenseDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [acting, setActing] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [namedJobs, setNamedJobs] = useState<{ id: string; name: string }[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [splitCount, setSplitCount] = useState(0);
  // TMC-178. Set when an extraction was just applied to an expense that still
  // has no job answer — the one moment the receipt path buries the question,
  // because attach → extract → apply all happen below it. Transient and
  // in-place: it replaces the extraction card rather than adding a second
  // chooser competing with the section above.
  const [askJobAfterApply, setAskJobAfterApply] = useState(false);

  const load = useCallback(async () => {
    const res = await api.api.expenses[':id'].$get({ param: { id } });
    if (!res.ok) {
      setDetail({ state: 'error' });
      return;
    }
    const e = await res.json();
    const accRes = await api.api.companies[':id'].accounts.$get({
      param: { id: e.companyId },
      query: { type: undefined },
    });
    let categoryName: string | null = null;
    let paymentName: string | null = null;
    if (accRes.ok) {
      const { accounts } = await accRes.json();
      categoryName = accounts.find((a) => a.id === e.categoryAccountId)?.name ?? null;
      paymentName = accounts.find((a) => a.id === e.paymentAccountId)?.name ?? null;
    }
    let receipt: Receipt | null = null;
    if (e.receiptStorageKey) {
      const rRes = await api.api.expenses[':id'].receipt.$get({ param: { id } });
      if (rRes.ok) {
        const r = await rRes.json();
        receipt = { url: absolutize(r.url), contentType: r.contentType };
      }
    }
    setDetail({
      state: 'ready',
      categoryName,
      paymentName,
      receipt,
      expense: {
        companyId: e.companyId,
        merchant: e.merchant,
        amount: e.amount,
        expenseDate: e.expenseDate,
        memo: e.memo ?? null,
        categoryAccountId: e.categoryAccountId,
        paymentAccountId: e.paymentAccountId,
        receiptStorageKey: e.receiptStorageKey ?? null,
        vendorContactId: e.vendorContactId ?? null,
        vendorReview: e.vendorReview ?? null,
      },
    });
    // Job costing (TMC-174) — the current answer plus the pick list. Both
    // best-effort: a failure hides the question rather than breaking the screen,
    // since this is a tag and nothing about the expense depends on it.
    const allocations = e.allocations ?? [];
    setSplitCount(allocations.length);
    // Since TMC-181 a row may instead name a job, carried as "job:<id>" so the
    // two grains share one picker without their ids ever colliding.
    const first = allocations[0];
    setTarget(
      allocations.length === 0 || !first
        ? null
        : first.jobId
          ? `job:${first.jobId}`
          : allocations.length === 1 && first.invoiceId === null
            ? 'shared'
            : (first.invoiceId ?? null),
    );
    try {
      const jobsRes = await api.api.invoices.$get({
        query: { companyId: e.companyId, limit: '50' },
      });
      if (jobsRes.ok) {
        setJobs(
          (await jobsRes.json()).invoices
            // Allowlist, not exclusions. The old form excluded 'void' while the
            // stored value is 'voided', so cancelled invoices were still offered
            // as something to tag a cost to.
            .filter((i) => i.status === 'sent' || i.status === 'paid')
            .map((i) => ({
              id: i.id,
              number: i.number,
              issueDate: i.issueDate,
              customerName: i.customerName ?? null,
            })),
        );
      }
      // Named jobs (TMC-181), offered above the invoices. Open ones only — a
      // closed job is filed away, and offering it is how the list stops being
      // usable on a phone.
      const namedRes = await api.api.jobs.$get({
        query: { companyId: e.companyId, status: 'open', limit: '50' },
      });
      if (namedRes.ok) {
        setNamedJobs((await namedRes.json()).jobs.map((j) => ({ id: j.id, name: j.name })));
      }
    } catch {}
    // Audit trail — best-effort; refetched on every load() (focus + after each
    // receipt upload/delete), so the history reflects the action just taken. A
    // failure here must not flip the whole screen to error, hence the swallow.
    try {
      const auditRes = await api.api['audit-events'].$get({
        query: { entityType: 'expense', entityId: id },
      });
      if (auditRes.ok) setAuditEvents((await auditRes.json()).events);
    } catch {}
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      load().catch(() => {
        if (active) setDetail({ state: 'error' });
      });
      return () => {
        active = false;
      };
    }, [load]),
  );

  // Role gate (UX only — the API is authoritative). Edit/duplicate/delete and
  // every receipt action (upload/extract/remove) are `expenses:write`.
  const canWrite = useMay('expenses:write');
  const e = detail.state === 'ready' ? detail.expense : null;
  const receipt = detail.state === 'ready' ? detail.receipt : null;

  async function pickAndUpload(source: 'camera' | 'library') {
    setReceiptError(null);
    const perm =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setReceiptError(source === 'camera' ? 'Camera permission denied.' : 'Photo access denied.');
      return;
    }
    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];

    setActing(true);
    try {
      const up = await uploadReceipt(id, asset);
      if (!up.ok) {
        setReceiptError(RECEIPT_ERRORS[up.error] ?? 'Upload failed. Try again.');
        return;
      }
      await load();
    } finally {
      setActing(false);
    }
  }

  async function onExtract() {
    setReceiptError(null);
    setActing(true);
    try {
      const res = await api.api.expenses[':id'].extract.$post({ param: { id } });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (body as { error?: string } | null)?.error ?? '';
        setReceiptError(RECEIPT_ERRORS[code] ?? 'Extraction failed.');
        return;
      }
      setExtraction((body as { extraction: Extraction }).extraction);
    } catch {
      setReceiptError('Extraction failed.');
    } finally {
      setActing(false);
    }
  }

  async function onApply() {
    if (!extraction) return;
    const json: { merchant?: string; amount?: string; expenseDate?: string } = {};
    if (extraction.merchant) json.merchant = extraction.merchant;
    if (extraction.total) json.amount = extraction.total;
    if (extraction.expenseDate) json.expenseDate = extraction.expenseDate;
    if (Object.keys(json).length === 0) {
      setExtraction(null);
      return;
    }
    setActing(true);
    try {
      const res = await api.api.expenses[':id'].$patch({ param: { id }, json });
      if (res.ok) {
        setExtraction(null);
        // Ask the job question here, in place, but only when it is still
        // unanswered — re-applying an extraction on an already-tagged expense
        // must not re-open a settled question.
        const untagged = target === null && splitCount === 0;
        await load();
        if (untagged) setAskJobAfterApply(true);
      } else {
        setReceiptError('Could not apply the extracted details.');
      }
    } finally {
      setActing(false);
    }
  }

  function onRemoveReceipt() {
    // "Detaches" understated it: the API deletes the stored object outright
    // (expenses.ts, DELETE /:id/receipt → storage.deleteObject), and receipt
    // images are not in the account export. If the paper is gone, so is the
    // substantiation (TMC-217).
    Alert.alert('Delete this receipt?', 'The image is deleted for good — this cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setActing(true);
          try {
            const res = await api.api.expenses[':id'].receipt.$delete({ param: { id } });
            if (res.ok) {
              setExtraction(null);
              await load();
            }
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  }

  // Job costing (TMC-174) — answer "what was this for?". Three answers: a job,
  // 'shared' (a real answer meaning "several jobs, don't ask me to split it"),
  // or null for not-sure-yet, which sends an empty set and clears it.
  //
  // Optimistic: the tap paints immediately and reloads behind it. This is a tag
  // with no ledger consequence, so a failed write costs an attribution and
  // nothing else — worth the responsiveness on a phone at a checkout counter.
  async function setAllocation(next: string | null) {
    const previous = target;
    setTarget(next);
    // Any answer — including "not sure yet" — closes the post-apply prompt.
    // It is asked once and never re-raised for that receipt.
    setAskJobAfterApply(false);
    // jobId is spelled out rather than omitted: a row names one grain or the
    // other, and the payload type requires the choice to be explicit. This
    // screen still tags at invoice grain — the job picker lands with the rest of
    // the mobile jobs UI.
    // A row names ONE grain. "job:<id>" is a named job; a bare id is an invoice
    // standing in as its own job; 'shared' is the deliberate won't-attribute
    // answer; null clears it back to never-answered, which is not the same.
    const allocations =
      next === null
        ? []
        : next.startsWith('job:')
          ? [{ invoiceId: null, jobId: next.slice(4), share: '1' }]
          : [{ invoiceId: next === 'shared' ? null : next, jobId: null, share: '1' }];
    try {
      const res = await api.api.expenses[':id'].allocations.$put({
        param: { id },
        json: { allocations },
      });
      if (!res.ok) {
        setTarget(previous);
        return;
      }
      await load();
    } catch {
      setTarget(previous);
    }
  }

  // Dismiss the needs-review flag without linking a vendor (clears it; creates
  // no contact). Reload so the banner + audit reflect it.
  async function onDismissReview() {
    setActing(true);
    try {
      const res = await api.api.expenses[':id']['dismiss-review'].$post({ param: { id } });
      if (res.ok) await load();
    } finally {
      setActing(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/expenses')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← Expenses
        </Text>

        {detail.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : detail.state === 'error' || !e ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load this expense.</Text>
        ) : (
          <>
            <View className="mt-3 flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="font-serif text-3xl font-light text-ink">{e.merchant}</Text>
                <Text className="mt-1 font-mono text-2xl tabular-nums text-ink">{e.amount}</Text>
              </View>
              {canWrite ? (
                <View className="mt-1 flex-row gap-2">
                  <Pressable
                    onPress={() => router.push(`/expenses/${id}/edit`)}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                      Edit
                    </Text>
                  </Pressable>
                  {/* Duplicate-as-template: prefill a fresh expense form from this
                      one. A client-side prefill (not a server clone) so it never
                      silently posts to the ledger — the user submits explicitly. */}
                  <Pressable
                    onPress={() => router.push(`/expenses/new?duplicate=${id}`)}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                      Duplicate
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            {e.vendorReview === 'needs_review' && canWrite ? (
              <View className="mt-6 rounded-sm border border-gold-deep/30 bg-gold-deep/5 px-4 py-3">
                <Text className="text-sm text-ink/80">
                  This expense has a receipt but no vendor linked yet.
                </Text>
                <View className="mt-3 flex-row gap-2">
                  <Pressable
                    onPress={() => router.push(`/expenses/${id}/edit`)}
                    className="rounded-sm border border-gold-deep/40 px-3 py-1.5 active:bg-gold-deep/10"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                      Link a vendor
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={onDismissReview}
                    disabled={acting}
                    className="rounded-sm border border-ink/20 px-3 py-1.5 active:bg-ink/5 disabled:opacity-50"
                  >
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                      Dismiss
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View className="mt-8 space-y-3">
              <Row label="Date" value={e.expenseDate} />
              <Row label="Category" value={detail.categoryName ?? '—'} />
              <Row label="Paid with" value={detail.paymentName ?? '—'} />
              {e.memo ? <Row label="Memo" value={e.memo} /> : null}
            </View>

            {/*
              The one new question (TMC-174). Tap-to-answer rather than a
              picker-and-save: one tap ends it. "Shared across jobs" sits at the
              top as a first-class answer — it means "several jobs, don't ask me
              to split it" — and choosing it never opens a follow-up.
            */}
            <View className="mt-8">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                What was this for?
              </Text>
              {splitCount > 1 ? (
                <Text className="mt-3 text-sm text-ink/70">
                  Split across {splitCount} jobs. Editing that split isn't here yet.
                </Text>
              ) : canWrite ? (
                <View className="mt-3 gap-2">
                  <JobChoice
                    label="Shared across jobs"
                    selected={target === 'shared'}
                    onPress={() => setAllocation('shared')}
                  />
                  {/*
                    Named jobs first: if the user bothered to name one, that is
                    the answer they are looking for. Invoices stay below as the
                    fallback for work that never got a job.
                  */}
                  {namedJobs.map((job) => (
                    <JobChoice
                      key={job.id}
                      label={job.name}
                      selected={target === `job:${job.id}`}
                      onPress={() => setAllocation(`job:${job.id}`)}
                    />
                  ))}
                  {jobs.map((job) => (
                    <JobChoice
                      key={job.id}
                      label={`${job.customerName ?? 'No name'} · ${job.number}`}
                      selected={target === job.id}
                      onPress={() => setAllocation(job.id)}
                    />
                  ))}
                  <JobChoice
                    label="Not sure yet"
                    selected={target === null}
                    onPress={() => setAllocation(null)}
                  />
                  <Text className="mt-1 text-xs text-ink/50">
                    Tagging a job lets us tell you what that job made. It changes nothing about your
                    books or your taxes.
                  </Text>
                </View>
              ) : (
                <Text className="mt-3 text-sm text-ink/50">
                  {target === 'shared'
                    ? 'Shared across jobs.'
                    : target?.startsWith('job:')
                      ? (namedJobs.find((j) => `job:${j.id}` === target)?.name ?? 'A job')
                      : target
                        ? (jobs.find((j) => j.id === target)?.customerName ?? 'A job')
                        : 'Not tagged to a job.'}
                </Text>
              )}
            </View>

            {/* Receipt section */}
            <View className="mt-10">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Receipt
              </Text>

              {receiptError ? (
                <View className="mt-3 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
                  <Text className="text-sm text-oxblood">{receiptError}</Text>
                </View>
              ) : null}

              {receipt ? (
                <View className="mt-3">
                  {receipt.contentType.startsWith('image/') ? (
                    <Image
                      source={{ uri: receipt.url }}
                      className="h-64 w-full rounded-sm border border-ink/10 bg-cream-warm"
                      resizeMode="contain"
                    />
                  ) : (
                    <Pressable
                      onPress={() => Linking.openURL(receipt.url)}
                      className="rounded-sm border border-ink/15 bg-cream-warm px-4 py-3"
                    >
                      <Text className="text-gold-deep">View receipt (PDF) →</Text>
                    </Pressable>
                  )}

                  {canWrite ? (
                    <View className="mt-3 flex-row gap-2">
                      <Pressable
                        onPress={onExtract}
                        disabled={acting}
                        className="flex-1 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                      >
                        <Text className="text-center text-sm font-medium text-cream">
                          Auto-fill from receipt
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={onRemoveReceipt}
                        disabled={acting}
                        className="rounded-sm border border-oxblood/30 px-3 py-3 active:bg-oxblood/5 disabled:opacity-50"
                      >
                        <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
                          Remove
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}

                  {extraction ? (
                    <View className="mt-3 rounded-sm border border-gold-deep/30 bg-gold-deep/5 p-4">
                      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                        Found on the receipt
                      </Text>
                      <View className="mt-2 space-y-1">
                        <Row label="Vendor" value={extraction.merchant ?? '—'} />
                        <Row label="Total" value={extraction.total ?? '—'} />
                        <Row label="Date" value={extraction.expenseDate ?? '—'} />
                      </View>
                      <View className="mt-3 flex-row gap-2">
                        <Pressable
                          onPress={onApply}
                          disabled={acting}
                          className="flex-1 rounded-sm bg-ink px-4 py-2 active:bg-gold-deep disabled:opacity-50"
                        >
                          <Text className="text-center text-sm font-medium text-cream">Apply</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => setExtraction(null)}
                          className="rounded-sm border border-ink/20 px-3 py-2 active:bg-ink/5"
                        >
                          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
                            Dismiss
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null}

                  {/*
                    TMC-178 — the receipt path's one gap. Attach → extract →
                    apply all happen below the job question, so by the time the
                    details land the user is three interactions deep and the
                    question is above him. Ask here instead, in the space the
                    extraction card just vacated.

                    Still not a nag: it appears once, only when the answer is
                    genuinely missing, and every option — including "not sure
                    yet" — closes it for good.
                  */}
                  {askJobAfterApply && canWrite ? (
                    <View className="mt-3 rounded-sm border border-ink/15 bg-cream-warm p-4">
                      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                        Saved. What was this for?
                      </Text>
                      <View className="mt-3 gap-2">
                        <JobChoice
                          label="Shared across jobs"
                          selected={false}
                          onPress={() => setAllocation('shared')}
                        />
                        {jobs.slice(0, 5).map((job) => (
                          <JobChoice
                            key={job.id}
                            label={`${job.customerName ?? 'No name'} · ${job.number}`}
                            selected={false}
                            onPress={() => setAllocation(job.id)}
                          />
                        ))}
                        <Pressable onPress={() => setAskJobAfterApply(false)} className="pt-1">
                          <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                            Not sure yet
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : canWrite ? (
                <View className="mt-3 flex-row gap-2">
                  <Pressable
                    onPress={() => pickAndUpload('camera')}
                    disabled={acting}
                    className="flex-1 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
                  >
                    <Text className="text-center text-sm font-medium text-cream">Take photo</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => pickAndUpload('library')}
                    disabled={acting}
                    className="flex-1 rounded-sm border border-ink/20 px-4 py-3 active:bg-ink/5 disabled:opacity-50"
                  >
                    <Text className="text-center text-sm font-medium text-ink">Choose photo</Text>
                  </Pressable>
                </View>
              ) : (
                <Text className="mt-3 text-sm text-ink/50">No receipt attached.</Text>
              )}

              {acting ? (
                <View className="mt-3 items-center">
                  <ActivityIndicator color="#0f1626" />
                </View>
              ) : null}
            </View>

            <AuditHistory events={auditEvents} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function JobChoice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded border px-3 py-2 ${selected ? 'border-ink bg-ink/5' : 'border-ink/15'}`}
    >
      <Text className={`text-sm ${selected ? 'font-medium text-ink' : 'text-ink/70'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <Text className="text-ink">{value}</Text>
    </View>
  );
}
