import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../../lib/api';
import { formatMoney } from '../../../../lib/global-search';

// Customer statement — native mirror of apps/web's /contacts/[id]/statement.
// A running account document: every charge and payment for one contact, with
// the balance carried down, plus the ability to email it to them.
//
// TWO DELIBERATE DIFFERENCES FROM WEB:
//   - No "Print / save PDF". Web calls window.print(); there is no equivalent
//     here, and the product ships no PDF generator (see root CLAUDE.md — the
//     runtime image carries no browser). Emailing is the send path on mobile.
//   - The table is rendered as rows of stacked text rather than a <table>, so a
//     five-column ledger stays readable at phone width.
//
// The send result has THREE outcomes, not two. `delivered: false` means the
// server accepted the request but has no email configured, so nothing actually
// reached the customer (TMC-212). Reporting that as "sent" would be a lie the
// user acts on, so it gets its own state.
type Statement = {
  statementDate: string;
  company: { name: string; businessAddress: string | null; businessPhone: string | null };
  customer: {
    id: string;
    name: string;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  };
  lines: {
    date: string;
    description: string;
    charge: string | null;
    payment: string | null;
    balance: string;
  }[];
  totalCharges: string;
  totalPayments: string;
  balanceDue: string;
};

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error' }
  | { kind: 'ready'; statement: Statement };

type SendResult =
  | { kind: 'sent'; to: string }
  | { kind: 'undelivered'; to: string }
  | { kind: 'error'; message: string };

function sendErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'invalid_recipient':
      return "No valid email. Add the contact's email or type one above.";
    case 'email_not_configured':
      return "Email isn't configured on this server.";
    default:
      return 'Could not send the statement. Please try again.';
  }
}

