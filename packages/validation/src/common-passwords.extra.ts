// Hand-maintained supplement to the generated common-password blocklist.
//
// Unlike common-passwords.generated.ts (which gen-common-passwords.mjs overwrites
// from SecLists), this file is yours to edit — add passwords you've seen abused
// that aren't in the SecLists top-1000. The scorer unions both lists and
// lowercases on lookup, so entries are matched case-insensitively. Add them to
// the array below (lowercase by convention).
export const COMMON_PASSWORDS_EXTRA: readonly string[] = ['password1234'];
