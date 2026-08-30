import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebOnlyNote } from '../../../../components/WebOnlyNote';
import { api } from '../../../../lib/api';
import { useMay } from '../../../../lib/role';
import { getActiveCompanyId, setActiveCompanyId } from '../../../../lib/secure-store';

// Which companies to render: everything still trading, plus the active one even
// when it's closed (the list must never disagree with the company whose figures
// are on screen), plus the rest only when asked for.
function visible(companies: Company[], activeId: string | null, showClosed: boolean): Company[] {
  if (showClosed) return companies;
  return companies.filter((c) => !c.retiredAt || c.id === activeId);
}

function closedCount(companies: Company[], activeId: string | null): number {
  return companies.filter((c) => c.retiredAt && c.id !== activeId).length;
}

// Company switcher — the mobile equivalent of web's UserMenu "Company" section.
// A workspace (account) can hold several companies; this picks which one every
// company-scoped screen works in (see lib/active-company.ts). Switching persists
// the choice and bounces home so the whole app re-scopes (Home + each tab's
// focus effect re-resolve the active company). Adding a company is gated by
// settings:manage, matching the API and the web "+ Add company" entry.
type Company = { id: string; name: string; retiredAt: string | null };
type State =
  | { state: 'loading' }
  | { state: 'ready'; companies: Company[]; activeId: string | null }
  | { state: 'error' };

export default function CompaniesScreen() {
  const router = useRouter();
  const canManage = useMay('settings:manage');
  const [screen, setScreen] = useState<State>({ state: 'loading' });
  // Businesses that have stopped trading stay switchable — their books have to
  // stay readable for years — but someone running one business shouldn't scroll
  // past every business they ever closed. Mirrors web's UserMenu.
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback((isActive: () => boolean) => {
    Promise.all([api.api.companies.$get(), getActiveCompanyId()])
      .then(async ([res, activeId]) => {
        if (!isActive()) return;
        if (!res.ok) {
          setScreen({ state: 'error' });
          return;
        }
        const { companies } = await res.json();
        setScreen({
          state: 'ready',
          companies: companies.map((c) => ({ id: c.id, name: c.name, retiredAt: c.retiredAt })),
          activeId,
        });
      })
      .catch(() => {
        if (isActive()) setScreen({ state: 'error' });
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      load(() => active);
      return () => {
        active = false;
      };
    }, [load]),
  );

  // The active company id is only stored once a pick is made; before then every
  // screen falls back to the first company STILL TRADING — matching
  // pickActiveCompany, so this list never marks a different company current than
  // the one the rest of the app is actually using.
  function isCurrent(company: Company, activeId: string | null, companies: Company[]): boolean {
    if (activeId) return company.id === activeId;
    const fallback = companies.find((c) => !c.retiredAt) ?? companies[0];
    return company.id === fallback?.id;
  }

  async function onPick(companyId: string) {
    await setActiveCompanyId(companyId);
    router.replace('/');
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
            ← More
          </Text>
        </Pressable>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Companies</Text>
        <Text className="mt-3 text-sm text-ink-subtle">
          Each company keeps its own books, invoices, and contacts. Pick which one to work in —
          everything re-scopes to your choice.
        </Text>

        {screen.state === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : screen.state === 'error' ? (
          <Text className="mt-8 text-sm text-oxblood">Couldn't load your companies.</Text>
        ) : (
          <>
            <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
              {visible(screen.companies, screen.activeId, showClosed).map((c, i) => {
                const current = isCurrent(c, screen.activeId, screen.companies);
                return (
                  <Pressable
                    key={c.id}
                    onPress={() => onPick(c.id)}
                    disabled={current}
                    className={`flex-row items-center justify-between px-5 py-4 active:bg-cream ${
                      i > 0 ? 'border-t border-ink/10' : ''
                    }`}
                  >
                    <View className="flex-1 pr-3">
                      <Text className="font-serif text-lg text-ink">{c.name}</Text>
                      {c.retiredAt ? (
                        <Text className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-subtle">
                          Closed
                        </Text>
                      ) : null}
                    </View>
                    {current ? (
                      <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                        Current
                      </Text>
                    ) : (
                      <Text className="rounded-sm bg-ink px-4 py-2 text-sm font-medium text-cream">
                        Switch
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>

            {closedCount(screen.companies, screen.activeId) > 0 ? (
              <Pressable onPress={() => setShowClosed(!showClosed)} className="mt-4 py-2">
                <Text className="text-sm text-ink-subtle">
                  {showClosed ? 'Hide' : 'Show'} closed (
                  {closedCount(screen.companies, screen.activeId)})
                </Text>
              </Pressable>
            ) : null}

            {canManage ? (
              <>
                <Pressable
                  onPress={() => router.push('/more/companies/new')}
                  className="mt-6 rounded-sm border border-gold-deep/40 px-5 py-4 active:bg-gold-deep/5"
                >
                  <Text className="text-sm font-medium text-gold-deep">+ Add a company</Text>
                  <Text className="mt-1 text-xs text-ink-subtle">
                    Run a second business out of this workspace — its books stay separate.
                  </Text>
                </Pressable>
                <View className="mt-4">
                  <WebOnlyNote
                    title="Becoming an LLC or a corporation"
                    reason="Moving a business to a new entity happens once, decides what the old books keep and what the new ones inherit, and is worth doing sitting down. It stays on the web app."
                  />
                </View>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
