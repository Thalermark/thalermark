import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';

// The Street field, doubling as an address type-ahead — the RN mirror of web's
// AddressLookup.svelte. The real field IS the search box (no confusing second
// input): typing queries GET /api/locations/autocomplete for predictions;
// picking one calls GET /api/locations/details to resolve the structured
// address, then fans it out to the city / region / postalCode / country fields
// the parent owns. A session token minted here threads through the autocomplete
// calls + the final details call so Google bills one session per address.
// Prefilling the parent's addressLine1 (edit form) does NOT trigger a search —
// only on-device typing (onChangeText) does.
export type AddressSuggestion = {
  label: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

type Prediction = { placeId: string; label: string };

const DEBOUNCE_MS = 250;
const MIN_QUERY = 3;

// Google's session token only needs to be unique per address entry (it's a
// billing correlation id, not a secret), so prefer a real UUID where the
// runtime has one and fall back to a cheap unique string otherwise — no extra
// dependency needed.
function newSessionToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AddressField({
  value,
  onChangeText,
  onPick,
  country,
  error,
}: {
  value: string;
  onChangeText: (t: string) => void;
  onPick: (s: AddressSuggestion) => void;
  country?: string;
  error?: string;
}) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id: a response only wins if it's still the latest query,
  // so a slow earlier request can't overwrite a newer one's results.
  const reqId = useRef(0);
  // Minted lazily on the first keystroke of a lookup, reused across the
  // per-keystroke autocomplete calls, then cleared on pick so the next address
  // starts a fresh billing session.
  const sessionToken = useRef<string | null>(null);

  function ensureSession(): string {
    if (!sessionToken.current) sessionToken.current = newSessionToken();
    return sessionToken.current;
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function schedule(q: string) {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < MIN_QUERY) {
      setPredictions([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    timer.current = setTimeout(() => run(q.trim()), DEBOUNCE_MS);
  }

  async function run(q: string) {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const c = country?.trim().toUpperCase();
      const token = ensureSession();
      const query =
        c && c.length === 2 ? { q, country: c, sessionToken: token } : { q, sessionToken: token };
      const res = await api.api.locations.autocomplete.$get({ query });
      if (id !== reqId.current) return; // a newer query superseded this one
      if (!res.ok) {
        setPredictions([]);
        setOpen(false);
        return;
      }
      const body = await res.json();
      setPredictions(body.predictions);
      setDegraded(body.degraded === true);
      setOpen(true);
    } catch {
      if (id === reqId.current) {
        setPredictions([]);
        setOpen(false);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  function handleChange(t: string) {
    onChangeText(t);
    schedule(t);
  }

  async function pick(p: Prediction) {
    // Picking closes the dropdown, then resolves the structured address via the
    // details route. We reuse (and then retire) the session token so Google
    // bills the whole interaction as one session.
    setOpen(false);
    setPredictions([]);
    const token = sessionToken.current ?? undefined;
    sessionToken.current = null;
    setLoading(true);
    try {
      const res = await api.api.locations.details.$get({
        query: token ? { placeId: p.placeId, sessionToken: token } : { placeId: p.placeId },
      });
      if (!res.ok) {
        setDegraded(true);
        return;
      }
      const body = await res.json();
      if (!body.suggestion || body.degraded) {
        setDegraded(true);
        return;
      }
      onPick(body.suggestion);
      setDegraded(false);
    } catch {
      setDegraded(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">Street</Text>
      <View>
        <TextInput
          value={value}
          onChangeText={handleChange}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder="House number + street, and city or ZIP"
          placeholderTextColor="#0f162666"
          className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
        />
        {loading ? (
          <View className="absolute right-3 top-3.5">
            <ActivityIndicator size="small" color="#0f1626" />
          </View>
        ) : null}
      </View>

      {open && predictions.length > 0 ? (
        <View className="mt-1 overflow-hidden rounded-sm border border-ink/15 bg-cream-warm">
          {predictions.map((p) => (
            <Pressable
              key={p.placeId}
              onPress={() => pick(p)}
              className="border-b border-ink/10 px-3 py-2 active:bg-gold-deep/10"
            >
              <Text className="text-sm text-ink">{p.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {degraded ? (
        <Text className="mt-1 text-xs text-oxblood/70">
          Address lookup is temporarily unavailable; type the address by hand.
        </Text>
      ) : null}
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
      <Text className="mt-1 text-xs text-ink-subtle">
        Type the address (include the city or ZIP) and pick a suggestion — the fields below fill in.
      </Text>
    </View>
  );
}
