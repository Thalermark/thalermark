// Object storage is provider-agnostic so the SaaS host (Cloudflare R2), dev
// (MinIO), and tiny self-host (local filesystem) all sit behind one interface
// with no call-site changes — receipts are written and read the same way
// regardless of where the bytes live. The interface is intentionally narrow:
// upload, hand back a time-limited download URL, read, delete, copy. It stays
// that way — no list/move until a feature needs them.
//
// copyObject earned its place when a company's setup became copyable to another
// company: a storage key embeds the company id, so two rows can never share one
// (deleting either would break both).

export interface PutObjectInput {
  // Storage key, e.g. accounts/<id>/companies/<id>/expenses/<id>/<uuid>.jpg.
  // Forward-slash separated; the local-FS adapter maps it onto nested dirs.
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface GetSignedUrlOptions {
  // URL lifetime in seconds. Default 3600 (one hour) — long enough to render
  // a receipt in the browser, short enough that a leaked URL goes stale.
  expiresInSeconds?: number;
}

export interface StorageProvider {
  // Which adapter is live. Lets a consumer branch on the fs case (its signed
  // URLs are served by the api's own /api/files token route rather than the
  // object store directly).
  readonly name: 's3' | 'local';
  putObject(input: PutObjectInput): Promise<void>;
  // For s3 this is a presigned GET URL the browser hits directly; for local-FS
  // it is a relative `/api/files/<token>` URL the api serves itself.
  getSignedDownloadUrl(key: string, opts?: GetSignedUrlOptions): Promise<string>;
  // Read an object's bytes back server-side. Distinct from getSignedDownloadUrl
  // (which hands a URL to the browser): receipt extraction (slice 8.9h) needs
  // the bytes in-process to feed the vision model. Rejects when the key is
  // absent.
  getObject(key: string): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
  // Duplicate an object under a new key. Needed because storage keys embed the
  // company id (accounts/<a>/companies/<c>/...), so a copied company's logo must
  // live at its own key — sharing the string would mean deleting either
  // company's logo silently breaks the other's.
  //
  // Server-side where the backend supports it (S3 CopyObject, an fs copy), so
  // the bytes never round-trip through the API process. Rejects when the source
  // key is absent.
  copyObject(sourceKey: string, destKey: string): Promise<void>;
}
