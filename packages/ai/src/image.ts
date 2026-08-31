import { createCanvas, loadImage } from '@napi-rs/canvas';

// Receipt images are normalized before ANY vision call (TMC-297). A phone
// camera hands over 12 megapixels; the model needs a fraction of that to read
// a receipt, and the surplus is pure cost: on a CPU-only local model the first
// real device run spent 186s just encoding the photo and died at the 300s
// ceiling mid-answer, and on a hosted API the same surplus is image tokens
// billed on every scan.
//
// This happens SERVER-SIDE, on the copy handed to the model only, which is the
// whole design (see the ticket): every client benefits — including installed
// phone apps that will never update — and the STORED receipt stays the
// full-resolution original, because the photo is the user's substantiation and
// only the model's copy is disposable. Same reasoning as the PDF render next
// door: in-memory only, never persisted.
//
// The cap keeps small receipt print legible to the model. 1600px on the long
// side is comfortably above what dense register tape needs, and re-encoding as
// JPEG at 80 keeps text crisp; an image already at or under the cap passes
// through BYTE-IDENTICAL (no decode/re-encode generation loss for well-behaved
// clients).
const MAX_DIMENSION_PX = 1600;
const JPEG_QUALITY = 80;

// Best-effort by design: bytes that will not decode here pass through
// untouched and the provider gets to say what is wrong with them — a local
// decode failure must never turn an image a provider could have read into a
// local error.
export async function normalizeReceiptImage(bytes: Uint8Array): Promise<Uint8Array> {
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(Buffer.from(bytes));
  } catch {
    return bytes;
  }
  const { width, height } = image;
  if (!width || !height || Math.max(width, height) <= MAX_DIMENSION_PX) return bytes;

  const scale = MAX_DIMENSION_PX / Math.max(width, height);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d');
  // Receipts are paper on a background; a white fill keeps any transparency
  // (screenshots, scanned PNGs) from becoming black when re-encoded as JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outWidth, outHeight);
  ctx.drawImage(image, 0, 0, outWidth, outHeight);
  return new Uint8Array(await canvas.encode('jpeg', JPEG_QUALITY));
}
