import { readLocalObject, verifyFileToken } from '@thalermark/storage';
import { Hono } from 'hono';
import type { AppDeps } from '../app.js';
import { mimeForKey } from '../lib/route-helpers.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// files — local-FS receipt/logo serving. Public path (rls-context skips
// /api/files/*): the HMAC-signed token IS the credential. 404s when the local
// driver isn't active (s3 signed URLs never route here). The token already
// encodes + signs the key, so there's no per-tenant check — minting the token
// (the authenticated GET /receipt above) is the authorization gate. A deps-
// taking sub-app: it closes over `deps.localFileServe` (cf. the deps-free
// items/tax-policies sub-apps). Mounted on createApp via .route() so its schema
// rides on its own FilesAppType instead of bloating AppType past TS7056.
export function filesRoutes(deps: AppDeps) {
  return new Hono<{ Variables: RlsVariables }>().get('/api/files/:token', async (c) => {
    const fileServe = deps.localFileServe;
    if (!fileServe) return c.json({ error: 'not_found' }, 404);
    const payload = verifyFileToken(c.req.param('token'), fileServe.secret);
    if (!payload) return c.json({ error: 'invalid_or_expired_token' }, 403);

    let bytes: Buffer;
    try {
      bytes = await readLocalObject(fileServe.baseDir, payload.key);
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': mimeForKey(payload.key),
      'cache-control': 'private, max-age=3600',
    });
  });
}

export type FilesAppType = ReturnType<typeof filesRoutes>;
