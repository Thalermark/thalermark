import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';

// The Street field, doubling as an address type-ahead — the RN mirror of web's
// AddressLookup.svelte. The real field IS the search box (no confusing second
// input): typing queries GET /api/locations/autocomplete; picking a suggestion
// rewrites the Street line and fans the rest out to the city / region /
// postalCode / country fields the parent owns. Prefilling the parent's
// addressLine1 (edit form) does NOT trigger a search — only on-device typing
// (onChangeText) does — so loading an existing contact doesn't auto-search.
export type AddressSuggestion = {
  label: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

const DEBOUNCE_MS = 250;
const MIN_QUERY = 3;

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
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id: a response only wins if it's still the latest query,
  // so a slow earlier request can't overwrite a newer one's results.
  const reqId = useRef(0);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function schedule(q: string) {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < MIN_QUERY) {
      setSuggestions([]);
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
      const res = await api.api.locations.autocomplete.$get({
        query: c && c.length === 2 ? { q, country: c } : { q },
      });
      if (id !== reqId.current) return; // a newer query superseded this one
      if (!res.ok) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      const body = await res.json();
      setSuggestions(body.suggestions);
      setDegraded(body.degraded === true);
      setOpen(true);
    } catch {
      if (id === reqId.current) {
        setSuggestions([]);
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

  function pick(s: AddressSuggestion) {
    onPick(s);
    setSuggestions([]);
    setOpen(false);
    setDegraded(false);
  }

  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">Street</Text>
      <View>
        <TextInput
          value={value}
          onChangeText={handleChange}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder="House number + street, and city or ZIP"
          placeholderTextColor="#0f162666"
          className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
        />
        {loading ? (
          <View className="absolute right-3 top-3.5">
            <ActivityIndicator size="small" color="#0f1626" />
          </View>
        ) : null}
      </View>

      {open && suggestions.length > 0 ? (
        <View className="mt-1 overflow-hidden rounded-sm border border-ink/15 bg-cream-warm">
          {suggestions.map((s) => (
            <Pressable
              key={s.label}
              onPress={() => pick(s)}
              className="border-b border-ink/10 px-3 py-2 active:bg-gold-deep/10"
            >
              <Text className="text-sm text-ink">{s.label}</Text>
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
      <Text className="mt-1 text-xs text-ink/40">
        Type the address (include the city or ZIP) and pick a suggestion — the fields below fill in.
      </Text>
    </View>
  );
}
