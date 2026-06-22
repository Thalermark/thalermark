// Password-strength estimate for the create-account screen (email/password
// sign-ups only — social sign-ins never set a password here). A deliberately
// small, dependency-free heuristic:
//
//   H = log2(N^L) = L * log2(N)
//
// where L is the length and N is the number of *distinct* characters actually
// used. Using the distinct-character count — not the size of the pool the
// characters are drawn from — is what makes all-same-character input collapse
// to 0 bits ("aaaaaaaa" -> N=1 -> 0) and lightly penalizes low-diversity
// passwords for free, which a pool-size estimate can't do.
//
// Caveat by design: pure entropy can't see dictionary words or sequences. It
// CAN'T see common breached passwords either, so a small blocklist
// (the SecLists top ~1k plus a hand-maintained supplement) short-circuits exact
// matches to "Weak" ahead of the math — otherwise "Usuckballz1" would read
// "Fair". The UI also nudges toward passphrases, which the formula rewards.
//
// Because distinct-char entropy runs lower than the usual pool-size estimate,
// the bands below are calibrated to *this* formula, anchored against real
// passwords (see the test) — not borrowed from pool-size threshold tables,
// which would put "Strong" out of reach and train users to ignore the meter.
// The lever for reachability is length: a short complex password tops out
// around "Good", while a multi-word passphrase clears "Strong" easily and is
// both easier to type and genuinely stronger.
//
// Shared by the web + mobile signup meters (and a future api signup gate) so
// every surface agrees on one verdict.

import { COMMON_PASSWORDS_EXTRA } from './common-passwords.extra.js';
import { COMMON_PASSWORDS } from './common-passwords.generated.js';

// Known breached passwords: the generated SecLists list + a hand-maintained
// supplement. Trimmed + lowercased on the way in, so the membership test (which
// lowercases the candidate) is case-insensitive however an entry was typed.
const COMMON_PASSWORD_SET = new Set(
  [...COMMON_PASSWORDS, ...COMMON_PASSWORDS_EXTRA]
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0),
);

export const STRENGTH_LABELS = ['Weak', 'Fair', 'Good', 'Strong'] as const;
export type StrengthScore = 0 | 1 | 2 | 3;
export type StrengthLabel = (typeof STRENGTH_LABELS)[number];

export interface PasswordStrength {
  /** Entropy in bits: L * log2(distinct N); 0 for empty, single-char, or a common password. */
  bits: number;
  /** Band index 0-3, aligned to STRENGTH_LABELS — drives the meter color + label. */
  score: StrengthScore;
  label: StrengthLabel;
}

// Bits -> band, calibrated to the distinct-char formula and the test anchors:
//   `password` (22) Weak · `BlueSky42!` (33) Fair · `Maple7Leaf!x` (40) Good ·
//   `Th1stle$Garden` (52) / `river-otter-9-lamp` (65) Strong.
const FAIR_BITS = 28;
const GOOD_BITS = 38;
const STRONG_BITS = 50;

export function estimatePasswordStrength(password: string): PasswordStrength {
  // A known breached password is the first guess an attacker makes — its
  // real-world strength is ~0 regardless of length or diversity, so demote it
  // before the entropy math. Case-insensitive to match the lowercased list.
  if (COMMON_PASSWORD_SET.has(password.toLowerCase())) {
    return { bits: 0, score: 0, label: STRENGTH_LABELS[0] };
  }

  // Iterate by code point (spread), so multi-unit characters (e.g. emoji) count
  // once and the length matches what the user perceives.
  const chars = [...password];
  const length = chars.length;
  const distinct = new Set(chars).size;
  // A single repeated character carries no entropy regardless of length
  // ("aaaa" is no stronger than "a"), so floor it at 0 bits.
  const bits = distinct <= 1 ? 0 : length * Math.log2(distinct);

  const score: StrengthScore =
    bits >= STRONG_BITS ? 3 : bits >= GOOD_BITS ? 2 : bits >= FAIR_BITS ? 1 : 0;

  return { bits, score, label: STRENGTH_LABELS[score] };
}

// Minimum password length the signup flow enforces. Set to match the strength
// gate: under the distinct-char formula no password shorter than ~10 can clear
// "Weak" (8 chars max out at 24 bits, below the 28-bit Fair floor), so a visible
// 10-char minimum is the legible front door to "must score at least Fair".
export const MIN_PASSWORD_LENGTH = 10;

export interface PasswordCheckResult {
  ok: boolean;
  /** User-facing reason when rejected; '' when accepted. */
  message: string;
}

// The signup password policy — the single source of truth shared by the web +
// mobile forms (instant inline error) and the api signup hook (the real
// boundary). Two legible rules: at least MIN_PASSWORD_LENGTH characters, and not
// "Weak" (score 0). The strength rule also rejects every common-password
// blocklist match for free, since those short-circuit to score 0.
export function checkPassword(password: string): PasswordCheckResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (estimatePasswordStrength(password).score === 0) {
    return {
      ok: false,
      message: 'That password is too weak — add length or use a few random words.',
    };
  }
  return { ok: true, message: '' };
}
