import { describe, expect, it } from 'vitest';
import { createS3Provider } from './s3.js';

// The presigner computes the SigV4 signature locally (no network), so we can
// assert the download URL shape offline. put/delete hit the network and are
// exercised against MinIO when the receipt endpoints wire this in (8.9g).
describe('s3 provider', () => {
  it('builds a presigned GET URL for a key', async () => {
    const provider = createS3Provider({
      bucket: 'thalermark',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
    });
    const url = await provider.getSignedDownloadUrl('accounts/a/receipt.jpg', {
      expiresInSeconds: 120,
    });
    // Path-style (endpoint set) → host/bucket/key, signed query params present.
    expect(url).toContain('localhost:9000/thalermark/accounts/a/receipt.jpg');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=120');
  });
});
