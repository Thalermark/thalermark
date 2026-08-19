import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

// Native date picker, the M11a replacement for the plain text date inputs the
// create forms shipped with. The value stays an ISO `yyyy-mm-dd` string (what
// every form sends to the API) — this is purely the editing surface. Optional
// fields (estimate expiresOn, recurring endDate) pass `optional` for a "None"
// placeholder + a Clear affordance; the empty value is '' (the forms already
// map '' → undefined before POST).
//
// Parsing/formatting goes through local Y/M/D parts, NOT `new Date(iso)` /
// `toISOString()`, which interpret the bare date as UTC and shift it a day in
// negative-offset zones.
function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DISPLAY: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

export function DateField({
  label,
  value,
  onChange,
  error,
  optional,
}: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  error?: string;
  optional?: boolean;
}) {
  const [show, setShow] = useState(false);
  const has = value !== '';
  const anchor = has ? isoToDate(value) : new Date();

  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <View className="mt-1 flex-row items-center gap-2">
        <Pressable
          onPress={() => setShow(true)}
          className="flex-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2.5"
        >
          <Text className={has ? 'text-ink' : 'text-ink-subtle'}>
            {has ? anchor.toLocaleDateString('en-US', DISPLAY) : 'None'}
          </Text>
        </Pressable>
        {optional && has ? (
          <Pressable
            onPress={() => {
              onChange('');
              setShow(false);
            }}
            className="px-2 py-2"
          >
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Clear
            </Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}

      {show ? (
        <>
          <DateTimePicker
            value={anchor}
            mode="date"
            display={Platform.OS === 'ios' ? 'inline' : 'default'}
            // onChange is deprecated in 9.x → onValueChange (pick) + onDismiss
            // (cancel). Android is a one-shot dialog (close on either); iOS is an
            // inline calendar that stays open until the user taps Done below.
            onValueChange={(_event, selected) => {
              if (Platform.OS === 'android') setShow(false);
              onChange(dateToIso(selected));
            }}
            onDismiss={() => setShow(false)}
          />
          {Platform.OS === 'ios' ? (
            <Pressable onPress={() => setShow(false)} className="mt-1 self-end px-3 py-2">
              <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                Done
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
