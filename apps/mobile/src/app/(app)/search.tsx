import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../lib/active-company';
import { api } from '../../lib/api';
import { formatMoney, groupByType, hrefFor, useGlobalSearch } from '../../lib/global-search';

// Global search on mobile (TMC-198).
//
// A hidden route rather than a sixth tab: the bar was deliberately consolidated
// to five (M11f), and search is something you reach for rather than somewhere
// you live. Two doors in — the bar at the top of Home, and a row in the More
// hub — so it is discoverable without spending a tab.
//
// There is no shared mobile header (every screen renders its own under
// headerShown: false), which is why this is a screen with its own input rather
// than the web's expand-in-place header box.
export default function SearchScreen() {
  const router = useRouter();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const { text, onChangeText, results, loading, searching } = useGlobalSearch(companyId);

  // Resolve the active company once, so results are scoped to the business the
  // rest of the app is scoped to. Falls back to the whole workspace if it can't
  // be resolved — a wider search beats a broken one.
  const didBootstrap = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (didBootstrap.current) return;
      didBootstrap.current = true;
      let active = true;
      (async () => {
        const res = await api.api.companies.$get();
        if (!active || !res.ok) return;
        const { companies } = await res.json();
        const company = await pickActiveCompany(companies);
        if (company) setCompanyId(company.id);
      })().catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  const groups = groupByType(results);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <View className="flex-row items-center gap-3 px-6 pt-6">
        <Pressable onPress={() => router.back()} className="-ml-2 p-2" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={22} className="text-ink" />
        </Pressable>
        <TextInput
          value={text}
          onChangeText={onChangeText}
          placeholder="Search invoices, contacts, expenses…"
          placeholderClassName="text-ink-subtle"
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          maxLength={200}
          className="flex-1 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
        />
      </View>

      <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
        {!searching ? (
          <Text className="text-sm text-ink-subtle">
            Type anything — a customer's name, an invoice number, an amount, a note on a receipt.
          </Text>
        ) : loading ? (
          <ActivityIndicator className="text-gold-deep" />
        ) : results.length === 0 ? (
          <Text className="text-sm text-ink-subtle">
            Nothing matched “{text.trim()}”. Search covers invoices, estimates, contacts, expenses,
            bills and jobs — names, numbers, amounts and notes.
          </Text>
        ) : (
          groups.map((group) => (
            <View key={group.type} className="mb-8">
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                {group.label}
              </Text>
              <View className="mt-2 overflow-hidden rounded-sm border border-ink/15">
                {group.items.map((hit) => {
                  const href = hrefFor(hit.entityType, hit.entityId);
                  return (
                    <Pressable
                      key={`${hit.entityType}:${hit.entityId}`}
                      disabled={href === null}
                      onPress={() => {
                        if (href) router.push(href as never);
                      }}
                      className="border-b border-ink/10 px-3 py-3 active:bg-gold-deep/10"
                    >
                      <View className="flex-row items-baseline justify-between gap-3">
                        <Text className="flex-1 text-ink" numberOfLines={1}>
                          {hit.title}
                          {hit.subtitle ? (
                            <Text className="text-ink-subtle"> · {hit.subtitle}</Text>
                          ) : null}
                        </Text>
                        {hit.amount ? (
                          <Text className="font-mono text-xs text-ink-muted">
                            {formatMoney(hit.amount)}
                          </Text>
                        ) : null}
                      </View>
                      {hit.status || hit.occurredOn ? (
                        <View className="mt-1 flex-row items-center gap-3">
                          {hit.status ? (
                            <Text className="font-mono text-[10px] uppercase tracking-widest text-ink-subtle">
                              {hit.status}
                            </Text>
                          ) : null}
                          {hit.occurredOn ? (
                            <Text className="font-mono text-[10px] text-ink-subtle">
                              {hit.occurredOn}
                            </Text>
                          ) : null}
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
