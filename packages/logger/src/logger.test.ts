import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, getLogger } from './logger.js';

// LogTape's console sink ultimately calls console.{debug,info,warn,error}.
// Spying on those is the most direct way to assert behaviour without
// installing a memory sink.

describe('configureLogger / getLogger', () => {
  let spies: {
    debug: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(async () => {
    spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    await configureLogger({ level: 'debug' });
  });

  afterEach(() => {
    for (const s of Object.values(spies)) s.mockRestore();
  });

  it('returns a logger with the four standard methods', () => {
    const log = getLogger('test');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('routes each level to the matching console method', () => {
    const log = getLogger(['unit', 'levels']);
    log.debug('debug msg');
    log.info('info msg');
    log.warn('warn msg');
    log.error('error msg');

    expect(spies.debug).toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalled();
  });

  it('interpolates structured attrs into messages with placeholders', () => {
    const log = getLogger('attrs');
    log.info('hello {tenant}, count={count}', { count: 3, tenant: 'acme' });
    expect(spies.info).toHaveBeenCalledOnce();
    const formatted = (spies.info.mock.calls[0] ?? []).join(' ');
    expect(formatted).toContain('hello');
    expect(formatted).toContain('acme');
    expect(formatted).toContain('3');
  });

  it('passes an Error object through as a structured attr', () => {
    const log = getLogger('errors');
    const err = new Error('boom');
    log.error(err);
    expect(spies.error).toHaveBeenCalledOnce();
    // The wrapper formats Errors via the `{error}` placeholder, so the
    // message text includes the error's string form.
    const formatted = (spies.error.mock.calls[0] ?? []).join(' ');
    expect(formatted).toContain('Error');
    expect(formatted).toContain('boom');
  });

  it('respects the configured level (info drops debug)', async () => {
    await configureLogger({ level: 'info' });
    const log = getLogger('level-filter');
    log.debug('should be dropped');
    log.info('should pass');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalled();
  });

  it('reconfigure replaces the prior configuration', async () => {
    await configureLogger({ level: 'error' });
    const log = getLogger('reconfig');
    log.warn('warn dropped under error level');
    log.error('error retained');
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalled();
  });
});
