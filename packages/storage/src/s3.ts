import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PutObjectInput, StorageProvider } from './types.js';

export interface S3ProviderConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // R2 wants 'auto'; MinIO + AWS want a real region. Defaults to 'us-east-1'
  // (MinIO's default, accepted by AWS) so the common dev path needs no extra
  // config.
  region?: string;
  // Custom endpoint for R2 / MinIO. Omitted for real AWS S3.
  endpoint?: string;
  // MinIO (and some R2 setups) need path-style addressing. Defaults to true
  // whenever a custom endpoint is set, false for plain AWS S3.
  forcePathStyle?: boolean;
}

// One adapter covers R2 (SaaS) and MinIO (dev) — both speak the S3 API. Uses
// presigned GET URLs so the browser fetches receipt bytes straight from the
// object store; the api never proxies them.
export function createS3Provider(config: S3ProviderConfig): StorageProvider {
  const client = new S3Client({
    region: config.region ?? 'us-east-1',
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    name: 's3',
    async putObject({ key, body, contentType }: PutObjectInput) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async getSignedDownloadUrl(key, opts) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: opts?.expiresInSeconds ?? 3600,
      });
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
