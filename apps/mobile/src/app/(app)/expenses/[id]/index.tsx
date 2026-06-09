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
import { api } from '../../../../lib/api';
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
};
type Receipt = { url: string; contentType: string };
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

const apiOrigin = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const absolutize = (url: string) => (url.startsWith('http') ? url : `${apiOrigin}${url}`);

export default function ExpenseDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [acting, setActing] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);

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
      },
    });
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
        await load();
      } else {
        setReceiptError('Could not apply the extracted details.');
      }
    } finally {
      setActing(false);
    }
  }

  function onRemoveReceipt() {
    Alert.alert('Remove receipt?', 'This detaches the receipt from the expense.', [
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
            </View>

            <View className="mt-8 space-y-3">
              <Row label="Date" value={e.expenseDate} />
              <Row label="Category" value={detail.categoryName ?? '—'} />
              <Row label="Paid with" value={detail.paymentName ?? '—'} />
              {e.memo ? <Row label="Memo" value={e.memo} /> : null}
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

                  {extraction ? (
                    <View className="mt-3 rounded-sm border border-gold-deep/30 bg-gold-deep/5 p-4">
                      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                        Found on the receipt
                      </Text>
                      <View className="mt-2 space-y-1">
                        <Row label="Merchant" value={extraction.merchant ?? '—'} />
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
                </View>
              ) : (
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
              )}

              {acting ? (
                <View className="mt-3 items-center">
                  <ActivityIndicator color="#0f1626" />
                </View>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
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
