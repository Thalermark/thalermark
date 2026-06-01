import { describe, expect, it } from 'vitest';
import { signFileToken, verifyFileToken } from './tokens.js';

const SECRET = 'test-secret-at-least-32-characters-long';

describe('file download tokens', () => {
  it('round-trips a valid token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = signFileToken({ key: 'a/b/c.jpg', exp }, SECRET);
    expect(verifyFileToken(token, SECRET)).toEqual({ key: 'a/b/c.jpg', exp });
  });

  it('rejects a token signed with a different secret', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = signFileToken({ key: 'a/b/c.jpg', exp }, SECRET);
    expect(verifyFileToken(token, 'a-different-secret-also-long-enough!!')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = signFileToken({ key: 'a/b/c.jpg', exp }, SECRET);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ key: '../../etc/passwd', exp })).toString('base64url')}.${sig}`;
    expect(verifyFileToken(forged, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = signFileToken({ key: 'a/b/c.jpg', exp }, SECRET);
    // 61 seconds past expiry.
    expect(verifyFileToken(token, SECRET, (exp + 61) * 1000)).toBeNull();
    // Still valid one second before expiry.
    expect(verifyFileToken(token, SECRET, (exp - 1) * 1000)).not.toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyFileToken('no-dot-here', SECRET)).toBeNull();
    expect(verifyFileToken('', SECRET)).toBeNull();
    expect(verifyFileToken('not-base64.bad-sig', SECRET)).toBeNull();
  });
});
