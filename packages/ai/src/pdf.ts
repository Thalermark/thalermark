import { pdfToPng } from 'pdf-to-png-converter';

// Render page 1 of a PDF receipt to PNG bytes. Vision models take images, not
// PDFs (and the ones that do, like Anthropic, we still funnel through here so
// every provider — including image-only Ollama — gets a uniform input, per the
// 8.9h PDF-handling decision). Page 1 is the receipt; multi-page PDFs are rare
// for receipts and the extra pages aren't worth the tokens.
//
// pdf-to-png-converter wraps Mozilla's pdf.js + a native canvas, so there's no
// browser / system binary dependency — the original PDF stays untouched in
// storage; this PNG is in-memory only and never persisted (locked decision #9).
export async function renderPdfFirstPageToPng(bytes: Uint8Array): Promise<Uint8Array> {
  const pages = await pdfToPng(Buffer.from(bytes), {
    pagesToProcess: [1],
    // 2× the PDF's native size — enough resolution for the model to read small
    // receipt print without ballooning the image past what's worth sending.
    viewportScale: 2.0,
  });
  const content = pages[0]?.content;
  if (!content) throw new Error('pdf has no renderable pages');
  return new Uint8Array(content);
}
