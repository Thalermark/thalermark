import { Hono } from 'hono';

// The Hono app, separate from the server entry point so tests can mount it
// against a request directly without binding a network port. server.ts is the
// only file that calls @hono/node-server's serve().
export function createApp() {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
