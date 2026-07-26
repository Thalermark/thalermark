import { readFileSync, readdirSync } from 'node:fs';
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

  // The runner walks the JOURNAL, not the directory, so a .sql file nobody
  // listed is not "pending" — it does not exist. `drizzle-kit generate` writes
  // both halves, but a hand-authored migration (0015/0016 onward carry written
  // rationale, so hand-editing is normal here) can easily land as a file alone.
  // The symptom is remote from the cause: the DDL never runs and the next thing
  // to touch the column dies with "column ... does not exist", which reads like
  // broken auth rather than a missing migration.
  it('has a journal entry for every migration file on disk', () => {
    const tagged = new Set(journal.entries.map((e) => e.tag));
    const onDisk = readdirSync(resolve(dirname(journalPath), '..'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''));
    for (const tag of onDisk) {
      expect(
        tagged.has(tag),
        `${tag}.sql has no meta/_journal.json entry — it will never run`,
      ).toBe(true);
    }
  });
});
