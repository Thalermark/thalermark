import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type AuditEvent, AuditHistory } from '../../../components/AuditHistory';
import { api } from '../../../lib/api';

// Account-wide activity feed — the native mirror of apps/web's
// /settings/activity (slice 8.8b). Pulls the unfiltered /api/audit-events
// (newest first, up to 100), which enriches each row with an `entityLabel`, and
// renders the feed-mode AuditHistory (tappable entity prefix → detail screen).
type FeedState =
  | { state: 'loading' }
  | { state: 'ready'; events: AuditEvent[] }
  | { state: 'error' };

export default function Activity() {
  const router = useRouter();
  const [feed, setFeed] = useState<FeedState>({ state: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api['audit-events']
        .$get({ query: { limit: '100' } })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setFeed({ state: 'error' });
            return;
          }
          setFeed({ state: 'ready', events: (await res.json()).events });
        })
        .catch(() => {
          if (active) setFeed({ state: 'error' });
        });
      return () => {
        active = false;
      };
    }, []),
  );

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/more')}
          className="font-mono text-xs uppercase tracking-widest text-ink/60"
        >
          ← More
        </Text>

        <Text className="mt-3 font-serif text-3xl font-light text-ink">Activity</Text>
        <Text className="mt-2 text-sm text-ink/60">
          Recent changes across your account. Newest first; up to the last 100 events.
        </Text>

        {feed.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : feed.state === 'error' ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load activity.</Text>
        ) : (
          <View className="mt-8">
            <AuditHistory events={feed.events} showEntity />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
