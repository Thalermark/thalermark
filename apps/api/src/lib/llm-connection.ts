import type { LlmCredential } from '@thalermark/ai';
import { type Database, llmConnections, withAccountContext } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { decryptSecret } from './crypto.js';
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

// Health writers, called by the AI routes on every real call — not only by the
// save-time probe. A key revoked yesterday must read as unhealthy today without
// anyone pressing Verify.
export interface LlmConnectionStore extends LlmConnectionReader {
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
  return credential;
}

// The health gate, the decryption, and the mapping — the whole "is this row
// usable, and as what?" decision, with no database in it. Exported so it is
// unit-testable, and so a commercial store over a different row source (KMS)
// reuses the rule rather than reimplementing it.
//
// null means: never healthy, or the ciphertext will not open.
export function rowToCredential(row: ConnectionRow, masterKey: Buffer): LlmCredential | null {
  // A connection that has never succeeded cannot serve traffic, so a broken save
  // never takes AI live. Once it HAS succeeded it owns the account: later
  // failures surface as errors from the route, they do not fall back to
  // anything. Silent fallback would leave the user unable to tell which key is
  // billing them.
  if (row.lastOkAt === null) return null;

  let apiKey: string | undefined;
  if (row.apiKeyCiphertext !== null) {
    try {
      apiKey = decryptSecret(row.apiKeyCiphertext, masterKey);
    } catch {
      // Undecryptable — almost certainly BETTER_AUTH_SECRET was rotated, which
      // orphans every stored key by design. Fail closed and let the route 503;
      // the settings page tells them to reconnect. Never log the ciphertext,
      // never leak the reason to the caller.
      return null;
    }
  }
  return toCredential(row, apiKey);
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
export function createLlmConnectionStore(db: Database, masterKey: Buffer): LlmConnectionStore {
  const load = (accountId: string): Promise<ConnectionRow | undefined> =>
    withAccountContext(db, { accountId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(llmConnections)
        .where(eq(llmConnections.accountId, accountId))
        .limit(1);
      return row;
    });

  return {
    async getUsable(accountId) {
      const row = await load(accountId);
      return row ? rowToCredential(row, masterKey) : null;
    },

    async recordOk(accountId) {
      await withAccountContext(db, { accountId }, async (tx) => {
        await tx
          .update(llmConnections)
          .set({ lastOkAt: new Date(), lastErrorAt: null, lastError: null })
          .where(eq(llmConnections.accountId, accountId));
      });
    },

    async recordError(accountId, message) {
      await withAccountContext(db, { accountId }, async (tx) => {
        await tx
          .update(llmConnections)
          // lastOkAt is deliberately left alone: it is the gate, and a
          // connection that has ever worked keeps owning the account.
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
