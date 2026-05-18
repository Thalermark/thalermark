import {
  type LogLevel,
  configureSync,
  getConsoleSink,
  getLogger as ltGetLogger,
} from '@logtape/logtape';

// Thin wrapper around LogTape. The goal is to keep call sites unaware of the
// underlying library so swapping to Pino (the documented fallback in
// PRODUCTION-READINESS.md) is a single-file change.
//
// Two exports matter:
//   - configureLogger(opts): called once at app boot to set sinks + levels
//   - getLogger(category):   called anywhere to obtain a Logger instance

export type Level = 'debug' | 'info' | 'warning' | 'error' | 'fatal';

export type Logger = {
  debug: (message: string, attrs?: Record<string, unknown>) => void;
  info: (message: string, attrs?: Record<string, unknown>) => void;
  warn: (message: string, attrs?: Record<string, unknown>) => void;
  error: (message: string | Error, attrs?: Record<string, unknown>) => void;
};

export type ConfigureOptions = {
  // Lowest level that passes the root `thalermark` category. Anything below
  // is silently dropped at the logger level (cheaper than a sink filter).
  level?: Level;
};

let configured = false;

// Configure LogTape with a console sink scoped to the `thalermark` category.
// Safe to call multiple times — uses `reset: true` so the second call wins
// (e.g. tests that want a quieter default than apps/api's runtime config).
//
// Synchronous on purpose: getLogger() in library code (telemetry, db, …)
// triggers a lazy default configure inline. An async configure would race
// the first log emit and either drop it or double-attach sinks.
export function configureLogger(opts: ConfigureOptions = {}): void {
  configureSync({
    reset: true,
    sinks: {
      console: getConsoleSink(),
    },
    loggers: [
      {
        category: ['thalermark'],
        lowestLevel: (opts.level ?? 'info') as LogLevel,
        sinks: ['console'],
      },
      // Quiet LogTape's own meta logger; otherwise it warns on every
      // getLogger() call before configure() has run.
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
    ],
  });
  configured = true;
}

// Return a Logger scoped under the `thalermark.<category>` tree. Lazily
// configures with sensible defaults so library code (telemetry, db, …) can
// log without requiring the host app to call configureLogger first.
export function getLogger(category: string | string[]): Logger {
  if (!configured) {
    configureLogger();
  }
  const path = ['thalermark', ...(Array.isArray(category) ? category : [category])];
  const lt = ltGetLogger(path);
  return {
    debug: (message, attrs) => lt.debug(message, attrs ?? {}),
    info: (message, attrs) => lt.info(message, attrs ?? {}),
    warn: (message, attrs) => lt.warn(message, attrs ?? {}),
    error: (message, attrs) => {
      if (message instanceof Error) {
        lt.error('{error}', { error: message, ...(attrs ?? {}) });
      } else {
        lt.error(message, attrs ?? {});
      }
    },
  };
}
