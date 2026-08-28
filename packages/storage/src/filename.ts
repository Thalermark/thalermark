// Guard for the one string in this package that becomes an HTTP response
// header. A content-disposition filename is attacker-adjacent: it is built from
// user-controlled data (an expense's merchant name), and a quote or a CRLF in it
// is header injection. Rather than escape, both drivers refuse anything that is
// not already plainly safe, so there is one rule and no encoding subtleties.
//
// Deliberately narrow: lowercase letters, digits, dot, dash, underscore. No
// spaces, no unicode, no path separators, nothing needing quoting. Callers slug
// their input to fit (see the receipt route), so a rejected name means the
// caller has a bug, not that a user typed something exotic.
const SAFE_FILENAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function assertSafeDownloadFilename(name: string): void {
  if (!SAFE_FILENAME.test(name) || name.includes('..')) {
    throw new Error(
      `storage: unsafe download filename ${JSON.stringify(name)}; expected /^[a-z0-9][a-z0-9._-]{0,99}$/ with no ".."`,
    );
  }
}
