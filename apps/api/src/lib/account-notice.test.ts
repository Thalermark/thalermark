import { describe, expect, it } from 'vitest';
import { type AccountNoticeProvider, communityAccountNotices } from './account-notice.js';

describe('communityAccountNotices', () => {
  it('returns null for any account — the byte-identical self-host default', async () => {
    expect(await communityAccountNotices.get({ accountId: 'acc_1' })).toBeNull();
    expect(await communityAccountNotices.get({ accountId: 'acc_other' })).toBeNull();
  });

  it('satisfies the AccountNoticeProvider contract', () => {
    // Compile-time: the community default is assignable to the seam interface, so
    // the commercial provider can drop in at the same slot.
    const provider: AccountNoticeProvider = communityAccountNotices;
    expect(typeof provider.get).toBe('function');
  });
});
