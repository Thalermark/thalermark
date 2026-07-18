import { describe, expect, it } from 'vitest';
import { resolveHostContext } from './config.js';

// Pure env → host-context resolution; no DB. os_platform / node_version are read
// from the live process, so they're asserted against process.* rather than a
// fixture. product_version / deployment_type come from the injected env.
describe('resolveHostContext', () => {
  it('reads product_version from APP_VERSION and deployment_type from DEPLOYMENT_TYPE', () => {
    const host = resolveHostContext({
      APP_VERSION: 'v1.2.3',
      DEPLOYMENT_TYPE: 'cloud',
    } as NodeJS.ProcessEnv);
    expect(host.product_version).toBe('v1.2.3');
    expect(host.deployment_type).toBe('cloud');
  });

  it('defaults to dev / self-hosted when the env vars are unset', () => {
    const host = resolveHostContext({} as NodeJS.ProcessEnv);
    expect(host.product_version).toBe('dev');
    expect(host.deployment_type).toBe('self-hosted');
  });

  it('treats an empty APP_VERSION as unset (a bare `APP_VERSION=` → dev)', () => {
    const host = resolveHostContext({ APP_VERSION: '' } as NodeJS.ProcessEnv);
    expect(host.product_version).toBe('dev');
  });

  it('treats any non-cloud DEPLOYMENT_TYPE as self-hosted', () => {
    const host = resolveHostContext({ DEPLOYMENT_TYPE: 'something-else' } as NodeJS.ProcessEnv);
    expect(host.deployment_type).toBe('self-hosted');
  });

  it('reports the live node version and a platform mapped to the telemetry enum', () => {
    const host = resolveHostContext({} as NodeJS.ProcessEnv);
    expect(host.node_version).toBe(process.versions.node);
    expect(['linux', 'macos', 'windows']).toContain(host.os_platform);
  });
});
