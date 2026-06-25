-- ============================================================================
-- Thalermark baseline schema
--
-- Collapsed baseline of the original 0000-0054 migration chain (history reset
-- 2026-06-24, pre-alpha: no persistent database held the old __drizzle_migrations
-- ledger, so a clean baseline is safe). It is faithful to that chain's final
-- schema: the body below is a schema-only pg_dump of the fully-migrated database
-- (so every table, index, constraint, RLS policy and grant is captured verbatim,
-- already reflecting customers->contacts and the expense vendor link), with two
-- things re-added that a per-database schema dump cannot contain:
--   1. the cluster-global roles (prepended below), and
--   2. the system-actor seed row (appended at the end).
-- Future schema changes append as new numbered migrations as usual.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Roles (privilege contract). Created NOLOGIN; the deployment promotes them to
-- LOGIN with a password via provisionRole(). See original migrations 0005/0052.
--   thalermark_app            - RLS-enforcing app role (normal requests)
--   thalermark_staff_readonly - BYPASSRLS, SELECT-only (staff impersonation)
--   thalermark_pgboss         - owns ONLY the pgboss schema (background jobs)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thalermark_app') THEN
    CREATE ROLE thalermark_app NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thalermark_staff_readonly') THEN
    CREATE ROLE thalermark_staff_readonly NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thalermark_pgboss') THEN
    CREATE ROLE thalermark_pgboss NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- pg-boss owns only its own schema (no grants on public/tenant tables). Created
-- with createSchema:false at runtime, so the schema must exist up front.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION thalermark_pgboss;
ALTER SCHEMA pgboss OWNER TO thalermark_pgboss;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Debian 17.10-1.pgdg12+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: journal_entry_balance_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.journal_entry_balance_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected_entry_id uuid := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  bad_entry uuid;
BEGIN
  SELECT je.id
    INTO bad_entry
    FROM journal_entries je
    LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.id = affected_entry_id
    GROUP BY je.id
    HAVING COUNT(jl.id) < 2
        OR SUM(CASE jl.side WHEN 'debit' THEN jl.amount ELSE -jl.amount END) <> 0;
  IF bad_entry IS NOT NULL THEN
    RAISE EXCEPTION
      'journal_entry % is unbalanced or has fewer than 2 lines', bad_entry
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    telemetry_enabled boolean DEFAULT false NOT NULL,
    telemetry_install_id uuid,
    telemetry_decided_at timestamp with time zone
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid,
    actor_user_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_account (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider_id text NOT NULL,
    account_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_rate_limit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limit (
    id uuid NOT NULL,
    key text NOT NULL,
    count bigint NOT NULL,
    last_request bigint NOT NULL
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id uuid NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    name text,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_staff boolean DEFAULT false NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    last_account_id uuid
);


--
-- Name: auth_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_verification (
    id uuid NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chart_of_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chart_of_accounts (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    account_type text NOT NULL,
    normal_balance text NOT NULL,
    tax_mapping text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chart_of_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['asset'::text, 'liability'::text, 'equity'::text, 'revenue'::text, 'expense'::text]))),
    CONSTRAINT chart_of_accounts_normal_balance_check CHECK ((normal_balance = ANY (ARRAY['debit'::text, 'credit'::text])))
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_connect_account_id text,
    stripe_connect_charges_enabled boolean DEFAULT false NOT NULL,
    stripe_connect_details_submitted boolean DEFAULT false NOT NULL,
    business_type text,
    cash_flow_nudges jsonb,
    nudges_input_hash text,
    nudges_generated_at timestamp with time zone,
    reply_to_email text,
    payment_cash_enabled boolean DEFAULT false NOT NULL,
    payment_check_enabled boolean DEFAULT false NOT NULL,
    payment_check_payable_to text,
    payment_check_address text,
    payment_venmo_handle text,
    payment_zelle_contact text,
    business_address text,
    business_phone text,
    logo_storage_key text,
    business_email text,
    show_address_on_invoice boolean DEFAULT true NOT NULL,
    show_phone_on_invoice boolean DEFAULT true NOT NULL,
    show_email_on_invoice boolean DEFAULT true NOT NULL,
    show_address_on_estimate boolean DEFAULT true NOT NULL,
    show_phone_on_estimate boolean DEFAULT true NOT NULL,
    show_email_on_estimate boolean DEFAULT true NOT NULL,
    CONSTRAINT companies_business_type_check CHECK (((business_type IS NULL) OR (business_type = ANY (ARRAY['sole_prop'::text, 'llc_single_member'::text, 'partnership'::text, 's_corp'::text, 'c_corp'::text]))))
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    email text,
    phone text,
    address_line1 text,
    address_line2 text,
    city text,
    region text,
    postal_code text,
    country text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_customer boolean DEFAULT true NOT NULL,
    is_vendor boolean DEFAULT false NOT NULL
);


