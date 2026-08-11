import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';

// Mirror of apps/web's /settings/accounts (TMC-207) — the places this business's
// money sits.
//
// The user adds the bank account and card they actually have. That these become
// chart-of-accounts rows, and that a card is a liability while checking is an
// asset, is the system's business and appears nowhere on this screen.
//
// Not paginated: the endpoint returns the whole (small) set, because every
// picker in the app reads the same list and a cursor would buy nothing.

type MoneyAccount = {
  id: string;
  code: string;
  name: string;
  kind: string | null;
  isActive: boolean;
  balance: string;
};

type Kind = 'checking' | 'savings' | 'cash' | 'credit_card';

// The words the user picks between. Never "asset" or "liability" — those are
// what the system derives from this choice, not what anyone is asked.
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: 'checking', label: 'Checking', hint: 'A business current account' },
  { value: 'savings', label: 'Savings', hint: 'Money set aside' },
  { value: 'cash', label: 'Cash', hint: 'A till, a cash box, an envelope in the truck' },
  { value: 'credit_card', label: 'Credit card', hint: 'Spend now, pay the statement later' },
];

const KIND_LABEL: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
};

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// A card's stored balance is credit-normal, so it comes back negative when money
// is owed. Owing $150 reads as "$150 owed", never "-$150".
function balanceLabel(kind: string | null, balance: string): string {
  const n = Number(balance);
  if (kind === 'credit_card') {
    return n === 0 ? 'Nothing owed' : `${fmt(Math.abs(n).toFixed(2))} owed`;
  }
  return fmt(balance);
}

