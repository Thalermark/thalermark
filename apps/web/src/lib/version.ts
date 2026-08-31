// Version comparison for Settings → About: is the running api OLDER than the
// api this web build was built against? That is the one direction that can
// break — web calling routes the server does not have yet. A newer api is
// additive by the contract gate, so it never warrants a word (TMC-299).
//
// Only the release-tag shape is comparable: v0.1.0-beta.26, a component tag
// with its routing prefix stripped. A dev long-describe (v0.1.0-beta.26-3-gabc),
// a bare SHA, 'dev' or '' does not parse, and an unparseable side means
// unknown, not older — the page stays quiet rather than warning off a string
// it cannot read.

type Parsed = {
  release: [number, number, number];
  prerelease: string[] | null;
};

function parse(version: string | null | undefined): Parsed | null {
  if (!version) return null;
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/.exec(version);
  if (!m) return null;
  return {
    release: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ? m[4].split('.') : null,
  };
}

// Semver precedence, trimmed to what our tags produce: numeric identifiers
// compare numerically (beta.9 < beta.26), alphanumeric ones lexically
// (beta < rc), numeric sorts before alphanumeric, and a release outranks any
// prerelease of the same number (1.0.0-rc.1 < 1.0.0).
function compare(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function isOlderVersion(
  candidate: string | null | undefined,
  baseline: string | null | undefined,
): boolean {
  const a = parse(candidate);
  const b = parse(baseline);
  if (a === null || b === null) return false;
  return compare(a, b) < 0;
}
