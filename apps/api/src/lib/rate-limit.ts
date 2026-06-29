import type { Database } from '@thalermark/db';
import { sql } from 'drizzle-orm';

export type RateLimitResult = {
  allowed: boolean;
  // How many more requests fit in the current window (0 once over the limit).
  remaining: number;
  // Seconds until the current window resets — surfaced as Retry-After on a 429.
  retryAfterSeconds: number;
};

// Fixed-window counter against the app_rate_limit table (migration 0006). One
// atomic statement: insert the key at count 1, or on conflict bump it —
// resetting to 1 when the stored window has already rolled over. RETURNING
// reflects the post-update row, so `count` is this request's position in the
// window and `retry_after` is the seconds until it resets.
//
// app_rate_limit carries no RLS (it's infrastructure, and the public payment
// routes call this with no tenant context), so it runs on a plain pooled
// connection — no withAccountContext needed.
export async function checkRateLimit(
  db: Database,
  opts: { key: string; max: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const { key, max, windowSeconds } = opts;
  const result = await db.execute<{ count: number; retry_after: number }>(sql`
    INSERT INTO app_rate_limit (key, window_start, count)
    VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN app_rate_limit.window_start < now() - make_interval(secs => ${windowSeconds})
        THEN 1 ELSE app_rate_limit.count + 1 END,
      window_start = CASE
        WHEN app_rate_limit.window_start < now() - make_interval(secs => ${windowSeconds})
        THEN now() ELSE app_rate_limit.window_start END
    RETURNING
      count,
      GREATEST(
        0,
        ceil(extract(epoch FROM (window_start + make_interval(secs => ${windowSeconds})) - now()))
      )::int AS retry_after
  `);
  const row = result.rows[0];
  const count = row?.count ?? 0;
  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    retryAfterSeconds: row?.retry_after ?? windowSeconds,
  };
}
