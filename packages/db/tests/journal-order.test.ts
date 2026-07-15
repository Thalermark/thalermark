import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Author-time guard for TMC-138. A migration whose journal `when` sorted below
// an earlier one used to be silently skipped by drizzle's high-water-mark
// runner. runMigrations() now gates on hash identity so ordering can't cause a
// skip, but a `when` that moves backwards is still a smell (and makes
// __drizzle_migrations.created_at misleading). Fail CI if the timestamps ever
// regress out of order — cheap belt to the runner's braces.
const journalPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/meta/_journal.json',
);

const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};

describe('migration journal', () => {
  it('lists entries in idx order', () => {
    journal.entries.forEach((entry, i) => expect(entry.idx).toBe(i));
  });

  it('has strictly increasing `when` timestamps in idx order', () => {
    let prev = journal.entries[0];
    for (const curr of journal.entries.slice(1)) {
      if (!prev) continue;
      expect(
        curr.when,
        `${curr.tag} (when=${curr.when}) must be newer than ${prev.tag} (when=${prev.when})`,
      ).toBeGreaterThan(prev.when);
      prev = curr;
    }
  });
});
