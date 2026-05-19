import { Hono } from 'hono';
import type { ApiAuth } from './lib/auth.js';

export type AppDeps = {
  auth: ApiAuth;
};

// The Hono app, separate from the server entry point so tests can mount it
// against a request directly without binding a network port. server.ts is the
// only file that calls @hono/node-server's serve().
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Better Auth owns everything under /api/auth/*. Cookie strategy is the
  // default; mobile clients (Phase 6) will swap in bearer-token plugin then.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
