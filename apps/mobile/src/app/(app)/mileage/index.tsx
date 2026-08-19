import { mileageValue, standardMileageRateFor } from '@thalermark/validation';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /mileage. THE primary surface for this feature — mileage
// is logged in a truck, not at a desk, so the form is the first thing on screen
// and pre-fills everything it can.
//
// Nothing here posts to the ledger. See the header on
// packages/db/src/schema/mileage_trips.ts.
type TripRow = {
  id: string;
  tripDate: string;
  miles: string;
  purpose: string;
  vehicleId: string | null;
};

// Schedule C Part IV is a per-vehicle disclosure. The phone picks a vehicle;
// the Part IV answers themselves are answered on the web, where year-end work
// happens.
type VehicleRow = { id: string; label: string };

type MileageSummary = {
  year: number;
  tripCount: number;
  miles: string;
  amount: string;
  unratedMiles: string;
};

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
// Stored at 4dp so valuation multiplies exactly; nobody wants to read "24.5000".
const showMiles = (s: string) => Number(s).toLocaleString('en-US', { maximumFractionDigits: 1 });

export default function MileageList() {
  const canWrite = useMay('expenses:write');
  const today = new Date().toISOString().slice(0, 10);

  // Same active-company resolution every company-scoped mobile screen does —
  // RLS pins the account, never the company, so the id has to be sent.
  const [companyId, setCompanyId] = useState<string | null>(null);

  const [tripDate, setTripDate] = useState(today);
  const [miles, setMiles] = useState('');
  const [purpose, setPurpose] = useState('');
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<MileageSummary | null>(null);

  const fetchPage = useCallback(async (cursor: string | null) => {
    const query: Record<string, string> = pageQuery(cursor);
    const res = await api.api['mileage-trips'].$get({ query });
    if (!res.ok) return null;
    const { trips, nextCursor } = await res.json();
    return {
      rows: trips.map(
        (t): TripRow => ({
          id: t.id,
          tripDate: t.tripDate,
          miles: t.miles,
          purpose: t.purpose,
          vehicleId: t.vehicleId,
        }),
      ),
      nextCursor,
    };
  }, []);

  const { list, loadingMore, loadMore, reload } = usePaginatedList(fetchPage);

  const refreshSummary = useCallback((id: string | null) => {
    if (!id) return;
    api.api.companies[':id'].mileage
      .$get({ param: { id }, query: { year: String(new Date().getFullYear()) } })
      .then(async (res) => {
        if (res.ok) setSummary((await res.json()) as MileageSummary);
      })
      .catch(() => {});
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const res = await api.api.companies.$get();
        if (!active || !res.ok) return;
        const { companies } = await res.json();
        const company = await pickActiveCompany(companies);
        if (!active) return;
        setCompanyId(company?.id ?? null);
        refreshSummary(company?.id ?? null);
        if (!company) return;
        const vRes = await api.api.vehicles.$get({ query: { companyId: company.id } });
        if (!active || !vRes.ok) return;
        const rows = (await vRes.json()).vehicles as VehicleRow[];
        setVehicles(rows);
        // One truck is the common case — preselect it rather than making the
        // driver tap it every time.
        setVehicleId((prev) => prev ?? (rows.length === 1 ? (rows[0]?.id ?? null) : null));
      })().catch(() => {});
      return () => {
        active = false;
      };
    }, [refreshSummary]),
  );

  async function log(values: {
    tripDate: string;
    miles: string;
    purpose: string;
    vehicleId: string | null;
  }) {
    if (!companyId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.api['mileage-trips'].$post({
        json: {
          companyId,
          tripDate: values.tripDate,
          miles: values.miles,
          purpose: values.purpose,
          ...(values.vehicleId ? { vehicleId: values.vehicleId } : {}),
        },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(errorMessage(body?.error));
        return;
      }
      setMiles('');
      setPurpose('');
      setTripDate(today);
      reload();
      refreshSummary(companyId);
    } catch {
      setError("Couldn't save that trip.");
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = miles.trim() !== '' && purpose.trim() !== '' && !saving;
  const todayRate = standardMileageRateFor(today);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <FlatList
        data={list.state === 'ready' ? list.rows : []}
        keyExtractor={(t) => t.id}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View className="px-6 pt-6">
            <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
              Mileage
            </Text>
            {/*
              DOLLARS in the heading, not miles. Miles are the input; what the
              user wants to know is what the driving is worth.
            */}
            <Text className="mt-2 font-serif text-3xl font-light text-ink">
              {summary ? fmt(summary.amount) : '—'}
            </Text>
            {summary ? (
              <Text className="mt-1 text-sm text-ink-subtle">
                {showMiles(summary.miles)} miles in {summary.year}
              </Text>
            ) : null}

            {summary && Number(summary.unratedMiles) > 0 ? (
              <Text className="mt-3 text-sm text-ink-muted">
                {showMiles(summary.unratedMiles)} miles are on dates the IRS hasn't set a rate for
                yet, so they're not counted above.
              </Text>
            ) : null}

            {canWrite ? (
              <View className="mt-6 rounded-sm border border-ink/15 bg-white p-4">
                <TextInput
                  value={tripDate}
                  onChangeText={setTripDate}
                  placeholder="YYYY-MM-DD"
                  autoCapitalize="none"
                  className="rounded-sm border border-field px-3 py-2 text-ink"
                />
                <TextInput
                  value={miles}
                  onChangeText={setMiles}
                  placeholder="Miles, e.g. 24.5"
                  keyboardType="decimal-pad"
                  className="mt-3 rounded-sm border border-field px-3 py-2 text-ink"
                />
                <TextInput
                  value={purpose}
                  onChangeText={setPurpose}
                  placeholder="What for, e.g. Drove to the Miller place"
                  className="mt-3 rounded-sm border border-field px-3 py-2 text-ink"
                />
                {/* Chips rather than a native picker: a workspace has one or two
                    vehicles, and a modal for two options is friction in a truck.
                    Vehicles are added on the web, alongside the Part IV answers
                    they exist to carry. */}
                {vehicles.length > 0 ? (
                  <View className="mt-3 flex-row flex-wrap gap-2">
                    {vehicles.map((v) => (
                      <Pressable
                        key={v.id}
                        onPress={() => setVehicleId(vehicleId === v.id ? null : v.id)}
                        className={`rounded-sm border px-3 py-2 ${
                          vehicleId === v.id ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15'
                        }`}
                      >
                        <Text className="text-sm text-ink">{v.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <Pressable
                  disabled={!canSubmit}
                  onPress={() => log({ tripDate, miles, purpose, vehicleId })}
                  className={`mt-4 rounded-sm px-4 py-3 ${canSubmit ? 'bg-ink active:bg-gold-deep' : 'bg-ink/30'}`}
                >
                  <Text className="text-center text-sm font-medium text-cream">
                    {saving ? 'Saving…' : 'Log trip'}
                  </Text>
                </Pressable>
                {error ? <Text className="mt-3 text-sm text-red-700">{error}</Text> : null}
                {todayRate ? (
                  <Text className="mt-3 text-xs text-ink-subtle">
                    Today's rate is {Number(todayRate).toFixed(3).replace(/0$/, '')} per mile.
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const value = mileageValue(item.miles, item.tripDate);
          return (
            <View className="mx-6 mt-3 flex-row items-center justify-between rounded-sm border border-ink/10 bg-white px-4 py-3">
              <View className="mr-3 flex-1">
                <Text className="font-serif text-lg text-ink">{item.purpose}</Text>
                <Text className="mt-1 text-xs text-ink-subtle">
                  {item.tripDate} · {showMiles(item.miles)} miles
                  {vehicles.find((v) => v.id === item.vehicleId)?.label
                    ? ` · ${vehicles.find((v) => v.id === item.vehicleId)?.label}`
                    : ''}
                </Text>
              </View>
              <View className="items-end">
                <Text className="font-mono text-ink">{value ? fmt(value) : 'no rate yet'}</Text>
                {canWrite ? (
                  // The frequent-route shortcut: the same drive, today.
                  <Pressable
                    onPress={() =>
                      log({
                        tripDate: today,
                        miles: item.miles,
                        purpose: item.purpose,
                        vehicleId: item.vehicleId,
                      })
                    }
                  >
                    <Text className="mt-1 text-xs text-gold-deep">Again</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          list.state === 'loading' ? (
            <ActivityIndicator className="mt-8" />
          ) : list.state === 'error' ? (
            <Text className="mt-8 px-6 text-ink-subtle">Couldn't load your trips.</Text>
          ) : (
            <Text className="mt-8 px-6 text-ink-subtle">No trips logged yet.</Text>
          )
        }
        ListFooterComponent={
          loadingMore ? <ActivityIndicator className="my-6" /> : <View className="h-8" />
        }
      />
    </SafeAreaView>
  );
}

function errorMessage(code: string | undefined): string {
  if (code === 'period_closed') {
    return "That year's books are closed, so it can't take a new trip.";
  }
  if (code === 'company_retired') {
    return 'This business has been retired, so it no longer records new activity.';
  }
  return "Couldn't save that trip.";
}
