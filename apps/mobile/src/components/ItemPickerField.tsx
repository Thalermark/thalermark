import type { LineItemType } from '@thalermark/validation';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';

// RN port of apps/web's ItemPicker.svelte. The description input doubles as a
// type-ahead over the per-company items catalog (GET /api/items?q=, ILIKE on
// name). Picking a match prefills description / unit price / quantity AND
// stamps sourceItemId — the breadcrumb the /reports/top-products aggregate
// reads. Typing by hand clears sourceItemId so the line is attributed as
// free-text (otherwise the report would misattribute it). The parent owns the
// row state; this calls onChange with a partial patch (RN has no $bindable).
type Suggestion = {
  id: string;
  name: string;
  description: string | null;
  unitPrice: string;
  unitLabel: string | null;
  defaultQuantity: string;
  // 'product' | 'service' — text column on the wire, narrowed on pick.
  type: string;
  taxable: boolean;
  taxPolicyId: string | null;
};

export type ItemPatch = {
  description?: string;
  quantity?: string;
  // Unit-of-measure snapshot copied from the catalog item ("hour", "sq ft").
  // null when the item has none — the parent normalises that to an empty unit.
  unitLabel?: string | null;
  unitPrice?: string;
  sourceItemId?: string | null;
  // Product/service copied from the catalog item; drives the ledger split. The
  // parent merges it onto the row (defaults to 'service' for a hand-typed line).
  type?: LineItemType;
  // Tax prefill from the catalog item; the parent resolves the policy id onto
  // the row's tax controls.
  taxable?: boolean;
  taxPolicyId?: string | null;
};

const DEBOUNCE_MS = 200;
const MIN_QUERY = 2;

const fmt = (s: string) =>
  Number(s).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
// Strip numeric(15,4) trailing zeros so "1.0000" prefills as "1".
const cleanQty = (s: string) => String(Number(s));

export function ItemPickerField({
  description,
  onChange,
}: {
  description: string;
  onChange: (patch: ItemPatch) => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, []);

  function scheduleSearch(q: string) {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < MIN_QUERY) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => runSearch(q.trim()), DEBOUNCE_MS);
  }

  async function runSearch(q: string) {
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const res = await api.api.items.$get(
        { query: { q } },
        { init: { signal: abort.current.signal } },
      );
      if (!res.ok) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      const { items } = await res.json();
      setSuggestions(items);
      setOpen(items.length > 0);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      setSuggestions([]);
      setOpen(false);
    }
  }

  // Typing detaches any prior pick — the line is now free text.
  function onChangeText(text: string) {
    onChange({ description: text, sourceItemId: null });
    scheduleSearch(text);
  }

  function pick(s: Suggestion) {
    onChange({
      description: s.description?.trim() || s.name,
      unitLabel: s.unitLabel,
      unitPrice: s.unitPrice,
      quantity: cleanQty(s.defaultQuantity),
      sourceItemId: s.id,
      type: s.type === 'product' ? 'product' : 'service',
      taxable: s.taxable,
      taxPolicyId: s.taxPolicyId,
    });
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <View>
      <TextInput
        value={description}
        onChangeText={onChangeText}
        placeholder="Description"
        className="rounded-sm border border-ink/15 bg-cream px-2 py-2 text-ink"
      />
      {open && suggestions.length > 0 ? (
        <View className="mt-1 overflow-hidden rounded-sm border border-ink/15 bg-cream-warm">
          {suggestions.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => pick(s)}
              className="flex-row items-center justify-between gap-3 border-b border-ink/10 px-3 py-2 active:bg-gold-deep/10"
            >
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {s.name}
              </Text>
              <Text className="font-mono text-xs tabular-nums text-ink/70">
                {fmt(s.unitPrice)}
                {s.unitLabel ? `/${s.unitLabel}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
