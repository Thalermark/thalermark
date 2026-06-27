import * as Sentry from '@sentry/node';
import type { CashFlowAdvisor, ExpenseCategorizer, ReceiptExtractor } from '@thalermark/ai';
import type { Database } from '@thalermark/db';
import type { AddressAutocompleteProvider } from '@thalermark/location';
import { getLogger } from '@thalermark/logger';
import type { StorageProvider } from '@thalermark/storage';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { ApiAuth } from './lib/auth.js';
import type { Mailer } from './lib/mailer.js';
import type { StripeBundle } from './lib/stripe.js';
import { type RlsVariables, rlsContext } from './middleware/rls-context.js';
import { accountRoutes } from './routes/account.js';
import { auditEventsRoutes } from './routes/audit-events.js';
import { billsRoutes } from './routes/bills.js';
import { companiesRoutes } from './routes/companies.js';
import { contactsRoutes } from './routes/contacts.js';
import { estimatesRoutes } from './routes/estimates.js';
import { expensesRoutes } from './routes/expenses.js';
import { filesRoutes } from './routes/files.js';
import { invoicesRoutes } from './routes/invoices.js';
import { itemsRoutes } from './routes/items.js';
import { locationsRoutes } from './routes/locations.js';
import { publicRoutes } from './routes/public.js';
import { recurringInvoicesRoutes } from './routes/recurring.js';
import { reportsRoutes } from './routes/reports.js';
import { socialProvidersRoutes } from './routes/social-providers.js';
import { taxPoliciesRoutes } from './routes/tax-policies.js';
import { telemetryRoutes } from './routes/telemetry.js';

const log = getLogger(['api', 'app']);

export type AppDeps = {
  auth: ApiAuth;
  db: Database;
  // Superuser/BYPASSRLS handle for the narrow bootstrap surface that runs
  // before a tenant context exists: /api/me's "what accounts do I belong to"
  // and rls-context's membership probe. The RLS policies on accounts and
  // memberships gate visibility on `app.current_account_id`, which isn't set
  // on these requests, so under the tenant role they'd return zero rows.
  // Optional because integration tests run as the testcontainer superuser
  // and have nothing to distinguish; production server.ts passes both.
  bootstrapDb?: Database;
  scheduleFlush?: (db: Database, accountId: string) => void;
  trustedOrigins?: string[];
  publicAppUrl?: string;
  // Configured social-login provider ids ('google' | 'facebook' | 'twitter'),
  // surfaced by GET /api/social-providers so the web sign-in page renders only
  // the buttons that will work. Empty/omitted = email/password only. Built in
  // server.ts from env via enabledSocialProviders().
  socialProviders?: string[];
  // Email transport for the invoice-send + invitation endpoints. Optional so
  // integration tests that don't exercise either can omit it; routes that
  // need it fail fast with 500 when called without a mailer wired in.
  mailer?: Mailer;
  emailFrom?: string;
  // Stripe SDK bundle (client + publishable key + webhook secret). Null
  // when the operator hasn't configured STRIPE_* env vars — the public-
  // invoice view checks for null and hides the Pay button rather than
  // erroring; the webhook route returns 503 in that state.
  stripe?: StripeBundle | null;
  // Object-storage provider for receipt capture (slice 8.9g). Null when the
  // operator hasn't configured STORAGE_* env vars — the receipt endpoints
  // return 503 in that state, the rest of the app runs. Same opt-in model
  // as stripe/mailer.
  storage?: StorageProvider | null;
  // Local-FS download serving. Only set when STORAGE_DRIVER=local: the
  // /api/files/:token route verifies the token with `secret` and reads bytes
  // from `baseDir`. Null for the s3 driver, whose signed URLs point at the
  // object store directly so /api/files is never hit.
  localFileServe?: { secret: string; baseDir: string } | null;
  // Vision-LLM receipt extractor (slice 8.9h). Null when no LLM provider is
  // configured (anthropic/openai with no LLM_API_KEY, or an unknown provider) —
  // the /extract endpoint 503s in that state. Same opt-in model as
  // stripe/storage. Tests inject a plain stub so no live model is called.
  extractor?: ReceiptExtractor | null;
  // Text-based expense categorizer (AI). Null when no LLM provider is
  // configured — the /categorize endpoint 503s in that state, same opt-in
  // model as the extractor. Distinct from extractor: this reads typed text
  // (fast model), not a receipt image (vision model). Tests inject a stub.
  categorizer?: ExpenseCategorizer | null;
  // Cash-flow nudge advisor (AI, reasoning model). Null when no LLM is
  // configured — the cash-flow-nudges endpoint then 503s unless cached nudges
  // already exist. Tests inject a stub. Generated nudges are cached on the
  // company row and regenerated only when the computed signals change.
  advisor?: CashFlowAdvisor | null;
  // Address autocomplete provider for the mobile customer form's
  // /api/locations/autocomplete route (the web client uses its own same-origin
  // SvelteKit proxy). Null when construction failed (e.g. LOCATION_PROVIDER set
  // to an unknown name, or mapbox without a token) — the route then degrades to
  // empty suggestions rather than erroring. The keyless US Census geocoder is
  // the no-config default, so this is normally set. Built in server.ts from env.
  addressProvider?: AddressAutocompleteProvider | null;
};

