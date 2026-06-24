import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';

// Contact type-ahead for the invoice / estimate list filters — the RN
// counterpart of the web contact <select>. A <select> of every contact is
// fine on web, but a phone wants a search box, so this queries
// GET /api/contacts?q= (ILIKE on name/email) and lets the user pick one. The
// selected {id,name} feeds contactId into the list query; Clear resets it.
export type SelectedContact = { id: string; name: string };

const DEBOUNCE_MS = 200;
const MIN_QUERY = 2;

export function ContactFilterField({
  selected,
  onChange,
}: {
  selected: SelectedContact | null;
  onChange: (c: SelectedContact | null) => void;
}) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<SelectedContact[]>([]);
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
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => run(q.trim()), DEBOUNCE_MS);
  }

  async function run(q: string) {
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const res = await api.api.contacts.$get(
        { query: { q, limit: '20' } },
        { init: { signal: abort.current.signal } },
      );
      if (!res.ok) {
        setResults([]);
        setOpen(false);
        return;
      }
      const { contacts } = await res.json();
      const rows = contacts.map((c): SelectedContact => ({ id: c.id, name: c.name }));
      setResults(rows);
      setOpen(rows.length > 0);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      setResults([]);
      setOpen(false);
    }
  }

  if (selected) {
    return (
      <View className="flex-row items-center justify-between rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5">
        <Text className="flex-1 text-ink" numberOfLines={1}>
          {selected.name}
        </Text>
        <Pressable
          onPress={() => {
            onChange(null);
            setText('');
          }}
          className="pl-3"
        >
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">Clear</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          schedule(t);
        }}
        placeholder="Any contact"
        className="rounded-sm border border-ink/15 bg-cream px-3 py-2.5 text-ink"
      />
      {open && results.length > 0 ? (
        <View className="mt-1 overflow-hidden rounded-sm border border-ink/15 bg-cream-warm">
          {results.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => {
                onChange(c);
                setOpen(false);
                setResults([]);
              }}
              className="border-b border-ink/10 px-3 py-2 active:bg-gold-deep/10"
            >
              <Text className="text-sm text-ink" numberOfLines={1}>
                {c.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
