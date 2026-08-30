import {
  type LlmCredential,
  type ProbeResult,
  describeLlmError,
  isConnectionHealthError,
} from '@thalermark/ai';
import { type Database, llmConnections, withAccountContext } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { decryptSecret, encryptSecret } from './crypto.js';
import type { LlmCredentialResolver } from './llm-credentials.js';

// The community / self-host implementation of the credential-resolution seam
// (door #4). It replaces envLlmCredentials: the LLM_* env block is gone, and an
// account's connection lives in a row it owns, written from Settings → AI.
//
// There is no precedence table and no fallback. The env key had no actor, so it
// never wrote an audit_events row, and keeping it as a second resolution path
// existed only to answer "whose key is the env key?" — a question the env itself
// created. Delete it and resolve() collapses to one lookup.
//
// Commercial imports from here (see thalermark-ai-commercial-seam.md §3.1a): its
// BYOK branch is `coreReader.getUsable(accountId)`, and a KMS-backed deployment
// implements LlmConnectionReader and hands it to settingsLlmCredentials. Neither
// reimplements the crypto or the health gate — both live below.

// The narrow dependency the resolver has. Decrypts, maps the row to an
// LlmCredential, and enforces the health gate. null means: no row, a
// never-healthy row, or one that will not decrypt.
export interface LlmConnectionReader {
  getUsable(accountId: string): Promise<LlmCredential | null>;
}

// What Settings → AI writes. `apiKey` carries three intents the store honours:
//   string    — a new key, encrypt and store it
//   null      — clear the key (e.g. switching to Ollama)
//   undefined — keep whatever is stored (the UI shows a masked key and only
//               re-sends it when the admin actually retypes one)
// `structured` is absent by design: it is DETECTED by the probe, never set by a
// user (see recordProbeResult), so an upsert always resets it to unknown.
export type ConnectionInput = {
  provider: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  modelVision?: string | null;
  modelReasoning?: string | null;
  modelFast?: string | null;
  timeoutSeconds?: number | null;
};

// The status the chip renders. Derived from the health columns, never stored:
//   unverified — saved but never probed. AI is OFF (the health gate). This is
//                the state the "click Verify to enable AI" copy speaks to.
//   ready      — has succeeded and is not currently failing. AI is ON.
//   error      — verify failed (never healthy), or a once-healthy connection is
//                now failing. Still owns the account (sticky) if it was ever ok.
export type ConnectionStatus = 'unverified' | 'ready' | 'error';

