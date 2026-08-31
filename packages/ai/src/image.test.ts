import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { normalizeReceiptImage } from './image.js';

// TMC-297 — the model's copy of a receipt is capped; the stored original is
// not this function's business. The invariants worth pinning: a big image
// shrinks with its aspect ratio intact, a small one passes through
// BYTE-IDENTICAL (no re-encode generation loss), and undecodable bytes fall
// through untouched rather than failing locally.

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = '48px sans-serif';
  ctx.fillText('ACME TOOLS $19.99', 20, Math.min(80, height - 4));
  return new Uint8Array(await canvas.encode('png'));
}

async function dimensionsOf(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const image = await loadImage(Buffer.from(bytes));
  return { width: image.width, height: image.height };
}

describe('normalizeReceiptImage', () => {
  it('downscales a camera-sized landscape image to the cap, aspect intact', async () => {
    const out = await normalizeReceiptImage(await makePng(4000, 3000));
    const dims = await dimensionsOf(out);
    expect(dims).toEqual({ width: 1600, height: 1200 });
  });

  it('downscales a portrait phone photo the same way', async () => {
    const out = await normalizeReceiptImage(await makePng(3000, 4000));
    const dims = await dimensionsOf(out);
    expect(dims).toEqual({ width: 1200, height: 1600 });
  });

  it('passes an already-small image through byte-identical', async () => {
    const original = await makePng(800, 600);
    const out = await normalizeReceiptImage(original);
    expect(out).toBe(original);
  });

  it('passes an image exactly at the cap through untouched', async () => {
    const original = await makePng(1600, 900);
    const out = await normalizeReceiptImage(original);
    expect(out).toBe(original);
  });

  it('passes undecodable bytes through rather than failing locally', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await normalizeReceiptImage(garbage);
    expect(out).toBe(garbage);
  });

  it('shrinks the payload, which is the point', async () => {
    const original = await makePng(4000, 3000);
    const out = await normalizeReceiptImage(original);
    expect(out.byteLength).toBeLessThan(original.byteLength);
  });
});
