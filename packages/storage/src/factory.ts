import { createLocalFsProvider } from './local-fs.js';
import { createS3Provider } from './s3.js';
import type { StorageProvider } from './types.js';

// Env contract matches the committed .env.example "Object storage" block:
// STORAGE_DRIVER selects the adapter, the S3_* group configures the
// S3-compatible one, STORAGE_LOCAL_PATH points the local adapter at a
// directory. STORAGE_URL_SECRET signs the /api/files download tokens the
// local adapter hands out.
export interface StorageEnv {
  STORAGE_DRIVER?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
  STORAGE_LOCAL_PATH?: string;
  STORAGE_URL_SECRET?: string;
}

// Self-host defaults to the local adapter (zero external deps — receipts land
// on the api container's disk and are read back through the signed /api/files
// token route). Dev points STORAGE_DRIVER=s3 at MinIO; SaaS points it at R2.
// An unknown driver throws at boot rather than silently picking one, so a typo
// in compose env fails loudly instead of dropping receipts into the void.
export function createStorageProvider(env: StorageEnv): StorageProvider {
  const driver = env.STORAGE_DRIVER?.trim().toLowerCase() || 'local';

  if (driver === 'local') {
    const secret = env.STORAGE_URL_SECRET?.trim();
    if (!secret) {
      throw new Error('STORAGE_DRIVER=local requires STORAGE_URL_SECRET (signs download tokens)');
    }
    return createLocalFsProvider({
      baseDir: env.STORAGE_LOCAL_PATH?.trim() || './data/storage',
      secret,
    });
  }

  if (driver === 's3') {
    const bucket = env.S3_BUCKET?.trim();
    const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY',
      );
    }
    return createS3Provider({
      bucket,
      accessKeyId,
      secretAccessKey,
      region: env.S3_REGION?.trim() || undefined,
      endpoint: env.S3_ENDPOINT?.trim() || undefined,
      // String env → bool. Only an explicit 'false' disables it; unset falls
      // through to the adapter's endpoint-aware default.
      forcePathStyle:
        env.S3_FORCE_PATH_STYLE === undefined
          ? undefined
          : env.S3_FORCE_PATH_STYLE.trim().toLowerCase() !== 'false',
    });
  }

  throw new Error(`unknown STORAGE_DRIVER: ${driver}`);
}
