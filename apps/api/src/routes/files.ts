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
    const mime = mimeForKey(payload.key);
    const headers: Record<string, string> = {
      'content-type': mime,
      'cache-control': 'private, max-age=3600',
      // Belt-and-suspenders against MIME sniffing (Caddy also sets this at the
      // edge, but the api can be fronted by other proxies). The token route is
      // same-origin, so a sniffed response is a minor phishing surface.
      'x-content-type-options': 'nosniff',
    };
    // Force PDFs to download rather than render inline — an inline same-origin
    // PDF is the phishing/sniffing surface called out in review. Images stay
    // inline: company logos are served from this same route and rendered via
    // <img> on invoices and the public pay view, so attachment would break them.
    //
    // A token minted WITH a filename overrides both cases: that is the Download
    // button beside a receipt (TMC-267), which wants a save even for an image
    // whose sibling <img> tag needs the plain inline token. The name arrives
    // inside the signed payload and was validated at mint time, so it cannot
    // carry a quote or a newline into this header.
    if (payload.download) {
      headers['content-disposition'] = `attachment; filename="${payload.download}"`;
    } else if (mime === 'application/pdf') {
      headers['content-disposition'] = 'attachment';
    }
    return c.body(new Uint8Array(bytes), 200, headers);
  });
}

export type FilesAppType = ReturnType<typeof filesRoutes>;
