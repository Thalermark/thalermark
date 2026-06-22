// Regenerate src/common-passwords.generated.ts — the small breach-list the
// password-strength meter uses to short-circuit common passwords to "Weak".
//
// Dev-only and run by hand; the output is committed and loaded at runtime, so
// nothing is fetched when the app runs (keeps the self-host story clean).
//
//   node scripts/gen-common-passwords.mjs              # fetch the pinned default
//   node scripts/gen-common-passwords.mjs ./list.txt   # parse a local file
//   node scripts/gen-common-passwords.mjs <url>         # parse a custom URL
//   TOP=2000 node scripts/gen-common-passwords.mjs      # change the slice size
//
// Default source: SecLists xato-net-10-million-passwords-1000.txt — the file
// formerly named 10-million-password-list-top-1000.txt — MIT-licensed, pinned
// to a release tag so regenerating is reproducible.

import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '2026.1';
const DEFAULT_URL = `https://raw.githubusercontent.com/danielmiessler/SecLists/${TAG}/Passwords/Common-Credentials/xato-net-10-million-passwords-1000.txt`;
const TOP = Number(process.env.TOP ?? 1000);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outPath = join(scriptDir, '..', 'src', 'common-passwords.generated.ts');

async function loadSource(arg) {
  if (!arg || /^https?:\/\//.test(arg)) {
    const url = arg ?? DEFAULT_URL;
    console.log(`Fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return { text: await res.text(), origin: url };
  }
  console.log(`Reading ${arg}`);
  return { text: await readFile(arg, 'utf8'), origin: arg };
}

const { text, origin } = await loadSource(process.argv[2]);

// Normalize: trim, lowercase (match is case-insensitive), drop blanks/comments,
// dedupe (lowercasing collapses case variants), keep the first TOP.
const seen = new Set();
const passwords = [];
for (const raw of text.split(/\r?\n/)) {
  const pw = raw.trim().toLowerCase();
  if (!pw || pw.startsWith('#') || seen.has(pw)) continue;
  seen.add(pw);
  passwords.push(pw);
  if (passwords.length >= TOP) break;
}

const header = `// GENERATED FILE — do not edit by hand.
// Regenerate: node packages/validation/scripts/gen-common-passwords.mjs
//
// The ${passwords.length} most common passwords (lowercased + deduped). The
// strength meter short-circuits any exact match to "Weak": an attacker tries
// these first, so their real-world strength is ~0 no matter what the entropy
// formula says. Exact-match only — this is a nudge, not a breach oracle.
//
// Source: ${origin}
//   SecLists (MIT) — formerly 10-million-password-list-top-${TOP}.txt
// Retrieved: ${new Date().toISOString().slice(0, 10)}`;

const body = `export const COMMON_PASSWORDS: readonly string[] = [\n${passwords
  .map((p) => `  ${JSON.stringify(p)},`)
  .join('\n')}\n];\n`;

writeFileSync(outPath, `${header}\n\n${body}`);
console.log(`Wrote ${passwords.length} passwords to ${outPath}`);
