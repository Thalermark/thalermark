-- Backfill: give solo workspaces the business name, not the person's name.
-- At signup both accounts.name (the "Workspace") and companies.name were seeded
-- to the person's name; the onboarding wizard then rewrote only companies.name,
-- so existing accounts are stuck on the human name. For every account that owns
-- exactly one company, adopt that company's (business) name where they've drifted.
-- Multi-company accounts are left alone — no single business to mirror. This is
-- the one-time data fix; going forward the company PATCH keeps them in sync.
--
-- SET search_path is mandatory for post-baseline migrations (the 0000_baseline
-- pg_dump empties the session search_path — see 0004_opening_balances.sql).
SET search_path TO public;--> statement-breakpoint
UPDATE accounts a
SET name = c.name, updated_at = now()
FROM (
  SELECT account_id, min(name) AS name
  FROM companies
  GROUP BY account_id
  HAVING count(*) = 1
) c
WHERE a.id = c.account_id
  AND a.name <> c.name;