--
-- Name: email_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_templates (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    type text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: estimate_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimate_line_items (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    estimate_id uuid NOT NULL,
    "position" bigint NOT NULL,
    description text NOT NULL,
    quantity numeric(15,4) NOT NULL,
    unit_price numeric(15,2) NOT NULL,
    amount numeric(15,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_item_id uuid,
    taxable boolean DEFAULT false NOT NULL,
    tax_rate_pct numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    tax_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    tax_policy_id uuid,
    type text DEFAULT 'service'::text NOT NULL
);


--
-- Name: estimates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimates (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    number text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    issue_date date NOT NULL,
    expires_on date,
    currency text DEFAULT 'USD'::text NOT NULL,
    subtotal numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    tax numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    expired_at timestamp with time zone,
    converted_invoice_id uuid,
    public_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    show_address boolean DEFAULT true NOT NULL,
    show_phone boolean DEFAULT true NOT NULL,
    show_email boolean DEFAULT true NOT NULL
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    customer_contact_id uuid,
    category_account_id uuid NOT NULL,
    payment_account_id uuid NOT NULL,
    amount numeric(15,2) NOT NULL,
    expense_date date NOT NULL,
    merchant text NOT NULL,
    memo text,
    receipt_storage_key text,
    receipt_uploaded_at timestamp with time zone,
    extraction_status text DEFAULT 'none'::text NOT NULL,
    extraction_payload jsonb,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    vendor_contact_id uuid,
    vendor_review text,
    CONSTRAINT expenses_amount_positive_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT expenses_extraction_status_check CHECK ((extraction_status = ANY (ARRAY['none'::text, 'pending'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    email text NOT NULL,
    token text NOT NULL,
    invited_by_user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    declined_at timestamp with time zone,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text, 'accountant'::text, 'viewer'::text])))
);


--
-- Name: invoice_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_line_items (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    "position" bigint NOT NULL,
    description text NOT NULL,
    quantity numeric(15,4) NOT NULL,
    unit_price numeric(15,2) NOT NULL,
    amount numeric(15,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_item_id uuid,
    taxable boolean DEFAULT false NOT NULL,
    tax_rate_pct numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    tax_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    tax_policy_id uuid,
    type text DEFAULT 'service'::text NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    number text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    issue_date date NOT NULL,
    due_date date NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    subtotal numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    tax numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    paid_at timestamp with time zone,
    voided_at timestamp with time zone,
    public_token text,
    recurring_invoice_id uuid,
    payment_method text,
    payment_reference text,
    show_address boolean DEFAULT true NOT NULL,
    show_phone boolean DEFAULT true NOT NULL,
    show_email boolean DEFAULT true NOT NULL
);


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    unit_price numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    unit_label text,
    default_quantity numeric(15,4) DEFAULT '1'::numeric NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    taxable boolean DEFAULT false NOT NULL,
    tax_policy_id uuid,
    type text DEFAULT 'service'::text NOT NULL
);


--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entries (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_entity_type text NOT NULL,
    source_entity_id uuid NOT NULL,
    posted_at timestamp with time zone NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: journal_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_lines (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    journal_entry_id uuid NOT NULL,
    coa_account_id uuid NOT NULL,
    side text NOT NULL,
    amount numeric(15,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT journal_lines_amount_positive_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT journal_lines_side_check CHECK ((side = ANY (ARRAY['debit'::text, 'credit'::text])))
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    account_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'accountant'::text, 'viewer'::text])))
);


