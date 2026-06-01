import { describe, expect, it } from 'vitest';
import { createStorageProvider } from './factory.js';

const SECRET = 'test-secret-at-least-32-characters-long';

describe('createStorageProvider', () => {
  it('defaults to the local adapter when STORAGE_DRIVER is unset', () => {
    const provider = createStorageProvider({ STORAGE_URL_SECRET: SECRET });
    expect(provider.name).toBe('local');
  });

  it('requires STORAGE_URL_SECRET for the local adapter', () => {
    expect(() => createStorageProvider({ STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_URL_SECRET/);
  });

  it('builds the s3 adapter with bucket + credentials', () => {
    const provider = createStorageProvider({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'thalermark',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://localhost:9000',
    });
    expect(provider.name).toBe('s3');
  });

  it('requires bucket + credentials for the s3 adapter', () => {
    expect(() => createStorageProvider({ STORAGE_DRIVER: 's3', S3_BUCKET: 'thalermark' })).toThrow(
      /S3_ACCESS_KEY_ID/,
    );
  });

  it('throws on an unknown driver', () => {
    expect(() => createStorageProvider({ STORAGE_DRIVER: 'azure' })).toThrow(
      /unknown STORAGE_DRIVER/,
    );
  });
});
