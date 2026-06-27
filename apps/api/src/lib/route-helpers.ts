// Small request/SQL helpers shared by the root app and the per-domain route
// sub-apps (apps/api/src/routes/*). Lives in lib/ — not app.ts — so a sub-app
// can import it without a cycle back through app.ts.

// UUIDv7 shape guard for `:id` path params. Most routes validate an id before
// it reaches Postgres so a malformed value returns a clean 400 instead of a
// cast error.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Escape the LIKE/ILIKE metacharacters so a search for "50%" or "a_b" matches
// literally instead of as wildcards. Drizzle's ilike() uses the default
// backslash escape character, so backslash itself is escaped too.
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Stored-object key extension → content-type. The local-FS storage adapter
// doesn't persist content-type metadata, so the serve routes (company logo,
// receipt, /api/files/:token) infer it from the key. Shared by the root app
// and the files sub-app.
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  webp: 'image/webp',
};

// Content-type to serve a stored object with, inferred from its key extension.
export function mimeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}
