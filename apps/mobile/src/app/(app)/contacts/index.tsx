import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { pageQuery, usePaginatedList } from '../../../lib/use-paginated-list';

// Mirror of apps/web's /contacts list. Account-scoped via x-account-id (the
// API filters by accountId); keyset-paginated with onEndReached infinite scroll.
// usePaginatedList refetches page 1 on focus so a contact created on
// /contacts/new shows when we navigate back, and reloads whenever a filter
// flips (fetchPage identity changes). Filters: search (q, name OR email) and
// an "Open invoices" toggle (contacts with an issued-but-unpaid invoice).
type ContactRow = { id: string; name: string; email: string | null };

export default function ContactsList() {
  const router = useRouter();
  const canCreate = useMay('contacts:write');

  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [openInvoices, setOpenInvoices] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const anyFilter = Boolean(appliedQ || openInvoices);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const query: Record<string, string> = pageQuery(cursor);
      if (appliedQ) query.q = appliedQ;
      if (openInvoices) query.openInvoices = 'true';
      const res = await api.api.contacts.$get({ query });
      if (!res.ok) return null;
      const { contacts, nextCursor } = await res.json();
      return {
        rows: contacts.map((c): ContactRow => ({ id: c.id, name: c.name, email: c.email ?? null })),
        nextCursor,
      };
    },
    [appliedQ, openInvoices],
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

      <View className="mt-4 flex-row items-center gap-2 px-6">
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search name or email"
          returnKeyType="search"
          className="flex-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5 text-ink"
        />
        <Pressable
          onPress={() => setOpenInvoices((v) => !v)}
          className={`rounded-sm border px-3 py-2.5 ${
            openInvoices ? 'border-ink bg-ink' : 'border-ink/20 bg-cream-warm'
          }`}
        >
          <Text
            className={`font-mono text-xs uppercase tracking-widest ${
              openInvoices ? 'text-cream' : 'text-ink/60'
            }`}
          >
            Open
          </Text>
        </Pressable>
      </View>

      {list.state === 'loading' ? (
        <View className="mt-12 items-center">
          <ActivityIndicator color="#0f1626" />
        </View>
      ) : list.state === 'error' ? (
        <Text className="mt-8 px-6 text-sm text-oxblood">Couldn't load contacts.</Text>
      ) : list.rows.length === 0 ? (
        <Text className="mt-8 px-6 text-ink/70">
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
                <ActivityIndicator color="#0f1626" />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/contacts/${item.id}`)}
              className="flex-row items-center justify-between bg-cream-warm px-5 py-4 active:bg-cream"
            >
              <Text className="font-serif text-lg text-ink">{item.name}</Text>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                {item.email ?? ''}
              </Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
