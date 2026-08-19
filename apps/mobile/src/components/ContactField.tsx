import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../lib/api';
import {
  type DupeCandidate,
  NEW_CONTACT,
  findEmailDupe,
  findNameDupes,
} from '../lib/contact-dupes';

// The sell-to "Contact" selector for invoices / estimates / recurring (RN
// counterpart of web's ContactPicker). The text input is a type-ahead over the
// company's contacts (GET /api/contacts?q=): picking a match links the document
// (contactId = its UUID), and an inline "+ Add new contact" row swaps in a
// name + email mini-form (with live dupe hints) that the screen creates on save
// (contactId = NEW_CONTACT). Unlike the expense VendorField, a free-text-only
// value is NOT valid here — the document requires a linked contact.
//
// Like VendorField, the parent owns the display text + contactId; for inline
// create it also owns newName / newEmail so the submit handler can read them.

const DEBOUNCE_MS = 200;
const MIN_QUERY = 2;

// Debounced, abortable contact search. One instance backs the selection
// type-ahead; two more back the inline-create name + email dupe probes.
function useContactSearch(companyId: string | null) {
  const [results, setResults] = useState<DupeCandidate[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
    },
    [],
  );

  const search = useCallback(
    (q: string) => {
      if (timer.current) clearTimeout(timer.current);
      if (q.trim().length < MIN_QUERY) {
        setResults([]);
        return;
      }
      timer.current = setTimeout(async () => {
        abort.current?.abort();
        abort.current = new AbortController();
        try {
          const query: Record<string, string> = { q: q.trim(), limit: '10' };
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
          setResults(
            contacts.map(
              (c): DupeCandidate => ({ id: c.id, name: c.name, email: c.email ?? null }),
            ),
          );
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          setResults([]);
        }
      }, DEBOUNCE_MS);
    },
    [companyId],
  );

  const clear = useCallback(() => setResults([]), []);
  return { results, search, clear };
}

export function ContactField({
  label,
  companyId,
  contactName,
  setContactName,
  contactId,
  setContactId,
  allowCreate = true,
  error,
  newName,
  setNewName,
  newEmail,
  setNewEmail,
  nameError,
  emailError,
}: {
  label: string;
  companyId: string | null;
  // Visible display text (the picked/typed contact name).
  contactName: string;
  setContactName: (s: string) => void;
  // '' (none) | <uuid> (linked) | NEW_CONTACT (inline create).
  contactId: string;
  setContactId: (v: string) => void;
  allowCreate?: boolean;
  error?: string;
  // Inline create — owned by the parent so its submit handler can read them.
  newName?: string;
  setNewName?: (s: string) => void;
  newEmail?: string;
  setNewEmail?: (s: string) => void;
  nameError?: string;
  emailError?: string;
}) {
  const [open, setOpen] = useState(false);
  const sel = useContactSearch(companyId);
  const nameDupeSearch = useContactSearch(companyId);
  const emailDupeSearch = useContactSearch(companyId);

  const inlineMode = contactId === NEW_CONTACT;
  const linked = contactId !== '' && contactId !== NEW_CONTACT;
  const trimmed = contactName.trim();

  const liveNameDupes = findNameDupes(newName ?? '', nameDupeSearch.results);
  const liveEmailDupe = findEmailDupe(newEmail ?? '', emailDupeSearch.results);

  // Typing detaches any prior pick — the field is now an unlinked search.
  function onChange(t: string) {
    setContactName(t);
    setContactId('');
    setOpen(t.trim() !== '');
    sel.search(t);
  }

  function pick(c: DupeCandidate) {
    setContactName(c.name);
    setContactId(c.id);
    setOpen(false);
    sel.clear();
  }

  function startCreate() {
    setContactId(NEW_CONTACT);
    if (trimmed !== '') setNewName?.(trimmed);
    setOpen(false);
    sel.clear();
  }

  function cancelCreate() {
    setContactId('');
    sel.clear();
  }

  function useExisting(c: DupeCandidate) {
    setContactName(c.name);
    setContactId(c.id);
  }

  if (inlineMode) {
    return (
      <View>
        <View className="flex-row items-center justify-between">
          <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
            {label}
          </Text>
          <Pressable onPress={cancelCreate}>
            <Text className="text-xs text-ink-subtle">← Pick existing</Text>
          </Pressable>
        </View>
        <View className="mt-1 gap-3 rounded-sm border border-ink/10 bg-cream-warm/60 p-4">
          <View>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Name *
            </Text>
            <TextInput
              value={newName ?? ''}
              onChangeText={(t) => {
                setNewName?.(t);
                nameDupeSearch.search(t);
              }}
              className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
            />
            {nameError ? <Text className="mt-1 text-xs text-oxblood">{nameError}</Text> : null}
            {liveNameDupes.length > 0 ? (
              <View className="mt-2 rounded-sm border border-ink/10 bg-cream p-2">
                <Text className="text-xs text-ink-subtle">Looks like an existing contact:</Text>
                {liveNameDupes.map((d) => (
                  <Pressable
                    key={d.id}
                    onPress={() => useExisting(d)}
                    className="mt-1 flex-row items-center justify-between"
                  >
                    <Text className="text-sm text-ink">{d.name}</Text>
                    <Text className="font-mono text-xs uppercase tracking-wider text-gold-deep">
                      Use
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
          <View>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Email
            </Text>
            <TextInput
              value={newEmail ?? ''}
              onChangeText={(t) => {
                setNewEmail?.(t);
                emailDupeSearch.search(t);
              }}
              keyboardType="email-address"
              autoCapitalize="none"
              className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
            />
            <Text className="mt-1 text-xs text-ink-subtle">
              Optional, but needed to send by email.
            </Text>
            {emailError ? <Text className="mt-1 text-xs text-oxblood">{emailError}</Text> : null}
          </View>
          {liveEmailDupe ? (
            <View className="rounded-sm border border-oxblood/30 bg-oxblood/5 p-3">
              <Text className="text-sm text-ink">
                <Text className="font-medium">{liveEmailDupe.name}</Text> already uses this email.
              </Text>
              <Pressable onPress={() => useExisting(liveEmailDupe)} className="mt-2">
                <Text className="font-mono text-xs uppercase tracking-wider text-gold-deep">
                  Use {liveEmailDupe.name}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
      </View>
    );
  }

  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <TextInput
        value={contactName}
        onChangeText={onChange}
        placeholder="Search contacts"
        placeholderTextColor="#9b8e7a"
        autoCapitalize="words"
        autoCorrect={false}
        className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
      />

      {open && trimmed !== '' ? (
        <View className="mt-1 overflow-hidden rounded-sm border border-ink/15 bg-cream-warm">
          {sel.results.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => pick(c)}
              className="border-b border-ink/10 px-3 py-2 active:bg-gold-deep/10"
            >
              <Text className="text-sm text-ink" numberOfLines={1}>
                {c.name}
              </Text>
              {c.email ? (
                <Text className="text-xs text-ink-subtle" numberOfLines={1}>
                  {c.email}
                </Text>
              ) : null}
            </Pressable>
          ))}
          {allowCreate ? (
            <Pressable onPress={startCreate} className="px-3 py-2 active:bg-gold-deep/10">
              <Text className="text-sm text-gold-deep" numberOfLines={1}>
                + Add “{trimmed}” as a new contact
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {linked ? <Text className="mt-1 text-xs text-ink-subtle">✓ Selected.</Text> : null}
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
    </View>
  );
}
