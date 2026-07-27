import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalFsProvider, readLocalObject } from './local-fs.js';
import { verifyFileToken } from './tokens.js';

const SECRET = 'test-secret-at-least-32-characters-long';
const KEY = 'accounts/acc-1/companies/co-1/expenses/exp-1/abc.jpg';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'thalermark-storage-'));
});
afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('local-fs provider', () => {
  it('writes nested keys and reads the bytes back', async () => {
    const provider = createLocalFsProvider({ baseDir, secret: SECRET });
    const bytes = new TextEncoder().encode('receipt-bytes');
    await provider.putObject({ key: KEY, body: bytes, contentType: 'image/jpeg' });

    const onDisk = await readFile(join(baseDir, KEY));
    expect(onDisk.toString()).toBe('receipt-bytes');
    const viaHelper = await readLocalObject(baseDir, KEY);
    expect(viaHelper.toString()).toBe('receipt-bytes');
    const viaGetObject = await provider.getObject(KEY);
    expect(new TextDecoder().decode(viaGetObject)).toBe('receipt-bytes');
  });

  it('hands back a signed /api/files URL that verifies to the key', async () => {
    const provider = createLocalFsProvider({ baseDir, secret: SECRET });
    const url = await provider.getSignedDownloadUrl(KEY, { expiresInSeconds: 60 });
    expect(url.startsWith('/api/files/')).toBe(true);
    const token = url.slice('/api/files/'.length);
    expect(verifyFileToken(token, SECRET)?.key).toBe(KEY);
  });

  it('deletes an object and no-ops on a second delete', async () => {
    const provider = createLocalFsProvider({ baseDir, secret: SECRET });
    await provider.putObject({
      key: KEY,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
    });
    await provider.deleteObject(KEY);
    await expect(stat(join(baseDir, KEY))).rejects.toThrow();
    // Second delete is a no-op (force: true swallows ENOENT).
    await expect(provider.deleteObject(KEY)).resolves.toBeUndefined();
  });

  it('copies an object to a new key, leaving the original', async () => {
    const provider = createLocalFsProvider({ baseDir, secret: SECRET });
    const dest = 'accounts/a/companies/OTHER/branding/copy.jpg';
    await provider.putObject({
      key: KEY,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
    });

    await provider.copyObject(KEY, dest);

    // Both keys resolve independently — the whole point, since deleting either
    // company's logo must not disturb the other's.
    expect(await readLocalObject(baseDir, dest)).toEqual(Buffer.from([1, 2, 3]));
    expect(await readLocalObject(baseDir, KEY)).toEqual(Buffer.from([1, 2, 3]));
    await provider.deleteObject(KEY);
    expect(await readLocalObject(baseDir, dest)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('rejects copying a key that is not there', async () => {
    const provider = createLocalFsProvider({ baseDir, secret: SECRET });
    await expect(
      provider.copyObject('accounts/a/nope.jpg', 'accounts/a/dest.jpg'),
    ).rejects.toThrow();
  });

  it('rejects keys that escape the base dir', async () => {
    const provider = createLocalFsProvider({ baseDir, secret: SECRET });
    await expect(
      provider.putObject({
        key: '../escape.jpg',
        body: new Uint8Array([0]),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/escapes base dir/);
    await expect(readLocalObject(baseDir, '../../etc/passwd')).rejects.toThrow(/escapes base dir/);
  });
});
