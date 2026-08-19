import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../components/AuditHistory';
import { api } from '../../../lib/api';
import { usePaginatedList } from '../../../lib/use-paginated-list';

// Account-wide activity feed — the native mirror of apps/web's
// /settings/activity. Pulls the unfiltered /api/audit-events (newest first,
// 50/page, keyset cursor), which enriches each row with an `entityLabel`, and
// renders the feed-mode AuditHistory (tappable entity prefix → detail screen).
// AuditHistory renders the events as one block, so this uses a "Load more"
// button (like web) rather than FlatList onEndReached.

export default function Activity() {
  const router = useRouter();

  const fetchPage = useCallback(async (cursor: string | null) => {
    const query: Record<string, string> = { limit: '50' };
    if (cursor) query.cursor = cursor;
    const res = await api.api['audit-events'].$get({ query });
    if (!res.ok) return null;
    const { events, nextCursor } = await res.json();
    return { rows: events as AuditEvent[], nextCursor };
  }, []);

  const { list, loadingMore, loadMore, hasMore } = usePaginatedList(fetchPage);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/more')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← More
        </Text>

        <Text className="mt-3 font-serif text-3xl font-light text-ink">Activity</Text>
        <Text className="mt-2 text-sm text-ink-subtle">
          Recent changes across your workspace. Newest first.
        </Text>

        {list.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : list.state === 'error' ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load activity.</Text>
        ) : (
          <View className="mt-8">
            <AuditHistory events={list.rows} showEntity />
            {hasMore ? (
              <Pressable
                onPress={loadMore}
                disabled={loadingMore}
                className="mt-6 self-center rounded-sm border border-ink/15 px-4 py-2 active:border-gold-deep disabled:opacity-50"
              >
                <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
