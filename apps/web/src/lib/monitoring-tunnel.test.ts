import { describe, expect, it, vi } from 'vitest';
import { tunnelEnvelope } from './monitoring-tunnel';

const DSN = 'https://pubkey@glitch.example/25702';

// Build a raw envelope: a JSON header line (carrying the originating dsn) + a
// couple of item lines, as the browser SDK sends.
function envelope(header: Record<string, unknown>): ArrayBuffer {
  const text = `${JSON.stringify(header)}\n{"type":"event"}\n{}\n`;
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function okFetch() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;
}

describe('tunnelEnvelope', () => {
  it('is inert (204) when no DSN is configured, and never forwards', async () => {
    const f = okFetch();
    const res = await tunnelEnvelope(undefined, envelope({ dsn: DSN }), f);
    expect(res.status).toBe(204);
    expect(f).not.toHaveBeenCalled();
  });

  it('forwards a matching envelope to the DSN host + project, returns 201', async () => {
    const f = okFetch();
    const res = await tunnelEnvelope(DSN, envelope({ dsn: DSN }), f);
    expect(res.status).toBe(201);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(
      'https://glitch.example/api/25702/envelope/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects (403) an envelope whose DSN host differs — no open relay', async () => {
    const f = okFetch();
    const res = await tunnelEnvelope(DSN, envelope({ dsn: 'https://evil.example/25702' }), f);
    expect(res.status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects (403) an envelope for a different project on the same host', async () => {
    const f = okFetch();
    const res = await tunnelEnvelope(DSN, envelope({ dsn: 'https://glitch.example/999' }), f);
    expect(res.status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it('400s a malformed envelope (no header line / missing dsn)', async () => {
    const f = okFetch();
    const noNewline = new TextEncoder().encode('not-an-envelope').buffer as ArrayBuffer;
    expect((await tunnelEnvelope(DSN, noNewline, f)).status).toBe(400);
    expect((await tunnelEnvelope(DSN, envelope({ nope: true }), f)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it('502s when the upstream ingest fails', async () => {
    const bad = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect((await tunnelEnvelope(DSN, envelope({ dsn: DSN }), bad)).status).toBe(502);

    const threw = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    expect((await tunnelEnvelope(DSN, envelope({ dsn: DSN }), threw)).status).toBe(502);
  });
});