// The GET shape. The key is NEVER returned — only a masked hint (••••last4), and
// only when it decrypts. No ciphertext, no plaintext, ever leaves the store.
export type ConnectionDisplay = {
  provider: string;
  baseUrl: string | null;
  keyHint: string | null;
  hasKey: boolean;
  modelVision: string | null;
  modelReasoning: string | null;
  modelFast: string | null;
  structured: boolean | null;
  timeoutSeconds: number | null;
  status: ConnectionStatus;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export interface LlmConnectionStore extends LlmConnectionReader {
  // Settings → AI. Reads exclude the secret (getDisplay); getProbeCredential is
  // the ONLY read that returns a usable-but-ungated credential, for the verify
  // probe, which must run against a not-yet-healthy row.
  getDisplay(accountId: string): Promise<ConnectionDisplay | null>;
  getProbeCredential(accountId: string): Promise<LlmCredential | null>;
  upsert(accountId: string, input: ConnectionInput, actorUserId: string): Promise<void>;
  remove(accountId: string): Promise<void>;
  // Persist a verify outcome: ok → healthy + detected `structured`; fail →
  // last_error, with last_ok_at untouched so a once-healthy connection keeps
  // owning the account.
  recordProbeResult(accountId: string, result: ProbeResult): Promise<void>;
  // The live-call health primitives, called by the AI routes on every real call
  // (via recordLlmCallHealth). STATE-CHANGE-ONLY: each writes only when the
  // computed status actually flips (ready↔error), so a connection serving a
  // steady stream writes nothing until something changes — no per-call churn.
  // recordOk is a recovery (error→ready); recordError is a regression
  // (ready→error) and never clears last_ok_at (sticky). The commercial BYOK path
  // records through these too — see thalermark-ai-commercial-seam.md §3.1b.
  recordOk(accountId: string): Promise<void>;
  recordError(accountId: string, message: string): Promise<void>;
}

// Columns map 1:1 onto LlmCredential, so there is no transform beyond dropping
// the nulls Drizzle returns for unset columns.
export type ConnectionRow = typeof llmConnections.$inferSelect;

// Postgres NULL means "use the preset's value"; LlmCredential expresses that as
// an absent property, not an explicit undefined, so `structured ?? undefined`
// would still set the key and shadow the preset. Build the object by omission.
function toCredential(row: ConnectionRow, apiKey: string | undefined): LlmCredential {
  const credential: LlmCredential = { provider: row.provider };
  if (apiKey !== undefined) credential.apiKey = apiKey;
  if (row.baseUrl !== null) credential.baseUrl = row.baseUrl;
  if (row.modelVision !== null) credential.modelVision = row.modelVision;
  if (row.modelReasoning !== null) credential.modelReasoning = row.modelReasoning;
  if (row.modelFast !== null) credential.modelFast = row.modelFast;
  if (row.structured !== null) credential.structured = row.structured;
  if (row.timeoutSeconds !== null) credential.timeoutSeconds = row.timeoutSeconds;
  return credential;
}

// Decrypt + map, WITHOUT the health gate. null only when the ciphertext will not
// open (almost certainly a rotated BETTER_AUTH_SECRET, which orphans every stored
// key by design — fail closed, never log the ciphertext, never leak the reason).
// The verify probe needs this: it runs against a row that is not yet healthy.
function decryptRow(row: ConnectionRow, masterKey: Buffer): LlmCredential | null {
  let apiKey: string | undefined;
  if (row.apiKeyCiphertext !== null) {
    try {
      apiKey = decryptSecret(row.apiKeyCiphertext, masterKey);
    } catch {
      return null;
    }
  }
  return toCredential(row, apiKey);
}

// The full "is this row usable, and as what?" decision, with no database in it.
// Exported so it is unit-testable, and so a commercial store over a different row
// source (KMS) reuses the rule rather than reimplementing it. null means: never
// healthy, or the ciphertext will not open.
export function rowToCredential(row: ConnectionRow, masterKey: Buffer): LlmCredential | null {
  // A connection that has never succeeded cannot serve traffic, so a broken save
  // never takes AI live. Once it HAS succeeded it owns the account: later
  // failures surface as errors from the route, they do not fall back to
  // anything. Silent fallback would leave the user unable to tell which key is
  // billing them.
  if (row.lastOkAt === null) return null;
  return decryptRow(row, masterKey);
}

// Derived, never stored. See ConnectionStatus.
export function statusOf(row: ConnectionRow): ConnectionStatus {
  if (row.lastOkAt === null) return row.lastError === null ? 'unverified' : 'error';
  const failingSinceOk = row.lastErrorAt !== null && row.lastErrorAt > row.lastOkAt;
  return failingSinceOk ? 'error' : 'ready';
}

// ••••last4 — enough to recognise your own key, useless to anyone else. Returns
// null when there is no key, or when it will not decrypt (so the UI shows "key
// stored" without a misleading hint rather than crashing).
function maskKey(row: ConnectionRow, masterKey: Buffer): string | null {
  if (row.apiKeyCiphertext === null) return null;
  try {
    return `••••${decryptSecret(row.apiKeyCiphertext, masterKey).slice(-4)}`;
  } catch {
    return null;
  }
}

function toDisplay(row: ConnectionRow, masterKey: Buffer): ConnectionDisplay {
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    keyHint: maskKey(row, masterKey),
    hasKey: row.apiKeyCiphertext !== null,
    modelVision: row.modelVision,
    modelReasoning: row.modelReasoning,
    modelFast: row.modelFast,
    structured: row.structured,
    timeoutSeconds: row.timeoutSeconds,
    status: statusOf(row),
    lastOkAt: row.lastOkAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastError: row.lastError,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// The resolver is called per AI request, outside any tenant transaction (all
// three call sites resolve before opening theirs — they are deferred-tx routes).
// So the store opens its own short tenant tx: the llm_connections RLS policy
// gates on app.current_account_id, which is unset on a bare pool connection, and
// the lookup would silently return zero rows.
//
// account_id is also filtered explicitly, per the house rule — defense in depth,
// and it is what makes the query correct under the BYPASSRLS superuser the
// integration tests run as.
// endpointFetch (server.ts injects guardedFetchForPolicy) turns a user-supplied
// base URL into an SSRF-guarded fetch. Attached to any credential that carries a
// base URL — the user-configurable endpoints (custom / an Ollama override); the
// fixed public presets have no base URL on the credential and so run on the SDK's
// default fetch. This is what makes the connect-time rebinding guard actually
// apply to real AI calls and the verify probe.
export function createLlmConnectionStore(
  db: Database,
  masterKey: Buffer,
  endpointFetch?: (baseUrl: string) => typeof globalThis.fetch,
): LlmConnectionStore {
  const load = (accountId: string): Promise<ConnectionRow | undefined> =>
    withAccountContext(db, { accountId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(llmConnections)
        .where(eq(llmConnections.accountId, accountId))
        .limit(1);
      return row;
    });

  const withGuard = (cred: LlmCredential | null): LlmCredential | null => {
    if (cred?.baseUrl && endpointFetch) cred.fetch = endpointFetch(cred.baseUrl);
    return cred;
  };

  return {
    async getUsable(accountId) {
      const row = await load(accountId);
      return withGuard(row ? rowToCredential(row, masterKey) : null);
    },

    async getDisplay(accountId) {
      const row = await load(accountId);
      return row ? toDisplay(row, masterKey) : null;
    },

    async getProbeCredential(accountId) {
      const row = await load(accountId);
      return withGuard(row ? decryptRow(row, masterKey) : null);
    },

    async upsert(accountId, input, actorUserId) {
      await withAccountContext(db, { accountId }, async (tx) => {
        const [existing] = await tx
          .select({ ciphertext: llmConnections.apiKeyCiphertext })
          .from(llmConnections)
          .where(eq(llmConnections.accountId, accountId))
          .limit(1);

        // apiKey intent: a new key encrypts; null clears; undefined keeps.
        const ciphertext =
          input.apiKey === undefined
            ? (existing?.ciphertext ?? null)
            : input.apiKey === null || input.apiKey === ''
              ? null
              : encryptSecret(input.apiKey, masterKey);

        const now = new Date();
        const values = {
          provider: input.provider,
          baseUrl: input.baseUrl ?? null,
          apiKeyCiphertext: ciphertext,
          modelVision: input.modelVision ?? null,
          modelReasoning: input.modelReasoning ?? null,
          modelFast: input.modelFast ?? null,
          timeoutSeconds: input.timeoutSeconds ?? null,
          // Every write resets health: a changed connection is unverified until
          // the probe re-blesses it, so a bad edit can never keep serving on the
          // old row's last_ok_at. structured is unknown until re-detected.
          structured: null,
          lastOkAt: null,
          lastErrorAt: null,
          lastError: null,
          updatedBy: actorUserId,
          updatedAt: now,
        };

        await tx
          .insert(llmConnections)
          .values({ id: uuidv7(), accountId, createdAt: now, ...values })
          .onConflictDoUpdate({ target: llmConnections.accountId, set: values });
      });
    },

    async remove(accountId) {
      await withAccountContext(db, { accountId }, async (tx) => {
        await tx.delete(llmConnections).where(eq(llmConnections.accountId, accountId));
      });
    },

    async recordProbeResult(accountId, result) {
      await withAccountContext(db, { accountId }, async (tx) => {
        // On success write health, and `structured` ONLY when the probe measured
        // it (a custom endpoint). For a preset it is absent, so the column stays
        // as-is (NULL after an upsert) and keeps tracking the preset in code.
        const set = result.ok
          ? {
              lastOkAt: new Date(),
              lastErrorAt: null,
              lastError: null,
              ...(result.structured !== undefined ? { structured: result.structured } : {}),
            }
          : { lastErrorAt: new Date(), lastError: result.error.slice(0, 300) };
        await tx.update(llmConnections).set(set).where(eq(llmConnections.accountId, accountId));
      });
    },

    async recordOk(accountId) {
      await withAccountContext(db, { accountId }, async (tx) => {
        const [row] = await tx
          .select()
          .from(llmConnections)
          .where(eq(llmConnections.accountId, accountId))
          .limit(1);
        // Only a real recovery writes: error → ready. A row that is already
        // ready (or was never verified) needs no write.
        if (!row || statusOf(row) !== 'error') return;
        await tx
          .update(llmConnections)
          .set({ lastOkAt: new Date(), lastErrorAt: null, lastError: null })
          .where(eq(llmConnections.accountId, accountId));
      });
    },

    async recordError(accountId, message) {
      await withAccountContext(db, { accountId }, async (tx) => {
        const [row] = await tx
          .select()
          .from(llmConnections)
          .where(eq(llmConnections.accountId, accountId))
          .limit(1);
        // Only a real regression writes: ready → error. Already error (or
        // unverified) → no churn. last_ok_at is left alone (sticky): a connection
        // that has ever worked keeps owning the account.
        if (!row || statusOf(row) !== 'ready') return;
        await tx
          .update(llmConnections)
          .set({ lastErrorAt: new Date(), lastError: message.slice(0, 300) })
          .where(eq(llmConnections.accountId, accountId));
      });
    },
  };
}

// The public composition root injects this at apps/api/src/server.ts. One lookup,
// no precedence: a null answer 503s the AI routes, exactly as a missing global
// key used to.
export function settingsLlmCredentials(reader: LlmConnectionReader): LlmCredentialResolver {
  return {
    resolve: (account) => reader.getUsable(account.accountId),
  };
}

// Record the outcome of a live AI call on the connection's health, for the AI
// routes (categorize / extract / nudges). Pass no error on success (a recovery),
// or the thrown error on failure — only a PERMANENT, connection-level failure
// (isConnectionHealthError) is recorded; a transient one is ignored so a blip
// never reddens the chip. Best-effort: a health-write failure is swallowed,
// because it must never turn into a failure of the AI feature itself. A no-op
// when no store is wired (embedders / tests that don't exercise health).
export async function recordLlmCallHealth(
  store: LlmConnectionStore | undefined,
  accountId: string,
  credential: Pick<LlmCredential, 'apiKey'>,
  error?: unknown,
): Promise<void> {
  if (!store) return;
  try {
    if (error === undefined) {
      await store.recordOk(accountId);
    } else if (isConnectionHealthError(error)) {
      await store.recordError(accountId, describeLlmError(error, credential.apiKey));
    }
  } catch {
    // swallow — health is a side signal, never a reason to fail the call
  }
}
