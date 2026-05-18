import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const app = createApp();

const server = serve(
  {
    fetch: app.fetch,
    port: env.port,
  },
  (info) => {
    console.info(`[api] listening on http://localhost:${info.port} (${env.nodeEnv})`);
  },
);

// Graceful shutdown: stop accepting new connections, then exit. Idempotent
// in case both signals fire on a container stop.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[api] received ${signal}, draining`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
