# Telemetry Specification

**Version:** 0.1.0  
**Status:** Draft  
**Last updated:** May 2026

---

## Overview

This document defines the telemetry system for the product — what is collected, why, how, and how to opt out. It is public, versioned, and updated whenever collection changes. The telemetry code is open source and auditable by anyone.

Telemetry helps us understand how the product is used in the real world so we can make better decisions about what to build, fix, and improve. We will never use it to surveil, identify, or profile users.

---

## Core Principles

**Opt-in only.** Telemetry is disabled by default. Users explicitly choose to participate during first-run setup. No data is collected without consent.

**Anonymous always.** No personally identifiable information is ever collected. No names, emails, financial figures, client data, or business information.

**Transparent completely.** This document lists every event we collect, word for word. It is updated before any new collection begins, never after.

**Easy to disable.** Telemetry can be turned off at any time in settings or via CLI. No friction, no guilt.

**Shared openly.** Aggregate findings are published in regular telemetry reports. The community can see what we learned and what we built because of it.

---

## Consent & First Run

On first run, users are presented with the following prompt — not pre-checked, not buried, not guilt-tripped:

> **Help us build a better product**
>
> We'd like to collect anonymous usage data — things like which features you use and where errors occur. We never collect personal or financial information. You can opt out at any time in settings.
>
> [**Yes, help improve the product**] [**No thanks**]

Opting out dismisses the prompt permanently. The preference is stored locally and respected immediately.

---

## Opting Out

Telemetry can be disabled at any time:

**Via settings UI:**  
Settings → Privacy → Usage Data → Off

**Via CLI:**  
```bash
[product] telemetry off
```

**Via environment variable (for automated/CI installs):**  
```bash
TELEMETRY_DISABLED=true
```

Self-hosted installs with the environment variable set will never prompt and will never collect data.

---

## What We Collect

All events are anonymous and aggregated. No event contains personal, financial, or identifying information.

### Installation & Identity

| Field | Value | Purpose |
|---|---|---|
| `install_id` | Random UUID generated at install time | Distinguish unique installs without identifying users |
| `product_version` | e.g. `0.4.2` | Understand adoption of releases |
| `deployment_type` | `cloud` or `self-hosted` | Understand split between hosting models |
| `os_platform` | `linux`, `macos`, `windows` | Platform support prioritisation |
| `node_version` | e.g. `20.11.0` | Runtime compatibility decisions |

The `install_id` is a random UUID with no connection to user identity. It resets if the application is reinstalled.

---

### Session Events

| Event | Fields | Purpose |
|---|---|---|
| `session_start` | `deployment_type`, `product_version` | Understand active usage frequency |
| `session_end` | `duration_seconds` (rounded to nearest minute) | Understand session length |

---

### Feature Usage Events

| Event | Fields | Purpose |
|---|---|---|
| `invoice_created` | `line_item_count` (integer only, no amounts) | Invoice feature adoption |
| `invoice_sent` | `delivery_method`: `email` or `link` | How invoices are delivered |
| `invoice_marked_paid` | none | Payment workflow usage |
| `expense_logged` | `has_receipt_attached`: boolean | Receipt capture adoption |
| `expense_categorised` | `method`: `manual` or `ai_suggested` | AI suggestion adoption |
| `report_viewed` | `report_type`: `income`, `expenses`, `summary`, `custom` | Report feature usage |
| `client_created` | none | Client management adoption |
| `company_created` | none | Multi-company feature adoption |
| `estimate_created` | none | Estimate feature adoption |
| `estimate_converted` | none | Estimate-to-invoice conversion rate |

---

### AI Feature Events

| Event | Fields | Purpose |
|---|---|---|
| `ai_insight_viewed` | `insight_type`: `cashflow`, `anomaly`, `late_payer`, `tax_estimate`, `seasonal` | Which AI insights are valuable |
| `ai_insight_dismissed` | `insight_type` | Which AI insights are ignored |
| `ai_query_submitted` | `query_length_bucket`: `short`, `medium`, `long` | Natural language query adoption |
| `ai_suggestion_accepted` | `suggestion_type`: `category`, `client`, `amount_check` | AI suggestion accuracy |
| `ai_suggestion_rejected` | `suggestion_type` | AI suggestion accuracy |

No query content is ever collected. Only the length bucket.

---

### Flow Completion Events

| Event | Fields | Purpose |
|---|---|---|
| `onboarding_step_completed` | `step`: `company_setup`, `first_client`, `first_invoice`, `first_expense` | Onboarding friction |
| `onboarding_abandoned` | `last_completed_step` | Where users give up |
| `invoice_flow_abandoned` | `step_reached`: `details`, `line_items`, `preview`, `send` | Invoice creation friction |
| `expense_flow_abandoned` | `step_reached`: `amount`, `category`, `receipt`, `save` | Expense logging friction |

---

### Performance Events

| Event | Fields | Purpose |
|---|---|---|
| `page_load_time` | `page`: enum of page names, `duration_ms`: rounded to nearest 100ms | Performance regression detection |
| `api_response_time` | `endpoint_category`: enum, `duration_ms`: rounded to nearest 100ms | Backend performance |

---

### Error Events

| Event | Fields | Purpose |
|---|---|---|
| `error_occurred` | `error_code`, `component`: enum, `product_version` | Bug prioritisation |

No stack traces, no user data, no financial information. Only anonymised error codes.

---

## What We Never Collect

- Names, email addresses, phone numbers, or any contact information
- Invoice amounts, expense amounts, or any financial figures
- Client names or business names
- File contents or document data
- IP addresses in any stored or logged form
- Browser or device fingerprints
- Query content from natural language searches
- Geographic location beyond locale settings
- Authentication tokens, passwords, or credentials

---

## Data Storage & Retention

- Events transmitted over HTTPS
- Aggregated server-side — individual events not retained
- Aggregated data retained for 24 months
- Raw event logs not stored beyond 48 hours
- Data stored in the United States
- Aggregate data may be shared publicly in telemetry reports

---

## Telemetry Reports

Published regularly at: `[product website]/telemetry-reports`

Reports include active install counts, most/least used features, onboarding completion rates, top error codes, performance trends, and what we built because of the data.

---

## Auditing the Code

- **Telemetry module:** `packages/telemetry/`
- **Event definitions:** `packages/telemetry/events.ts`
- **Transmission code:** `packages/telemetry/client.ts`

Discrepancies between this document and the code are treated as critical bugs. Please open a GitHub issue immediately if you find one.

---

## Changes to This Document

Any change to what we collect requires a pull request updating this document, a changelog entry, and a note in the release announcement. Changes go live in the next release — never retroactively. We will never add new collection silently.

---

## Contact

Questions, concerns, or discrepancies:  
Open a GitHub issue tagged `telemetry`  
Or email: privacy@[domain]

---

*This document is versioned alongside the product.*