--
-- Name: recurring_invoice_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_invoice_line_items (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    recurring_invoice_id uuid NOT NULL,
    "position" bigint NOT NULL,
    description text NOT NULL,
    quantity numeric(15,4) NOT NULL,
    unit_price numeric(15,2) NOT NULL,
    amount numeric(15,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_item_id uuid,
    taxable boolean DEFAULT false NOT NULL,
    tax_rate_pct numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    tax_amount numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    tax_policy_id uuid,
    type text DEFAULT 'service'::text NOT NULL
);


--
-- Name: recurring_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_invoices (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    frequency text NOT NULL,
    interval_count bigint DEFAULT 1 NOT NULL,
    start_date date NOT NULL,
    next_run_date date NOT NULL,
    end_date date,
    max_occurrences bigint,
    occurrence_count bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    net_terms_days bigint DEFAULT 30 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    subtotal numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    tax numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(15,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recurring_invoices_frequency_check CHECK ((frequency = ANY (ARRAY['weekly'::text, 'monthly'::text, 'yearly'::text]))),
    CONSTRAINT recurring_invoices_interval_count_positive_check CHECK ((interval_count > 0)),
    CONSTRAINT recurring_invoices_max_occurrences_positive_check CHECK (((max_occurrences IS NULL) OR (max_occurrences > 0))),
    CONSTRAINT recurring_invoices_net_terms_days_nonneg_check CHECK ((net_terms_days >= 0)),
    CONSTRAINT recurring_invoices_occurrence_count_nonneg_check CHECK ((occurrence_count >= 0)),
    CONSTRAINT recurring_invoices_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'ended'::text])))
);


--
-- Name: tax_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_policies (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    company_id uuid NOT NULL,
    name text NOT NULL,
    rate_pct numeric(7,4) DEFAULT '0'::numeric NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telemetry_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetry_events (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    event_name text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retry_count bigint DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone
);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_account auth_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);


--
-- Name: auth_rate_limit auth_rate_limit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limit
    ADD CONSTRAINT auth_rate_limit_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_token_unique UNIQUE (token);


--
-- Name: auth_user auth_user_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_email_unique UNIQUE (email);


--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);


--
-- Name: auth_verification auth_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);


--
-- Name: chart_of_accounts chart_of_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: contacts customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: email_templates email_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);


--
-- Name: estimate_line_items estimate_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_line_items
    ADD CONSTRAINT estimate_line_items_pkey PRIMARY KEY (id);


--
-- Name: estimates estimates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_unique UNIQUE (token);


--
-- Name: invoice_line_items invoice_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);


--
-- Name: journal_lines journal_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_pkey PRIMARY KEY (id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);


--
-- Name: recurring_invoice_line_items recurring_invoice_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoice_line_items
    ADD CONSTRAINT recurring_invoice_line_items_pkey PRIMARY KEY (id);


--
-- Name: recurring_invoices recurring_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_pkey PRIMARY KEY (id);


--
-- Name: tax_policies tax_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_policies
    ADD CONSTRAINT tax_policies_pkey PRIMARY KEY (id);


--
-- Name: telemetry_events telemetry_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_events
    ADD CONSTRAINT telemetry_events_pkey PRIMARY KEY (id);


