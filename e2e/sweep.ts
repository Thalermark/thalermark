// Run the depreciation sweep against the running dev database at a chosen
// instant. It is normally a nightly cron, and the carryover behaviour it
// implements only shows up across a year boundary — so driving it by hand is
// the only way to watch a transferred asset resume rather than restart.
//
//   pnpm --filter @thalermark/api exec tsx ../../scratch/e2e/sweep.ts 2027-01-02
//
// bootstrapDb is the owner connection (it must see every tenant's purchases to
// know what is due); tenantDb is the RLS-bound one the postings go through.
import { createApiDatabase } from '../../apps/api/src/lib/db.js';
import { sweepDepreciation } from '../../apps/api/src/lib/depreciation.js';

const at = process.argv[2];
if (!at) throw new Error('usage: sweep.ts <YYYY-MM-DD>');

const bootstrapUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
if (!bootstrapUrl || !appUrl) throw new Error('DATABASE_URL / APP_DATABASE_URL not set');

// Wrapped rather than top-level await: scratch/ has no package.json declaring
// ESM, so tsx transpiles to CJS and a bare await is a syntax error there.
async function main() {
  const boot = createApiDatabase(bootstrapUrl as string, 4);
  const tenant = createApiDatabase(appUrl as string, 4);
  try {
    const result = await sweepDepreciation({
      bootstrapDb: boot.db,
      tenantDb: tenant.db,
      now: new Date(`${at}T12:00:00Z`),
    });
    console.log(JSON.stringify(result));
  } finally {
    await boot.close();
    await tenant.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
