import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { assertSafeDownloadFilename } from './filename.js';
import { signFileToken } from './tokens.js';
import type { PutObjectInput, StorageProvider } from './types.js';

export interface LocalFsProviderConfig {
  // Base directory objects are written under (absolute, or relative to cwd).
  baseDir: string;
  // HMAC secret for signed download tokens.
  secret: string;
  // URL prefix the api serves token-authenticated reads from.
  urlPrefix?: string;
}

// Resolve key → absolute path, rejecting anything that would escape baseDir.
// Keys are app-generated (accounts/<id>/.../<uuid>.<ext>) but a stray `..`
// must never let a download token read /etc/passwd.
function safeResolve(baseDir: string, key: string): string {
  const base = resolve(baseDir);
  const full = resolve(base, key);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`storage: key escapes base dir: ${key}`);
  }
  return full;
}

export function createLocalFsProvider(config: LocalFsProviderConfig): StorageProvider {
  const urlPrefix = config.urlPrefix ?? '/api/files';
  return {
    name: 'local',
    async putObject({ key, body }: PutObjectInput) {
      const full = safeResolve(config.baseDir, key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body);
    },
    async getSignedDownloadUrl(key, opts) {
      if (opts?.downloadFilename) assertSafeDownloadFilename(opts.downloadFilename);
      const ttl = opts?.expiresInSeconds ?? 3600;
      const exp = Math.floor(Date.now() / 1000) + ttl;
      const token = signFileToken({ key, exp, download: opts?.downloadFilename }, config.secret);
      return `${urlPrefix}/${token}`;
    },
    async getObject(key) {
      return new Uint8Array(await readFile(safeResolve(config.baseDir, key)));
    },
    async deleteObject(key) {
      // force: true swallows ENOENT so a double-delete (or deleting an object
      // whose write never landed) is a no-op rather than a throw.
      await rm(safeResolve(config.baseDir, key), { force: true });
    },
    async copyObject(sourceKey, destKey) {
      const dest = safeResolve(config.baseDir, destKey);
      // Same mkdir-then-write shape as putObject: a destination key nests into
      // directories that may not exist yet.
      await mkdir(dirname(dest), { recursive: true });
      // Deliberately NOT force/COPYFILE_EXCL-free of an error: a missing source
      // should reject, matching the S3 adapter and the interface contract.
      await copyFile(safeResolve(config.baseDir, sourceKey), dest);
    },
  };
}

// Read an object's bytes from the local store. Used by the api /api/files/:token
// route (slice 8.9g) after verifyFileToken resolves a token to its key — the
// local-FS adapter has no external server to stream from, so the api does it.
export async function readLocalObject(baseDir: string, key: string): Promise<Buffer> {
  return readFile(safeResolve(baseDir, key));
}