--
-- Name: audit_events_account_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_account_created_at_idx ON public.audit_events USING btree (account_id, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: audit_events_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_entity_idx ON public.audit_events USING btree (entity_type, entity_id);


--
-- Name: auth_account_provider_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_account_provider_account_idx ON public.auth_account USING btree (provider_id, account_id);


--
-- Name: auth_rate_limit_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_rate_limit_key_idx ON public.auth_rate_limit USING btree (key);


--
-- Name: auth_session_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_expires_at_idx ON public.auth_session USING btree (expires_at);


--
-- Name: auth_session_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_user_id_idx ON public.auth_session USING btree (user_id);


--
-- Name: auth_verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_verification_identifier_idx ON public.auth_verification USING btree (identifier);


--
-- Name: chart_of_accounts_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chart_of_accounts_account_id_idx ON public.chart_of_accounts USING btree (account_id);


--
-- Name: chart_of_accounts_company_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chart_of_accounts_company_code_uq ON public.chart_of_accounts USING btree (company_id, code);


--
-- Name: chart_of_accounts_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chart_of_accounts_company_id_idx ON public.chart_of_accounts USING btree (company_id);


--
-- Name: companies_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_account_id_idx ON public.companies USING btree (account_id);


--
-- Name: companies_stripe_connect_account_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX companies_stripe_connect_account_id_uq ON public.companies USING btree (stripe_connect_account_id);


--
-- Name: contacts_account_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_account_created_at_idx ON public.contacts USING btree (account_id, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: contacts_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_account_id_idx ON public.contacts USING btree (account_id);


--
-- Name: contacts_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_company_id_idx ON public.contacts USING btree (company_id);


--
-- Name: contacts_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_email_idx ON public.contacts USING btree (email);


--
-- Name: contacts_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_name_idx ON public.contacts USING btree (name);


--
-- Name: email_templates_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_templates_account_id_idx ON public.email_templates USING btree (account_id);


--
-- Name: email_templates_company_type_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_templates_company_type_uq ON public.email_templates USING btree (company_id, type);


--
-- Name: estimate_line_items_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimate_line_items_account_id_idx ON public.estimate_line_items USING btree (account_id);


--
-- Name: estimate_line_items_estimate_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimate_line_items_estimate_id_idx ON public.estimate_line_items USING btree (estimate_id);


--
-- Name: estimate_line_items_source_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimate_line_items_source_item_id_idx ON public.estimate_line_items USING btree (source_item_id);


--
-- Name: estimates_account_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimates_account_created_at_idx ON public.estimates USING btree (account_id, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: estimates_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimates_account_id_idx ON public.estimates USING btree (account_id);


--
-- Name: estimates_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimates_company_id_idx ON public.estimates USING btree (company_id);


--
-- Name: estimates_company_number_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX estimates_company_number_uq ON public.estimates USING btree (company_id, number);


--
-- Name: estimates_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimates_contact_id_idx ON public.estimates USING btree (contact_id);


--
-- Name: estimates_public_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX estimates_public_token_uq ON public.estimates USING btree (public_token);


--
-- Name: estimates_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimates_status_idx ON public.estimates USING btree (status);


--
-- Name: expenses_account_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_account_date_idx ON public.expenses USING btree (account_id, expense_date DESC NULLS LAST, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: expenses_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_account_id_idx ON public.expenses USING btree (account_id);


--
-- Name: expenses_category_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_category_account_id_idx ON public.expenses USING btree (category_account_id);


--
-- Name: expenses_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_company_id_idx ON public.expenses USING btree (company_id);


--
-- Name: expenses_customer_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_customer_contact_id_idx ON public.expenses USING btree (customer_contact_id);


--
-- Name: expenses_expense_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_expense_date_idx ON public.expenses USING btree (expense_date);


--
-- Name: expenses_payment_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_payment_account_id_idx ON public.expenses USING btree (payment_account_id);


--
-- Name: expenses_vendor_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_vendor_contact_id_idx ON public.expenses USING btree (vendor_contact_id);


--
-- Name: expenses_vendor_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX expenses_vendor_review_idx ON public.expenses USING btree (account_id, company_id) WHERE (vendor_review = 'needs_review'::text);


--
-- Name: invitations_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_account_id_idx ON public.invitations USING btree (account_id);


--
-- Name: invitations_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_email_idx ON public.invitations USING btree (email);


--
-- Name: invoice_line_items_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoice_line_items_account_id_idx ON public.invoice_line_items USING btree (account_id);


--
-- Name: invoice_line_items_invoice_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoice_line_items_invoice_id_idx ON public.invoice_line_items USING btree (invoice_id);


--
-- Name: invoice_line_items_source_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoice_line_items_source_item_id_idx ON public.invoice_line_items USING btree (source_item_id);


--
-- Name: invoices_account_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_account_created_at_idx ON public.invoices USING btree (account_id, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: invoices_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_account_id_idx ON public.invoices USING btree (account_id);


--
-- Name: invoices_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_company_id_idx ON public.invoices USING btree (company_id);


--
-- Name: invoices_company_number_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invoices_company_number_uq ON public.invoices USING btree (company_id, number);


--
-- Name: invoices_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_contact_id_idx ON public.invoices USING btree (contact_id);


--
-- Name: invoices_public_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invoices_public_token_uq ON public.invoices USING btree (public_token);


--
-- Name: invoices_recurring_invoice_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_recurring_invoice_id_idx ON public.invoices USING btree (recurring_invoice_id);


--
-- Name: invoices_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_status_idx ON public.invoices USING btree (status);


--
-- Name: items_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_account_id_idx ON public.items USING btree (account_id);


--
-- Name: items_account_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_account_name_idx ON public.items USING btree (account_id, name, id);


--
-- Name: items_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_company_id_idx ON public.items USING btree (company_id);


--
-- Name: items_company_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX items_company_name_idx ON public.items USING btree (company_id, name);


--
-- Name: journal_entries_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journal_entries_account_id_idx ON public.journal_entries USING btree (account_id);


--
-- Name: journal_entries_company_posted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journal_entries_company_posted_at_idx ON public.journal_entries USING btree (company_id, posted_at DESC NULLS LAST);


--
-- Name: journal_entries_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journal_entries_source_idx ON public.journal_entries USING btree (source_entity_type, source_entity_id);


--
-- Name: journal_lines_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journal_lines_account_id_idx ON public.journal_lines USING btree (account_id);


--
-- Name: journal_lines_coa_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journal_lines_coa_account_id_idx ON public.journal_lines USING btree (coa_account_id);


--
-- Name: journal_lines_journal_entry_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journal_lines_journal_entry_id_idx ON public.journal_lines USING btree (journal_entry_id);


--
-- Name: memberships_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memberships_account_id_idx ON public.memberships USING btree (account_id);


--
-- Name: memberships_one_owner_per_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memberships_one_owner_per_account ON public.memberships USING btree (account_id) WHERE (role = 'owner'::text);


--
-- Name: memberships_user_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memberships_user_account_idx ON public.memberships USING btree (user_id, account_id);


--
-- Name: recurring_invoice_line_items_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoice_line_items_account_id_idx ON public.recurring_invoice_line_items USING btree (account_id);


--
-- Name: recurring_invoice_line_items_recurring_invoice_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoice_line_items_recurring_invoice_id_idx ON public.recurring_invoice_line_items USING btree (recurring_invoice_id);


--
-- Name: recurring_invoice_line_items_source_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoice_line_items_source_item_id_idx ON public.recurring_invoice_line_items USING btree (source_item_id);


--
-- Name: recurring_invoices_account_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoices_account_created_at_idx ON public.recurring_invoices USING btree (account_id, created_at DESC NULLS LAST, id DESC NULLS LAST);


--
-- Name: recurring_invoices_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoices_account_id_idx ON public.recurring_invoices USING btree (account_id);


--
-- Name: recurring_invoices_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoices_company_id_idx ON public.recurring_invoices USING btree (company_id);


--
-- Name: recurring_invoices_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoices_contact_id_idx ON public.recurring_invoices USING btree (contact_id);


--
-- Name: recurring_invoices_sweep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_invoices_sweep_idx ON public.recurring_invoices USING btree (status, next_run_date);


--
-- Name: tax_policies_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_policies_account_id_idx ON public.tax_policies USING btree (account_id);


--
-- Name: tax_policies_account_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_policies_account_name_idx ON public.tax_policies USING btree (account_id, name, id);


--
-- Name: tax_policies_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_policies_company_id_idx ON public.tax_policies USING btree (company_id);


--
-- Name: tax_policies_company_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_policies_company_name_idx ON public.tax_policies USING btree (company_id, name);


--
-- Name: journal_lines journal_lines_balance_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER journal_lines_balance_check AFTER INSERT OR DELETE OR UPDATE ON public.journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.journal_entry_balance_check();


--
-- Name: audit_events audit_events_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: audit_events audit_events_actor_user_id_auth_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_auth_user_id_fk FOREIGN KEY (actor_user_id) REFERENCES public.auth_user(id);


--
-- Name: audit_events audit_events_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: auth_account auth_account_user_id_auth_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_user_id_auth_user_id_fk FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_session auth_session_user_id_auth_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_user_id_auth_user_id_fk FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_user auth_user_last_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_last_account_id_accounts_id_fk FOREIGN KEY (last_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: chart_of_accounts chart_of_accounts_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: chart_of_accounts chart_of_accounts_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: companies companies_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: contacts customers_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT customers_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: contacts customers_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT customers_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: email_templates email_templates_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: email_templates email_templates_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: estimate_line_items estimate_line_items_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_line_items
    ADD CONSTRAINT estimate_line_items_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: estimate_line_items estimate_line_items_estimate_id_estimates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_line_items
    ADD CONSTRAINT estimate_line_items_estimate_id_estimates_id_fk FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: estimate_line_items estimate_line_items_source_item_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_line_items
    ADD CONSTRAINT estimate_line_items_source_item_fk FOREIGN KEY (source_item_id) REFERENCES public.items(id) ON DELETE SET NULL;


--
-- Name: estimate_line_items estimate_line_items_tax_policy_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_line_items
    ADD CONSTRAINT estimate_line_items_tax_policy_fk FOREIGN KEY (tax_policy_id) REFERENCES public.tax_policies(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: estimates estimates_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: estimates estimates_converted_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_converted_invoice_id_invoices_id_fk FOREIGN KEY (converted_invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_customer_id_customers_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_category_account_id_chart_of_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_category_account_id_chart_of_accounts_id_fk FOREIGN KEY (category_account_id) REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_customer_id_customers_id_fk FOREIGN KEY (customer_contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_payment_account_id_chart_of_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_payment_account_id_chart_of_accounts_id_fk FOREIGN KEY (payment_account_id) REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_vendor_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_vendor_contact_id_fkey FOREIGN KEY (vendor_contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: invitations invitations_accepted_by_user_id_auth_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_accepted_by_user_id_auth_user_id_fk FOREIGN KEY (accepted_by_user_id) REFERENCES public.auth_user(id) ON DELETE SET NULL;


--
-- Name: invitations invitations_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_invited_by_user_id_auth_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_user_id_auth_user_id_fk FOREIGN KEY (invited_by_user_id) REFERENCES public.auth_user(id);


--
-- Name: invoice_line_items invoice_line_items_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_invoice_id_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_source_item_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_source_item_fk FOREIGN KEY (source_item_id) REFERENCES public.items(id) ON DELETE SET NULL;


--
-- Name: invoice_line_items invoice_line_items_tax_policy_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_tax_policy_fk FOREIGN KEY (tax_policy_id) REFERENCES public.tax_policies(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_customer_id_customers_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: invoices invoices_recurring_invoice_id_recurring_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_recurring_invoice_id_recurring_invoices_id_fk FOREIGN KEY (recurring_invoice_id) REFERENCES public.recurring_invoices(id) ON DELETE SET NULL;


--
-- Name: items items_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: items items_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: items items_tax_policy_id_tax_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_tax_policy_id_tax_policies_id_fk FOREIGN KEY (tax_policy_id) REFERENCES public.tax_policies(id) ON DELETE SET NULL;


--
-- Name: journal_entries journal_entries_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: journal_entries journal_entries_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: journal_lines journal_lines_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: journal_lines journal_lines_coa_account_id_chart_of_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_coa_account_id_chart_of_accounts_id_fk FOREIGN KEY (coa_account_id) REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT;


--
-- Name: journal_lines journal_lines_journal_entry_id_journal_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_journal_entry_id_journal_entries_id_fk FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_user_id_auth_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_auth_user_id_fk FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: recurring_invoice_line_items recurring_invoice_line_items_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoice_line_items
    ADD CONSTRAINT recurring_invoice_line_items_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: recurring_invoice_line_items recurring_invoice_line_items_recurring_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoice_line_items
    ADD CONSTRAINT recurring_invoice_line_items_recurring_fk FOREIGN KEY (recurring_invoice_id) REFERENCES public.recurring_invoices(id) ON DELETE CASCADE;


--
-- Name: recurring_invoices recurring_invoices_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: recurring_invoices recurring_invoices_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: recurring_invoices recurring_invoices_customer_id_customers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoices
    ADD CONSTRAINT recurring_invoices_customer_id_customers_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE RESTRICT;


--
-- Name: recurring_invoice_line_items recurring_line_items_source_item_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoice_line_items
    ADD CONSTRAINT recurring_line_items_source_item_fk FOREIGN KEY (source_item_id) REFERENCES public.items(id) ON DELETE SET NULL;


--
-- Name: recurring_invoice_line_items recurring_line_items_tax_policy_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_invoice_line_items
    ADD CONSTRAINT recurring_line_items_tax_policy_fk FOREIGN KEY (tax_policy_id) REFERENCES public.tax_policies(id) ON DELETE SET NULL;


--
-- Name: tax_policies tax_policies_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_policies
    ADD CONSTRAINT tax_policies_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: tax_policies tax_policies_company_id_companies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_policies
    ADD CONSTRAINT tax_policies_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: telemetry_events telemetry_events_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_events
    ADD CONSTRAINT telemetry_events_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts accounts_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_tenant_isolation ON public.accounts USING ((id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events audit_events_account_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_events_account_insert ON public.audit_events FOR INSERT WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: audit_events audit_events_account_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_events_account_select ON public.audit_events FOR SELECT USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: chart_of_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: chart_of_accounts chart_of_accounts_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chart_of_accounts_tenant_isolation ON public.chart_of_accounts USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: companies companies_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY companies_tenant_isolation ON public.companies USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts contacts_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contacts_tenant_isolation ON public.contacts USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: email_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: email_templates email_templates_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_templates_tenant_isolation ON public.email_templates USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: estimate_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimate_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: estimate_line_items estimate_line_items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY estimate_line_items_tenant_isolation ON public.estimate_line_items USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: estimates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;

--
-- Name: estimates estimates_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY estimates_tenant_isolation ON public.estimates USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses expenses_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expenses_tenant_isolation ON public.expenses USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: invitations invitations_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invitations_tenant_isolation ON public.invitations USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: invoice_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_line_items invoice_line_items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoice_line_items_tenant_isolation ON public.invoice_line_items USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices invoices_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoices_tenant_isolation ON public.invoices USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

--
-- Name: items items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY items_tenant_isolation ON public.items USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: journal_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: journal_entries journal_entries_account_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY journal_entries_account_insert ON public.journal_entries FOR INSERT WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: journal_entries journal_entries_account_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY journal_entries_account_select ON public.journal_entries FOR SELECT USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: journal_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: journal_lines journal_lines_account_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY journal_lines_account_insert ON public.journal_lines FOR INSERT WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: journal_lines journal_lines_account_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY journal_lines_account_select ON public.journal_lines FOR SELECT USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: memberships memberships_account_scope; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_account_scope ON public.memberships USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: memberships memberships_user_self_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_user_self_select ON public.memberships FOR SELECT USING ((user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid));


--
-- Name: recurring_invoice_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_invoice_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_invoice_line_items recurring_invoice_line_items_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_invoice_line_items_tenant_isolation ON public.recurring_invoice_line_items USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: recurring_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_invoices recurring_invoices_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_invoices_tenant_isolation ON public.recurring_invoices USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: tax_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_policies tax_policies_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tax_policies_tenant_isolation ON public.tax_policies USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: telemetry_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telemetry_events ENABLE ROW LEVEL SECURITY;

--
-- Name: telemetry_events telemetry_events_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telemetry_events_tenant_isolation ON public.telemetry_events USING ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('app.current_account_id'::text, true), ''::text))::uuid));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO thalermark_app;
GRANT USAGE ON SCHEMA public TO thalermark_staff_readonly;


--
-- Name: TABLE accounts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO thalermark_app;
GRANT SELECT ON TABLE public.accounts TO thalermark_staff_readonly;


--
-- Name: TABLE audit_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_events TO thalermark_app;
GRANT SELECT ON TABLE public.audit_events TO thalermark_staff_readonly;


--
-- Name: TABLE auth_account; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_account TO thalermark_app;
GRANT SELECT ON TABLE public.auth_account TO thalermark_staff_readonly;


--
-- Name: TABLE auth_rate_limit; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_rate_limit TO thalermark_app;
GRANT SELECT ON TABLE public.auth_rate_limit TO thalermark_staff_readonly;


--
-- Name: TABLE auth_session; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_session TO thalermark_app;
GRANT SELECT ON TABLE public.auth_session TO thalermark_staff_readonly;


--
-- Name: TABLE auth_user; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_user TO thalermark_app;
GRANT SELECT ON TABLE public.auth_user TO thalermark_staff_readonly;


--
-- Name: TABLE auth_verification; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_verification TO thalermark_app;
GRANT SELECT ON TABLE public.auth_verification TO thalermark_staff_readonly;


--
-- Name: TABLE chart_of_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chart_of_accounts TO thalermark_app;
GRANT SELECT ON TABLE public.chart_of_accounts TO thalermark_staff_readonly;


--
-- Name: TABLE companies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.companies TO thalermark_app;
GRANT SELECT ON TABLE public.companies TO thalermark_staff_readonly;


--
-- Name: TABLE contacts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contacts TO thalermark_app;
GRANT SELECT ON TABLE public.contacts TO thalermark_staff_readonly;


--
-- Name: TABLE email_templates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.email_templates TO thalermark_app;
GRANT SELECT ON TABLE public.email_templates TO thalermark_staff_readonly;


--
-- Name: TABLE estimate_line_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.estimate_line_items TO thalermark_app;
GRANT SELECT ON TABLE public.estimate_line_items TO thalermark_staff_readonly;


--
-- Name: TABLE estimates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.estimates TO thalermark_app;
GRANT SELECT ON TABLE public.estimates TO thalermark_staff_readonly;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.expenses TO thalermark_app;
GRANT SELECT ON TABLE public.expenses TO thalermark_staff_readonly;


--
-- Name: TABLE invitations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invitations TO thalermark_app;
GRANT SELECT ON TABLE public.invitations TO thalermark_staff_readonly;


--
-- Name: TABLE invoice_line_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invoice_line_items TO thalermark_app;
GRANT SELECT ON TABLE public.invoice_line_items TO thalermark_staff_readonly;


--
-- Name: TABLE invoices; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invoices TO thalermark_app;
GRANT SELECT ON TABLE public.invoices TO thalermark_staff_readonly;


--
-- Name: TABLE items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.items TO thalermark_app;
GRANT SELECT ON TABLE public.items TO thalermark_staff_readonly;


--
-- Name: TABLE journal_entries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.journal_entries TO thalermark_app;
GRANT SELECT ON TABLE public.journal_entries TO thalermark_staff_readonly;


--
-- Name: TABLE journal_lines; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.journal_lines TO thalermark_app;
GRANT SELECT ON TABLE public.journal_lines TO thalermark_staff_readonly;


--
-- Name: TABLE memberships; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memberships TO thalermark_app;
GRANT SELECT ON TABLE public.memberships TO thalermark_staff_readonly;


--
-- Name: TABLE recurring_invoice_line_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recurring_invoice_line_items TO thalermark_app;
GRANT SELECT ON TABLE public.recurring_invoice_line_items TO thalermark_staff_readonly;


--
-- Name: TABLE recurring_invoices; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recurring_invoices TO thalermark_app;
GRANT SELECT ON TABLE public.recurring_invoices TO thalermark_staff_readonly;


--
-- Name: TABLE tax_policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tax_policies TO thalermark_app;
GRANT SELECT ON TABLE public.tax_policies TO thalermark_staff_readonly;


--
-- Name: TABLE telemetry_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.telemetry_events TO thalermark_app;
GRANT SELECT ON TABLE public.telemetry_events TO thalermark_staff_readonly;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO thalermark_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO thalermark_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO thalermark_staff_readonly;


--
-- PostgreSQL database dump complete
--

-- ---------------------------------------------------------------------------
-- Synthetic system actor for mutations with no human in the loop (recurring
-- invoice auto-generation, Stripe webhooks, future bank-feed imports). No
-- auth_account row exists, so there is no path to authenticate as this user.
-- Deterministic UUID so application code can reference it by constant.
-- (pg_dump --schema-only omits data, so this seed is re-added here; see 0009.)
-- ---------------------------------------------------------------------------
INSERT INTO public."auth_user" ("id", "email", "email_verified", "name", "is_staff", "is_system")
VALUES (
  '00000000-0000-7000-8000-000000000001',
  'system@thalermark.internal',
  false,
  'System',
  false,
  true
)
ON CONFLICT ("id") DO NOTHING;

