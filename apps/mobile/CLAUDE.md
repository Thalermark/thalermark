# CLAUDE.md — apps/mobile

Orientation for the React Native + Expo app. Read the root `CLAUDE.md` and
`TECH-STACK.md` first; this file covers only what's specific to mobile.

## Where mobile stands

**The catch-up is done.** Roughly 70 screens ship: invoices, estimates,
expenses, contacts, items, recurring, bills, purchases, ledger, owner-money,
jobs, mileage, tax policies, the dashboard, and eleven reports. Settings live
under `more/`, recurring under `invoices/recurring/`.

```
src/app/
  _layout.tsx            # root stack
  (auth)/                # sign-in, sign-up, accept-invite, server picker
  (app)/                 # auth-gated half; _layout.tsx gates, index.tsx is Home
src/lib/
  api.ts                 # hc<AppType> client (bearer + Origin + x-account-id)
  auth-client.ts         # Better Auth client; persists the bearer token
  secure-store.ts        # expo-secure-store wrapper (Keychain / EncryptedSharedPreferences)
  server-url.ts          # runtime API base URL; the self-host server picker
```

**It also builds and installs as a native APK**, verified on a Pixel 8 Pro. See
SCAFFOLDING.md's mobile section for the JDK 17 requirement, which is the only
real prerequisite.

What is left is **parity, not absence**: seven web screens have no mobile
equivalent (`settings/ai` most importantly), and several web fixes never
crossed over. Tracked under epic TMC-269. When porting, mirror the web route
under `apps/web/src/routes/(app)/`: same API, same shapes, native UI.

**Mobile is a second client against the same API, not a follower.** A fix that
lands on web does not close the user-facing problem. TMC-199, TMC-204, TMC-226
and TMC-230 were all closed Done while mobile kept the old behaviour.

## Auth + API contract (load-bearing — don't re-derive)

- **Bearer, not cookies.** `auth-client.ts` reads the `set-auth-token` response
  header on sign-in/sign-up and stores it via `secure-store`; `api.ts` feeds it
  back as `Authorization: Bearer <token>`. RN has no cookie jar we rely on.
- **`Origin: thalermark://` on every request.** RN's fetch omits `Origin`, which
  trips Better Auth's CSRF middleware + the API's `TRUSTED_ORIGINS` allowlist.
  Both `api.ts` and `auth-client.ts` pin the app scheme. Keep it.
- **`hc<AppType>` headers must be a dynamic async fn** (token is read per
  request), and **`import type { AppType }`** — a value import breaks Metro.
- **Auth gate lives in `(app)/_layout.tsx` only** (via `useFocusEffect` +
  `authClient.getSession()`), not the root layout — so the `(auth)` flow doesn't
  pay a session round-trip on every navigation.
- **The API base URL is a runtime value — read it from `getServerUrl()`
  (`lib/server-url.ts`), never `process.env.EXPO_PUBLIC_API_URL` directly.**
  `EXPO_PUBLIC_*` is inlined at build time, so a published binary is frozen to
  one server; the pre-sign-in server picker (`(auth)/server.tsx`) lets
  self-hosters point the app at their own server. The env var is only the
  *default*. `api.ts` + `auth-client.ts` capture the URL at construction, so
  they're exported as Proxies that rebuild against `getServerUrl()` when it
  changes (no restart). The root `_layout.tsx` `hydrateServerUrl()`s the stored
  override before rendering. Any new module that builds a request URL must call
  `getServerUrl()` at call/render time (see `upload.ts`, `invitations.ts`, the
  `apiOrigin`/`absolutize` helpers in the detail screens). Self-host servers
  must allow `thalermark://` in `TRUSTED_ORIGINS` (the default compose does).

## `x-account-id` on every tenant request

`src/lib/api.ts` stamps `x-account-id` alongside the bearer. Every tenant API
route runs through the `rls-context` middleware, which sets the Postgres
`app.current_account_id` from that header; without it, tenant routes return zero
rows / 403 under RLS (the same bootstrap-vs-tenant trap documented for web). It
is resolved from the active membership, the mobile equivalent of web's
`active_account_id` cookie plus `locals.activeAccountId`. Any new client that
builds its own request must carry it.

## Parity invariants the feature screens MUST honor

These are server contracts the web already satisfies; mobile is a second client
and has to satisfy them independently.

- **Money + quantity cross the wire as decimal strings**, never JSON numbers
  (`moneyString` / `quantityString` in `@thalermark/validation`). Format with a
  fixed-decimal helper before POST. (Counters like `intervalCount` /
  `maxOccurrences` / `netTermsDays` *are* JSON numbers — only money/qty are
  strings.) The **server recomputes totals authoritatively** — send the line
  values; don't expect the server to trust client math, and don't diverge from
  it either.
- **`source_item_id` on every line item.** Picking a catalog item copies its
  description / unit price / default quantity into the line (a frozen snapshot)
  **and** stamps `sourceItemId` — the breadcrumb that feeds the
  `/reports/top-products` aggregate. A hand-typed line leaves it null. The API
  carries whatever the client sends; **if the mobile line-item forms don't send
  `sourceItemId`, every mobile-created sale silently falls into the
  "Uncatalogued / other" bucket** (no error, totals still tie out — only the
  per-product report undercounts). So the invoice/estimate/recurring line forms
  must each ship an **item type-ahead equivalent to web's
  `ItemPicker.svelte`**: query `GET /api/items?q=`, stamp the id on pick, clear
  it when the user edits the description by hand. Reference: web's `ItemPicker`,
  the `/items/search` proxy, and the `items-line-provenance` + `top-products`
  integration tests in `apps/api/tests/`.
- **Items archive, never hard-delete** — there's no item DELETE endpoint;
  `archive` / `restore` transitions instead.

## References to mirror

- Web routes: `apps/web/src/routes/(app)/{invoices,estimates,expenses,customers,recurring,settings/items,reports}`
- Shared schemas: `@thalermark/validation` (the source of truth for request shapes)
- API surface: `apps/api/src/app.ts` (the `hc<AppType>` chain mobile types against)
