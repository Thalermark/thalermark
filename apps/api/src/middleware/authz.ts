import { type Capability, can } from '@thalermark/validation';
import type { MiddlewareHandler } from 'hono';
import type { RlsVariables } from './rls-context.js';

// Per-route authorization gate. Roles answer "what may this member do inside the
// workspace"; RLS already answered "which workspace's data" upstream. Applied as
// route-level middleware (after rlsContext has set `role`), so every mutating
// route names the capability it requires right next to its path — a forgotten
// gate is visible in review. Reads carry no gate (every role may GET).
export function requireCapability(
  capability: Capability,
): MiddlewareHandler<{ Variables: RlsVariables }> {
  return async (c, next) => {
    if (!can(c.get('role'), capability)) {
      return c.json({ error: 'forbidden', capability }, 403);
    }
    await next();
  };
}
