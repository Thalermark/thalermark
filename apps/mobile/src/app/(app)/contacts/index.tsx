import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MetricStrip } from '../../../components/MetricStrip';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Roster summary powering the metric strip (mirror of web). A contact can be
// both a customer and a vendor, so those slices overlap and don't sum to total.
type ContactSummary = {
  total: number;
  customers: number;
  vendors: number;
  withOpenInvoices: number;
};
type ContactRoleFilter = '' | 'customer' | 'vendor';

// Mirror of apps/web's /contacts list. Account-scoped via x-account-id (the
// API filters by accountId); keyset-paginated with onEndReached infinite scroll.
// usePaginatedList refetches page 1 on focus so a contact created on
// /contacts/new shows when we navigate back, and reloads whenever a filter
// flips (fetchPage identity changes). Filters: search (q, name OR email) and
// an "Open invoices" toggle (contacts with an issued-but-unpaid invoice).
type ContactRow = { id: string; name: string; email: string | null; archivedAt: string | null };

export default function ContactsList() {
  const router = useRouter();
  const canCreate = useMay('contacts:write');

  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [openInvoices, setOpenInvoices] = useState(false);
  const [role, setRole] = useState<ContactRoleFilter>('');
  const [summary, setSummary] = useState<ContactSummary | null>(null);
  // Archived contacts are hidden by default (TMC-232). The toggle is not
  // optional polish on mobile: archiving removes the row from this list, and
  // the detail screen is only reachable THROUGH this list — without a way back
  // in, archive would be a one-way door on a phone.
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Point-in-time roster summary for the strip; refreshed on focus. Best-effort.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.contacts.summary
        .$get({ query: {} })
        .then(async (res) => {
          if (active && res.ok) setSummary(await res.json());
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  const anyFilter = Boolean(appliedQ || openInvoices || role);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query: Record<string, string> = pageQuery(cursor);
      if (appliedQ) query.q = appliedQ;
      if (openInvoices) query.openInvoices = 'true';
      if (role) query.role = role;
      if (showArchived) query.includeArchived = 'true';
      const res = await api.api.contacts.$get({ query });
      if (!res.ok) return null;
      const { contacts, nextCursor } = await res.json();
      return {
        rows: contacts.map(
          (c): ContactRow => ({
            id: c.id,
            name: c.name,
            email: c.email ?? null,
            archivedAt: c.archivedAt ?? null,
          }),
        ),
        nextCursor,
      };
    },
    [appliedQ, openInvoices, role, showArchived],
  );

  const { list, loadingMore, loadMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-end justify-between px-6 pt-6">
        <View>
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            Contacts
          </Text>
          <Text className="mt-2 font-serif text-3xl font-light text-ink">All contacts</Text>
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push('/contacts/new')}
            className="rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">+ New</Text>
          </Pressable>
        ) : null}
      </View>

      {summary ? (
        <View className="mt-4 px-6">
          <MetricStrip
            tiles={[
              {
                label: 'Total',
                value: summary.total,
                onPress: () => {
                  setRole('');
                  setOpenInvoices(false);
                },
                active: !role && !openInvoices,
              },
              {
                label: 'Customers',
                value: summary.customers,
                onPress: () => {
                  setRole('customer');
                  setOpenInvoices(false);
                },
                active: role === 'customer',
              },
              {
                label: 'Vendors',
                value: summary.vendors,
                onPress: () => {
                  setRole('vendor');
                  setOpenInvoices(false);
                },
                active: role === 'vendor',
              },
              {
                label: 'With open invoices',
                value: summary.withOpenInvoices,
                onPress: () => {
                  setOpenInvoices(true);
                  setRole('');
                },
                active: openInvoices,
              },
            ]}
          />
        </View>
      ) : null}

      <View className="mt-4 flex-row items-center gap-2 px-6">
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search name or email"
          returnKeyType="search"
          className="flex-1 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
        />
        <Pressable
          onPress={() =>
            setOpenInvoices((v) => {
              if (!v) setRole('');
              return !v;
            })
          }
          className={`rounded-sm border px-3 py-2.5 ${
            openInvoices ? 'border-ink bg-ink' : 'border-ink/20 bg-cream-warm'
          }`}
        >
          <Text
            className={`font-mono text-xs uppercase tracking-widest ${
              openInvoices ? 'text-cream' : 'text-ink-subtle'
            }`}
          >
            Open
          </Text>
        </Pressable>
      </View>

      <Pressable onPress={() => setShowArchived((s) => !s)} className="mt-4 self-start px-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
          {showArchived ? '← Hide archived' : 'Show archived'}
        </Text>
      </Pressable>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator className="text-ink" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load contacts.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink-muted">
          {anyFilter ? 'No contacts match these filters.' : 'No contacts yet.'}
        </Text>
      ) : (
        <FlatList
          data={list.rows}
          keyExtractor={(c) => c.id}
          className="mt-6"
          contentContainerClassName="px-6 pb-6"
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View className="h-px bg-ink/10" />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View className="py-4">
                <ActivityIndicator className="text-ink" />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/contacts/${item.id}`)}
              className="flex-row items-center justify-between bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <View className="flex-1 flex-row flex-wrap items-center gap-2">
                <Text className="font-serif text-lg text-ink">{item.name}</Text>
                {item.archivedAt ? (
                  <Text className="rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink-subtle">
                    Archived
                  </Text>
                ) : null}
              </View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                {item.email ?? ''}
              </Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
