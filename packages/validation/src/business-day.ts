// What day is it *for this business* (TMC-258).
//
// Not a formatting concern — an accounting one. Every date this app persists is
// a calendar day in a DATE column: the invoice issue date that revenue is
// recognised on, the day a payment was received, the day a recurring schedule
// next fires. Derive any of those from `new Date().toISOString()` and you have
// stamped them in UTC, which for a US business means everything after roughly
// 7pm local is filed on tomorrow. At the end of December that is not an
// off-by-one, it is income in the wrong tax year.
//
// The information is destroyed at write time. Once a UTC-derived day lands in a
// DATE column, no amount of timezone-aware reading downstream can recover what
// the local day actually was — which is why this belongs at every write rather
// than in the report layer, and why the report layer alone getting it right
// (PR #411) was not enough.
//
// Lives in validation because all three apps need the same answer. The api, the
// web server and mobile each used to compute "today" independently; the one
// thing this codebase has learned repeatedly is that two implementations of one
// question eventually disagree.

// IANA zone name, e.g. 'America/Chicago'. `companies.timezone` is notNull with
// a 'UTC' default, so callers normally have a real value — the fallback is for
// paths that genuinely have no company in scope.
export function localToday(timeZone: string, now: Date = new Date()): string {
  return localDay(now, timeZone);
}

// The calendar day a given instant falls on, in the given zone. Separate from
// localToday because a stored timestamp (a Stripe charge, an audit row) needs
// the same treatment as the clock does.
export function localDay(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, the shape every DATE column and every ISO
  // date input in the app already speaks.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    // An unknown zone throws a RangeError. A wrong-by-hours date beats a 500 on
    // the invoice form, so fall back to UTC — the same answer the app gave
    // everywhere before this existed.
    return instant.toISOString().slice(0, 10);
  }
}

// today + n days, still in the business's zone. Net-30 due dates and estimate
// expiries are calendar arithmetic on the LOCAL day, not on an instant: adding
// 30 * 86400s to a UTC timestamp drifts across a DST boundary, and the answer a
// person expects is simply "the same date next month".
export function localDayPlus(timeZone: string, days: number, now: Date = new Date()): string {
  const [y, m, d] = localToday(timeZone, now).split('-').map(Number) as [number, number, number];
  // UTC arithmetic on a date-only value is safe and DST-free precisely because
  // the local day has already been resolved above — this is calendar maths on
  // a plain Y/M/D, not a zone conversion.
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}