export default function AccountsScreen() {
  const router = useRouter();
  const canManage = useMay('settings:manage');
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<MoneyAccount[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<Kind>('checking');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const load = useCallback(
    async (active: () => boolean) => {
      const compRes = await api.api.companies.$get().catch(() => null);
      if (!active() || !compRes?.ok) return;
      const { companies } = await compRes.json();
      const id = (await pickActiveCompany(companies))?.id ?? null;
      if (!active()) return;
      setCompanyId(id);
      if (!id) {
        setAccounts([]);
        return;
      }
      const query: Record<string, string> = { companyId: id };
      if (showArchived) query.includeArchived = 'true';
      const res = await api.api['money-accounts'].$get({ query }).catch(() => null);
      if (!active()) return;
      setAccounts(res?.ok ? ((await res.json()).moneyAccounts as MoneyAccount[]) : []);
    },
    [showArchived],
  );

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load(() => alive);
      return () => {
        alive = false;
      };
    }, [load]),
  );

  async function create() {
    if (!companyId || newName.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.api['money-accounts'].$post({
        json: { companyId, name: newName.trim(), kind: newKind },
      });
      if (res.ok) {
        setNewName('');
        setAdding(false);
        await load(() => true);
      } else {
        setError("That account couldn't be added. Try again.");
      }
    } catch {
      setError("That account couldn't be added. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: string) {
    if (renameValue.trim().length === 0) return;
    setBusy(true);
    try {
      const res = await api.api['money-accounts'][':id'].$patch({
        param: { id },
        json: { name: renameValue.trim() },
      });
      if (res.ok) {
        setRenamingId(null);
        await load(() => true);
      }
    } catch {
      // A focus refetch will reconcile.
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(a: MoneyAccount) {
    setBusy(true);
    setError(null);
    try {
      const res = a.isActive
        ? await api.api['money-accounts'][':id'].archive.$post({ param: { id: a.id } })
        : await api.api['money-accounts'][':id'].restore.$post({ param: { id: a.id } });
      if (res.ok) {
        await load(() => true);
      } else if (res.status === 409) {
        // The primary is the fallback every unset money column resolves to.
        setError("That's your main account — it can't be archived.");
      }
    } catch {
      // A focus refetch will reconcile.
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← More</Text>
        </Pressable>

        <Text className="mt-3 font-serif text-3xl font-light text-ink">Accounts</Text>
        <Text className="mt-2 text-sm text-ink/60">
          Every place your money sits — the bank account you get paid into, the card you fill the
          truck with, the cash box.
        </Text>

        {error ? <Text className="mt-4 text-sm text-oxblood">{error}</Text> : null}

        {canManage && companyId ? (
          <Pressable
            onPress={() => setAdding((v) => !v)}
            className="mt-5 self-start rounded-sm bg-ink px-4 py-2 active:bg-gold-deep"
          >
            <Text className="text-sm font-medium text-cream">
              {adding ? 'Cancel' : '+ Add account'}
            </Text>
          </Pressable>
        ) : null}

        {adding ? (
          <View className="mt-4 rounded-sm border border-ink/15 bg-cream-warm p-4">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">Name</Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="Chase Business Checking"
              className="mt-2 rounded-sm border border-ink/15 bg-cream px-3 py-2.5 text-ink"
            />
            <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink/60">
              What kind of account is it?
            </Text>
            <View className="mt-2 gap-2">
              {KINDS.map((k) => (
                <Pressable
                  key={k.value}
                  onPress={() => setNewKind(k.value)}
                  className={`rounded-sm border px-3 py-2.5 ${
                    newKind === k.value
                      ? 'border-gold-deep bg-gold-deep/5'
                      : 'border-ink/15 bg-cream'
                  }`}
                >
                  <Text className="text-sm text-ink">{k.label}</Text>
                  <Text className="text-xs text-ink/50">{k.hint}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              onPress={create}
              disabled={busy || newName.trim().length === 0}
              className="mt-4 self-start rounded-sm bg-ink px-4 py-2 active:bg-gold-deep disabled:opacity-50"
            >
              <Text className="text-sm font-medium text-cream">Add account</Text>
            </Pressable>
            {/*
              No starting-balance field, matching web: two ways to inject a
              starting figure would be two sources of truth for the same equity.
            */}
            <Text className="mt-3 text-xs text-ink/50">
              Already got money in this account? Add it afterwards under My Money.
            </Text>
          </View>
        ) : null}

        <Pressable onPress={() => setShowArchived((s) => !s)} className="mt-5 self-start">
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
            {showArchived ? '← Hide archived' : 'Show archived'}
          </Text>
        </Pressable>

        {accounts === null ? (
          <View className="mt-10 items-center">
            <ActivityIndicator color="#0f1626" />
          </View>
        ) : accounts.length === 0 ? (
          <Text className="mt-8 text-ink/70">No accounts yet.</Text>
        ) : (
          <View className="mt-5 overflow-hidden rounded-sm border border-ink/10">
            {accounts.map((a, i) => (
              <View
                key={a.id}
                className={`bg-cream-warm px-4 py-4 ${i > 0 ? 'border-t border-ink/10' : ''}`}
              >
                {renamingId === a.id ? (
                  <View>
                    <TextInput
                      value={renameValue}
                      onChangeText={setRenameValue}
                      className="rounded-sm border border-ink/15 bg-cream px-3 py-2 text-ink"
                    />
                    <View className="mt-3 flex-row gap-2">
                      <Pressable
                        onPress={() => rename(a.id)}
                        disabled={busy}
                        className="rounded-sm bg-ink px-3 py-1.5 active:bg-gold-deep disabled:opacity-50"
                      >
                        <Text className="text-sm font-medium text-cream">Save</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setRenamingId(null)}
                        className="rounded-sm border border-ink/20 px-3 py-1.5"
                      >
                        <Text className="text-sm text-ink/70">Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View>
                    <View className="flex-row flex-wrap items-center gap-2">
                      <Text className="font-serif text-lg text-ink">{a.name}</Text>
                      {!a.isActive ? (
                        <Text className="rounded-sm border border-ink/15 px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-widest text-ink/50">
                          Archived
                        </Text>
                      ) : null}
                    </View>
                    <Text className="mt-0.5 text-xs text-ink/50">
                      {KIND_LABEL[a.kind ?? ''] ?? ''}
                    </Text>
                    <Text className="mt-1 font-mono text-sm text-ink/80">
                      {balanceLabel(a.kind, a.balance)}
                    </Text>
                    {canManage ? (
                      <View className="mt-3 flex-row gap-2">
                        <Pressable
                          onPress={() => {
                            setRenamingId(a.id);
                            setRenameValue(a.name);
                          }}
                          className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep"
                        >
                          <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                            Rename
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => toggleArchive(a)}
                          disabled={busy}
                          className="rounded-sm border border-ink/20 px-3 py-1.5 active:border-gold-deep disabled:opacity-50"
                        >
                          <Text className="font-mono text-xs uppercase tracking-widest text-ink/70">
                            {a.isActive ? 'Archive' : 'Restore'}
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {accounts && accounts.length > 0 ? (
          <Text className="mt-4 text-xs text-ink/50">
            Archiving takes an account out of the pickers. It stays on your books with whatever
            balance it holds — nothing you've already recorded changes.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
