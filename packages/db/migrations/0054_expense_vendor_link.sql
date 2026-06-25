-- Expense vendor link (contacts unification, slice 6). The buy-from side of a
-- contact relationship: an optional structured link from an expense to a vendor
-- contact (contacts.is_vendor), plus a review flag for receipt-backed expenses
-- whose vendor isn't linked yet.
--
-- vendor_contact_id was deliberately deferred from the 0053 rename to land with
-- the vendor-link UI — it is purely additive. The free-text merchant column
-- stays as the always-present display name (the single on-screen "Vendor" field
-- shows it); the structured link is optional and resolves the buy-from contact
-- for the total-relationship view + the future bills/AP seam. ON DELETE restrict
-- mirrors customer_contact_id + invoices: a contact with expenses can't be
-- hard-deleted.
--
-- vendor_review is a nullable status ('needs_review' | null): set when a
-- receipt-backed expense has no vendor link, cleared on link-or-dismiss. The
-- partial index backs the "Needs review" list filter.
--
-- Per the 0053 note, drizzle-kit generate stays off until the baseline reset;
-- this is hand-written. squawk's adding-foreign-key-constraint would fire on the
-- new FK column, but the column is new (every existing row is NULL, so FK
-- validation is trivial) and there are no populated production tables pre-alpha
-- — same justification as 0053's renaming-* ignores.

-- squawk-ignore adding-foreign-key-constraint
ALTER TABLE "expenses" ADD COLUMN "vendor_contact_id" uuid REFERENCES "contacts"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "vendor_review" text;
--> statement-breakpoint
CREATE INDEX "expenses_vendor_contact_id_idx" ON "expenses" USING btree ("vendor_contact_id");
--> statement-breakpoint
CREATE INDEX "expenses_vendor_review_idx" ON "expenses" USING btree ("account_id","company_id") WHERE "vendor_review" = 'needs_review';