function createMainApp(deps: AppDeps) {
  const origins = deps.trustedOrigins ?? [];
  const bootstrapDb = deps.bootstrapDb ?? deps.db;
  return (
    new Hono<{ Variables: RlsVariables }>()
      // Bridge thrown handler/middleware errors into error tracking. Hono catches
      // exceptions raised inside route handlers and turns them into a 500, so Node
      // never sees them as "uncaught" — Sentry's global hooks (armed in server.ts)
      // would miss exactly the handled 500s we most want. Capture here, then return
      // the API's JSON error shape. Sentry.captureException is a no-op when the DSN
      // is unset (uninitialised), so this is safe on self-host. HTTPExceptions carry
      // their own intended response (e.g. a framework 4xx) and are not server faults,
      // so pass them straight through without capturing.
      .onError((err, c) => {
        if (err instanceof HTTPException) return err.getResponse();
        Sentry.captureException(err);
        log.error('unhandled request error: {msg}', {
          msg: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'internal_server_error' }, 500);
      })
      .get('/health', (c) => c.json({ status: 'ok' }))
      .use(
        '/api/*',
        cors({
          origin: (incoming) => (origins.includes(incoming) ? incoming : null),
          credentials: true,
          allowHeaders: ['Content-Type', 'x-account-id', 'Authorization'],
          allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          // set-auth-token is the bearer plugin's session-token echo. Browsers
          // hide non-CORS-safelisted response headers from JS unless exposed
          // here, so the mobile (and Expo Web) client can read + persist it.
          exposeHeaders: ['set-auth-token'],
        }),
      )
      .on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))
      .use(
        '/api/*',
        rlsContext({
          auth: deps.auth,
          db: deps.db,
          bootstrapDb,
          scheduleFlush: deps.scheduleFlush,
        }),
      )
  );
}

// createApp wraps the main chain and mounts the per-domain sub-apps at runtime.
// Each sub-app is a self-contained chained Hono instance (see apps/api/src/routes/*).
// Mounting via .route() keeps each sub-app's schema OUT of AppType — the main
// chain's inferred type is already at the TS serialization ceiling (TS7056), and
// the whole point of the modular-sub-apps refactor is that no single combined
// type is ever materialized. Each domain's RPC types ride on its own XAppType
// (BillsAppType, ItemsAppType, TaxPoliciesAppType, …); the web/mobile clients
// compose them behind a unified facade so call sites stay api.<domain>.
export function createApp(deps: AppDeps) {
  const app = createMainApp(deps);
  app.route('/', billsRoutes());
  app.route('/', itemsRoutes());
  app.route('/', taxPoliciesRoutes());
  app.route('/', auditEventsRoutes());
  app.route('/', telemetryRoutes());
  // Deps-taking sub-apps: they close over `deps` (social providers list, address
  // provider, local-FS file serving, the mailer for document sends) rather than
  // the tenant tx, so they're constructed with deps here.
  app.route('/', socialProvidersRoutes(deps));
  app.route('/', locationsRoutes(deps));
  app.route('/', filesRoutes(deps));
  app.route('/', accountRoutes(deps));
  app.route('/', companiesRoutes(deps));
  app.route('/', contactsRoutes(deps));
  app.route('/', expensesRoutes(deps));
  app.route('/', invoicesRoutes(deps));
  app.route('/', recurringInvoicesRoutes(deps));
  app.route('/', estimatesRoutes(deps));
  app.route('/', reportsRoutes(deps));
  // public/webhook surface — mounted like the rest, but mount-only (no XAppType,
  // no facade): the routes are reached by URL from the unauthenticated web pay/
  // view pages and by Stripe, never via a typed hc client.
  app.route('/', publicRoutes(deps));
  return app;
}

export type AppType = ReturnType<typeof createMainApp>;
// Per-domain RPC surfaces — each kept out of AppType (see the mount in createApp).
// Web/mobile build a dedicated hc<XAppType>() client per domain.
export type BillsAppType = ReturnType<typeof billsRoutes>;
export type ItemsAppType = ReturnType<typeof itemsRoutes>;
export type TaxPoliciesAppType = ReturnType<typeof taxPoliciesRoutes>;
export type SocialProvidersAppType = ReturnType<typeof socialProvidersRoutes>;
export type LocationsAppType = ReturnType<typeof locationsRoutes>;
export type AuditEventsAppType = ReturnType<typeof auditEventsRoutes>;
export type TelemetryAppType = ReturnType<typeof telemetryRoutes>;
export type AccountAppType = ReturnType<typeof accountRoutes>;
export type CompaniesAppType = ReturnType<typeof companiesRoutes>;
export type ContactsAppType = ReturnType<typeof contactsRoutes>;
export type ExpensesAppType = ReturnType<typeof expensesRoutes>;
export type InvoicesAppType = ReturnType<typeof invoicesRoutes>;
export type RecurringInvoicesAppType = ReturnType<typeof recurringInvoicesRoutes>;
export type EstimatesAppType = ReturnType<typeof estimatesRoutes>;
export type ReportsAppType = ReturnType<typeof reportsRoutes>;
// filesRoutes has no XAppType export: GET /api/files/:token is served by a
// signed URL hit directly (img src / download), never via a typed hc client, so
// nothing consumes its type. It's still mounted in createApp like the rest.