export default function ContactStatement() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  const load = useCallback(async () => {
    const res = await api.api.contacts[':id'].statement.$get({ param: { id } });
    if (res.status === 404) return setState({ kind: 'missing' });
    if (!res.ok) return setState({ kind: 'error' });
    const statement = await res.json();
    setState({ kind: 'ready', statement });
    // Seed the recipient from the contact, but leave it editable so a statement
    // can go to a bookkeeper rather than the contact on file.
    setTo((prev) => prev || (statement.customer.email ?? ''));
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load().catch(() => {
        if (alive) setState({ kind: 'error' });
      });
      return () => {
        alive = false;
      };
    }, [load]),
  );

  async function onEmail() {
    setSending(true);
    setResult(null);
    try {
      const res = await api.api.contacts[':id'].statement.send.$post({
        param: { id },
        json: { to: to.trim() || undefined },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setResult({ kind: 'error', message: sendErrorMessage(body?.error) });
        return;
      }
      const body = (await res.json()) as { sentTo?: string; delivered?: boolean };
      const addr = body.sentTo ?? to.trim();
      setResult(
        body.delivered === false ? { kind: 'undelivered', to: addr } : { kind: 'sent', to: addr },
      );
    } catch {
      setResult({ kind: 'error', message: 'Could not send the statement. Please try again.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push(`/contacts/${id}`)}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← Contact
        </Text>

        {state.kind === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : state.kind === 'missing' ? (
          <Text className="mt-8 text-sm text-ink-muted">That contact no longer exists.</Text>
        ) : state.kind === 'error' ? (
          <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
            <Text className="text-sm text-ink-muted">Couldn't load the statement.</Text>
            <Pressable onPress={() => void load()} className="mt-3 self-start">
              <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                Try again
              </Text>
            </Pressable>
          </View>
        ) : (
          <StatementBody
            s={state.statement}
            to={to}
            setTo={setTo}
            sending={sending}
            result={result}
            onEmail={onEmail}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatementBody({
  s,
  to,
  setTo,
  sending,
  result,
  onEmail,
}: {
  s: Statement;
  to: string;
  setTo: (v: string) => void;
  sending: boolean;
  result: SendResult | null;
  onEmail: () => void;
}) {
  const address = [
    s.customer.addressLine1,
    s.customer.addressLine2,
    [s.customer.city, s.customer.region, s.customer.postalCode].filter(Boolean).join(', ') || null,
    s.customer.country,
  ].filter((line): line is string => Boolean(line));

  return (
    <>
      <Text className="mt-3 font-serif text-3xl font-light text-ink">Statement</Text>

      <View className="mt-6 rounded-sm border border-ink/15 bg-cream-warm p-4">
        <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
          Email this statement to
        </Text>
        <TextInput
          value={to}
          onChangeText={setTo}
          placeholder="contact@email.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          className="mt-2 border-b border-field py-2 text-ink"
        />
        <View className="mt-4 flex-row items-center gap-3">
          <Pressable
            onPress={onEmail}
            disabled={sending}
            className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
          >
            <Text className="text-sm font-medium text-cream">Email statement</Text>
          </Pressable>
          {sending ? <ActivityIndicator className="text-ink" /> : null}
        </View>

        {result?.kind === 'undelivered' ? (
          <Text className="mt-4 text-sm text-ink">
            No email was delivered. This server has no email set up, so nothing reached {result.to}.
            Nothing was recorded as sent.
          </Text>
        ) : result?.kind === 'sent' ? (
          <Text className="mt-4 text-sm text-ink-muted">Statement emailed to {result.to}.</Text>
        ) : result?.kind === 'error' ? (
          <Text className="mt-4 text-sm text-oxblood">{result.message}</Text>
        ) : null}
      </View>

      <View className="mt-6 rounded-sm border border-ink/10 bg-cream-warm p-5">
        <Text className="font-serif text-xl text-ink">{s.company.name}</Text>
        {s.company.businessAddress ? (
          <Text className="mt-1 text-sm text-ink-muted">{s.company.businessAddress}</Text>
        ) : null}
        {s.company.businessPhone ? (
          <Text className="text-sm text-ink-muted">{s.company.businessPhone}</Text>
        ) : null}
        <Text className="mt-3 font-mono text-xs uppercase tracking-widest text-ink-subtle">
          {s.statementDate}
        </Text>

        <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink-subtle">To</Text>
        <Text className="mt-1 font-serif text-lg text-ink">{s.customer.name}</Text>
        {s.customer.email ? (
          <Text className="text-sm text-ink-muted">{s.customer.email}</Text>
        ) : null}
        {address.map((line) => (
          <Text key={line} className="text-sm text-ink-muted">
            {line}
          </Text>
        ))}
      </View>

      {s.lines.length === 0 ? (
        <Text className="mt-8 text-sm text-ink-muted">No invoices on file for this contact.</Text>
      ) : (
        <View className="mt-6">
          {s.lines.map((line, i) => (
            // Statement lines have no id of their own — they are a computed
            // running ledger, so position is the identity. Same as web's `(i)`.
            // biome-ignore lint/suspicious/noArrayIndexKey: computed ledger rows, no stable id
            <View key={i} className="mt-3 rounded-sm border border-ink/10 bg-cream-warm p-4">
              <View className="flex-row items-start justify-between gap-3">
                <Text className="flex-1 text-ink">{line.description}</Text>
                <Text className="font-mono text-xs tabular-nums text-ink-subtle">{line.date}</Text>
              </View>
              <View className="mt-3 flex-row justify-between">
                {line.charge ? (
                  <Amount label="Charge" value={line.charge} />
                ) : (
                  <Amount label="Payment" value={line.payment ?? '0'} />
                )}
                <View className="items-end">
                  <Text className="font-mono text-[10px] uppercase tracking-widest text-ink-subtle">
                    Balance
                  </Text>
                  <Text className="mt-1 font-mono text-sm tabular-nums text-ink">
                    {formatMoney(line.balance)}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      )}

      <View className="mt-8 rounded-sm border-2 border-ink/15 bg-cream-warm p-5">
        <Row label="Total invoiced" value={s.totalCharges} />
        <Row label="Total paid" value={s.totalPayments} />
        <View className="mt-3 flex-row items-center justify-between border-t border-ink/15 pt-3">
          <Text className="font-mono text-xs uppercase tracking-widest text-ink">Balance due</Text>
          <Text className="font-mono text-lg tabular-nums text-ink">
            {formatMoney(s.balanceDue)}
          </Text>
        </View>
      </View>
    </>
  );
}

function Amount({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="font-mono text-[10px] uppercase tracking-widest text-ink-subtle">
        {label}
      </Text>
      <Text className="mt-1 font-mono text-sm tabular-nums text-ink-muted">
        {formatMoney(value)}
      </Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="mt-1 flex-row items-center justify-between">
      <Text className="text-sm text-ink-muted">{label}</Text>
      <Text className="font-mono text-sm tabular-nums text-ink-muted">{formatMoney(value)}</Text>
    </View>
  );
}
