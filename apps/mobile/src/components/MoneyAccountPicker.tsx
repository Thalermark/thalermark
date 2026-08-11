import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from '../lib/api';

// "Where did the money come from / go?" — one control for every mobile flow
// that moves money (TMC-207).
//
// Renders NOTHING when the company has a single account, which is the common
// case and the pre-TMC-207 behaviour: the caller then sends no account and the
// server takes its existing default path. So a one-account business sees no
// change anywhere, and this is not merely cosmetic — it is the same request the
// old screen made.
//
// Chips rather than a modal picker: there are rarely more than three or four
// accounts, and a tradesperson choosing "card or checking" on a phone should
// not have to open a sheet to do it.

export type MoneyAccountOption = {
  id: string;
  name: string;
  kind: string | null;
};

const KIND_LABEL: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
};

// Loads the company's money accounts once. Returns null until loaded so a
// caller can tell "still loading" from "only one account, nothing to ask".
export function useMoneyAccounts(companyId: string | null, allowCards = true) {
  const [accounts, setAccounts] = useState<MoneyAccountOption[] | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let active = true;
    api.api['money-accounts']
      .$get({ query: { companyId } })
      .then(async (res) => {
        if (!active || !res.ok) return;
        const { moneyAccounts } = await res.json();
        const rows = moneyAccounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind }));
        // Nothing is ever deposited INTO a credit card, so the money-in flows
        // pass false and get bank accounts only.
        setAccounts(allowCards ? rows : rows.filter((a) => a.kind !== 'credit_card'));
      })
      .catch(() => {
        // Best-effort: a failed load leaves the picker hidden and the caller
        // sends no account, which is the server's default. Better than blocking
        // someone from recording money because a list would not load.
        if (active) setAccounts([]);
      });
    return () => {
      active = false;
    };
  }, [companyId, allowCards]);

  return accounts;
}

export function MoneyAccountPicker({
  accounts,
  value,
  onChange,
  label = 'Paid from',
}: {
  accounts: MoneyAccountOption[] | null;
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
}) {
  if (!accounts || accounts.length < 2) return null;

  return (
    <View className="mt-4">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">{label}</Text>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {accounts.map((a) => {
          const selected = a.id === value;
          return (
            <Pressable
              key={a.id}
              onPress={() => onChange(a.id)}
              className={`rounded-sm border px-3 py-2 ${
                selected ? 'border-gold-deep bg-gold-deep/5' : 'border-ink/15 bg-cream-warm'
              }`}
            >
              <Text className="text-sm text-ink">{a.name}</Text>
              {a.kind ? (
                <Text className="text-[0.65rem] text-ink/50">{KIND_LABEL[a.kind] ?? ''}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
