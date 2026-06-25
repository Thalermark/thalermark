import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import { VENDOR_NEW } from '../lib/expense-vendor';

// The single on-screen "Vendor" field for an expense (RN counterpart of web's
// VendorPicker). The text input doubles as a type-ahead over the company's
// contacts (GET /api/contacts?q=): picking a match links the expense to that
// contact (the API mirrors its name into merchant), typing free text leaves it
// unlinked, and "+ Add … as a new vendor" creates a vendor contact on save.
// The parent owns `merchant` + `vendorContactId` ('' | uuid | VENDOR_NEW);
// `onDirty` lets the edit form know the field was touched (so an untouched edit
// leaves the link + needs-review flag alone).
type Suggestion = { id: string; name: string };

const DEBOUNCE_MS = 200;
const MIN_QUERY = 2;

export function VendorField({
  label,
  companyId,
  merchant,
  setMerchant,
  vendorContactId,
  setVendorContactId,
  onDirty,
  error,
}: {
  label: string;
  companyId: string | null;
  merchant: string;
  setMerchant: (s: string) => void;
  vendorContactId: string;
  setVendorContactId: (v: string) => void;
  onDirty?: () => void;
  error?: string;
}) {
  const [results, setResults] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, []);

  function schedule(q: string) {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < MIN_QUERY) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => run(q.trim()), DEBOUNCE_MS);
  }

  async function run(q: string) {
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const query: Record<string, string> = { q, limit: '10' };
      if (companyId) query.companyId = companyId;
      const res = await api.api.contacts.$get(
        { query },
        { init: { signal: abort.current.signal } },
      );
      if (!res.ok) {
        setResults([]);
        return;
      }
      const { contacts } = await res.json();
      setResults(contacts.map((c): Suggestion => ({ id: c.id, name: c.name })));
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      setResults([]);
    }
  }

  // Typing detaches any prior pick — the field is now free text.
  function onChange(t: string) {
    setMerchant(t);
    setVendorContactId('');
    onDirty?.();
    setOpen(t.trim() !== '');
    schedule(t);
  }

  function pick(c: Suggestion) {
    setMerchant(c.name);
    setVendorContactId(c.id);
    onDirty?.();
    setOpen(false);
    setResults([]);
  }

  function addNew() {
    setVendorContactId(VENDOR_NEW);
    onDirty?.();
    setOpen(false);
    setResults([]);
  }

  const trimmed = merchant.trim();
  const linked = vendorContactId !== '' && vendorContactId !== VENDOR_NEW;
  const willCreate = vendorContactId === VENDOR_NEW;

  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={merchant}
        onChangeText={onChange}
        autoCapitalize="words"
        autoCorrect={false}
        className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
      />

      {open && trimmed !== '' ? (
        <View className="mt-1 overflow-hidden rounded-sm border border-ink/15 bg-cream-warm">
          {results.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => pick(c)}
              className="border-b border-ink/10 px-3 py-2 active:bg-gold-deep/10"
            >
              <Text className="text-sm text-ink" numberOfLines={1}>
                {c.name}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={addNew} className="px-3 py-2 active:bg-gold-deep/10">
            <Text className="text-sm text-gold-deep" numberOfLines={1}>
              + Add “{trimmed}” as a new vendor
            </Text>
          </Pressable>
        </View>
      ) : null}

      {linked ? (
        <Text className="mt-1 text-xs text-ink/50">✓ Linked to this vendor.</Text>
      ) : willCreate ? (
        <Text className="mt-1 text-xs text-gold-deep">
          + “{trimmed}” will be added as a new vendor on save.
        </Text>
      ) : null}
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}
