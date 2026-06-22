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
// Caveat by design: pure entropy can't see dictionary words, sequences, or
// common breached passwords ("Password1" still scores middling). The UI pairs
// the meter with a passphrase nudge to compensate. A common-password blocklist
// is a possible later add — it would short-circuit to score 0 ahead of the math
// (bundle cost is the open question, so it's parked for now).
//
// Because distinct-char entropy runs lower than the usual pool-size estimate,
// the bands below are calibrated to *this* formula, anchored against real
// passwords (see the test) — not borrowed from pool-size threshold tables,
// which would put "Strong" out of reach and train users to ignore the meter.
// The lever for reachability is length: a short complex password tops out
// around "Good", while a multi-word passphrase clears "Strong" easily and is
// both easier to type and genuinely stronger.
//
// Shared by the web + mobile signup meters (and, if a blocklist gate ever
// lands, the api signup hook) so every surface agrees on one verdict.

export const STRENGTH_LABELS = ['Weak', 'Fair', 'Good', 'Strong'] as const;
export type StrengthScore = 0 | 1 | 2 | 3;
export type StrengthLabel = (typeof STRENGTH_LABELS)[number];

export interface PasswordStrength {
  /** Estimated entropy in bits: L * log2(distinct N); 0 for empty / single-char. */
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
