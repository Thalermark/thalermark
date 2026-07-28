// Reading a trial balance CSV exported from whatever the business used before
// (TMC-169). Pure functions — the page owns the file input and the line editor.
//
// Why a trial balance rather than a general ledger: their chart won't match
// ours, so a transaction-level export means matching every *row* instead of
// every *account*, and the worksheet only ever needs per-account totals. A
// trial balance is also what all three likely sources — QuickBooks, Xero,
// Wave — export by that name, with effectively the same three columns.
//
// The output feeds the conversion-balance line editor rather than saving
// directly. That's deliberate: the user sees what matched, fixes what didn't,
// and the existing balance check still has to pass before anything posts. An
// import that writes straight to the ledger would be a way to get someone
// else's rounding errors into your books without looking at them.

export type ImportAccount = {
  id: string;
  code: string;
  name: string;
  accountType: string;
};

export type ImportedLine = {
  coaAccountId: string;
  side: 'debit' | 'credit';
  amount: string;
  // What the CSV called it, kept so the review step can show their wording
  // next to ours.
  sourceLabel: string;
};

export type UnmatchedRow = {
  label: string;
  side: 'debit' | 'credit';
  amount: string;
};

export type TrialBalanceParse = {
  lines: ImportedLine[];
  unmatched: UnmatchedRow[];
  // Fatal — nothing usable came out.
  error?: 'no_columns' | 'no_rows';
};

// Header detection. Deliberately loose: exports vary ("Account", "Account
// Name", "Description"), and the cost of guessing wrong is visible in the
// review step rather than silent.
const ACCOUNT_RE = /account|name|description/i;
const DEBIT_RE = /^\s*(debit|dr\.?)\s*$/i;
const CREDIT_RE = /^\s*(credit|cr\.?)\s*$/i;
const AMOUNT_RE = /amount|balance|total/i;

// Leading account code, as most exports write it: "7000 Supplies", "7000 -
// Supplies", or a bare "7000". Four digits is our own COA convention.
const LEADING_CODE_RE = /^\s*(\d{4})\b/;

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Money as accounting software writes it: "$1,234.56", "(89.00)" for negative,
// "-" or "" for nil. Returns cents so the caller never does float maths.
export function parseMoneyCents(raw: string): number {
  const t = raw.trim();
  if (t === '' || t === '-' || t === '—') return 0;
  const negative = /^\(.*\)$/.test(t) || t.startsWith('-');
  const digits = t.replace(/[^0-9.]/g, '');
  if (digits === '') return 0;
  const n = Number(digits);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

const centsToMoney = (c: number): string => (c / 100).toFixed(2);

// Finds the header row and the columns we need. Some exports carry a title and
// blank rows above the header, so this scans rather than assuming row 0.
function locateColumns(rows: string[][]): {
  headerIndex: number;
  account: number;
  debit: number;
  credit: number;
  amount: number;
} | null {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = (rows[i] ?? []).map((c) => String(c ?? ''));
    const account = row.findIndex((c) => ACCOUNT_RE.test(c));
    if (account < 0) continue;
    const debit = row.findIndex((c) => DEBIT_RE.test(c));
    const credit = row.findIndex((c) => CREDIT_RE.test(c));
    // A single signed amount column is the fallback shape.
    const amount = row.findIndex((c, idx) => idx !== account && AMOUNT_RE.test(c));
    if (debit >= 0 && credit >= 0) return { headerIndex: i, account, debit, credit, amount: -1 };
    if (amount >= 0) return { headerIndex: i, account, debit: -1, credit: -1, amount };
  }
  return null;
}

// Matches one CSV account label onto the company's chart. Code first because
// it's unambiguous; then exact name. Deliberately no fuzzy matching — a wrong
// account silently absorbs money, and "close enough" is not a standard worth
// applying to someone's tax figures. Anything it can't place comes back as
// unmatched for the user to map by hand.
export function matchAccount(label: string, accounts: ImportAccount[]): ImportAccount | null {
  const code = LEADING_CODE_RE.exec(label)?.[1];
  if (code) {
    const byCode = accounts.find((a) => a.code === code);
    if (byCode) return byCode;
  }
  const n = norm(label);
  if (n === '') return null;
  const byName = accounts.find((a) => norm(a.name) === n);
  if (byName) return byName;
  // "7000 Supplies" where 7000 isn't ours but "Supplies" is.
  const withoutCode = norm(label.replace(LEADING_CODE_RE, '').replace(/^[\s-–—:]+/, ''));
  if (withoutCode !== '' && withoutCode !== n) {
    const stripped = accounts.find((a) => norm(a.name) === withoutCode);
    if (stripped) return stripped;
  }
  return null;
}

export function parseTrialBalance(rows: string[][], accounts: ImportAccount[]): TrialBalanceParse {
  const cols = locateColumns(rows);
  if (!cols) return { lines: [], unmatched: [], error: 'no_columns' };

  const lines: ImportedLine[] = [];
  const unmatched: UnmatchedRow[] = [];

  for (let i = cols.headerIndex + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const label = String(row[cols.account] ?? '').trim();
    if (label === '') continue;
    // Exports carry "Total" and subtotal rows; including them would double the
    // whole import.
    if (/^total\b|\btotal$/i.test(label)) continue;

    let side: 'debit' | 'credit';
    let cents: number;
    if (cols.debit >= 0 && cols.credit >= 0) {
      const d = parseMoneyCents(String(row[cols.debit] ?? ''));
      const c = parseMoneyCents(String(row[cols.credit] ?? ''));
      // A row carrying both is unusual; net it rather than dropping one.
      const net = d - c;
      if (net === 0) continue;
      side = net > 0 ? 'debit' : 'credit';
      cents = Math.abs(net);
    } else {
      const a = parseMoneyCents(String(row[cols.amount] ?? ''));
      if (a === 0) continue;
      side = a > 0 ? 'debit' : 'credit';
      cents = Math.abs(a);
    }

    const account = matchAccount(label, accounts);
    if (!account) {
      unmatched.push({ label, side, amount: centsToMoney(cents) });
      continue;
    }
    lines.push({
      coaAccountId: account.id,
      side,
      amount: centsToMoney(cents),
      sourceLabel: label,
    });
  }

  if (lines.length === 0 && unmatched.length === 0) {
    return { lines, unmatched, error: 'no_rows' };
  }
  return { lines, unmatched };
}

// Whether the parsed lines balance, in cents. The page's own check covers the
// editable draft; this one reports on the file as imported, so a CSV that
// didn't balance before anyone touched it can be called out as such.
export function importBalance(lines: ImportedLine[]): {
  debitCents: number;
  creditCents: number;
  balanced: boolean;
} {
  let debitCents = 0;
  let creditCents = 0;
  for (const l of lines) {
    const c = Math.round(Number(l.amount) * 100);
    if (l.side === 'debit') debitCents += c;
    else creditCents += c;
  }
  return { debitCents, creditCents, balanced: debitCents === creditCents };
}
