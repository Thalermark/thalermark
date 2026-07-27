-- Assets that were already part-way through their life when they arrived.
--
-- Today a capital purchase always starts its depreciation clock at its purchase
-- date, on this company's books, from a full basis. That is true when the
-- business bought it. It is false in two ordinary situations:
--
--   * an accountant entering a mower bought two years ago that has already been
--     depreciated on the books being replaced, and
--   * a sole proprietor incorporating, where §351 carryover basis means the new
--     corporation steps into the transferor's shoes — same cost, same life, same
--     clock. It does not restart, and restarting would overstate the deduction in
--     later years.
--
-- Without these columns, back-dating such a purchase makes the daily sweep post
-- the asset's ENTIRE prior depreciation history into books that never saw it.
--
--   prior_accumulated_depreciation — what was already written off elsewhere.
--     Schedule metadata only: it caps how much this company may still take. The
--     actual accumulated depreciation reaches these books through the opening
--     balance's Cr 1900, so there is no double count.
--   depreciation_start_year — the first year THIS company posts for. NULL keeps
--     today's behaviour exactly (derive from purchase_date), so every existing
--     row is unaffected.
--   transferred_from_purchase_id — provenance, and load-bearing: a transferred
--     purchase never had a create posting (it arrives via an opening balance, not
--     a Dr 1500 / Cr Cash), so the delete path must not try to reverse one. No
--     FK — it points at a row in another company's books and has to survive
--     independently of it.
--
-- All three are additive with constant defaults. No backfill, no rewrite.
SET search_path TO public;--> statement-breakpoint
ALTER TABLE "capital_purchases" ADD COLUMN "prior_accumulated_depreciation" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_purchases" ADD COLUMN "depreciation_start_year" bigint;--> statement-breakpoint
ALTER TABLE "capital_purchases" ADD COLUMN "transferred_from_purchase_id" uuid;--> statement-breakpoint
-- Can't have written off more than it cost before it even got here.
ALTER TABLE "capital_purchases" ADD CONSTRAINT "capital_purchases_prior_depreciation_check" CHECK ("prior_accumulated_depreciation" >= 0 AND "prior_accumulated_depreciation" <= "amount");
