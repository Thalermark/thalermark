-- companies.logo_storage_key — object-storage key for the company logo shown
-- on invoices/estimates. The bytes live in S3/R2/MinIO/local-FS (same
-- abstraction as receipts), never in Postgres. Nullable: no logo by default,
-- and the public invoice falls back to the text-only sender block until one is
-- uploaded. Adding a nullable column is a safe, non-rewriting change.

ALTER TABLE "companies" ADD COLUMN "logo_storage_key" text;
