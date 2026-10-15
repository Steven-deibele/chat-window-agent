// Read-only snapshots of any supported document for AI context.
import fs from 'node:fs';
import path from 'node:path';

export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.csv' || ext === '.txt' || ext === '.md') return 'text';
  throw new Error(`unsupported file type: ${ext} (${file}) — supported: .docx .xlsx .xlsm .pdf .csv .txt .md`);
}

export async function snapshotFile(file, { maxChars = 20000 } = {}) {
  const kind = kindOf(file);
  if (kind === 'docx') {
    const { DocxDoc } = await import('./docx_doc.js');
    return { kind, text: (await DocxDoc.load(file)).snapshot(maxChars) };
  }
  if (kind === 'xlsx') {
    const { XlsxDoc } = await import('./xlsx_doc.js');
    return { kind, text: (await XlsxDoc.load(file)).snapshot(80, 30, maxChars) };
  }
  if (kind === 'pdf') return { kind, text: await pdfText(file, maxChars) };
  const text = fs.readFileSync(file, 'utf8');
  return { kind, text: text.length > maxChars ? text.slice(0, maxChars) + `\n<TRUNCATED (${text.length - maxChars} more chars)>` : text };
}

/** Reconstruct lines from pdf.js text items: group by Y position; within a
 *  line a space is inserted only when the x-gap between items looks like a
 *  word break (kerned glyph splits inside a word stay joined).
 *  Exported for tests — pure function, no pdf.js objects required. */
export function joinPdfItems(items) {
  let lastY = null, line = '', prevEnd = null;
  const lines = [];
  for (const item of items) {
    if (!item.str) continue;
    // transform is normally present, but guard: pdfjs versions differ and a
    // crash here would lose the whole document snapshot
    const t = item.transform || [];
    const y = Math.round(t[5] ?? 0);
    if (lastY !== null && Math.abs(y - lastY) > 2) { if (line) lines.push(line); line = ''; prevEnd = null; }
    const x = t[4];
    // transform-derived metrics are always in the same coordinate space as x
    const fontH = Math.hypot(t[2] ?? 0, t[3] ?? 0) || 10;
    const scaleX = Math.hypot(t[0] ?? 0, t[1] ?? 0);
    let width = Number.isFinite(item.width) ? item.width : NaN;
    // pdf.js documents width as "device space"; observed versions return the
    // same space as the transform translation, but a version reporting TEXT
    // space (~1 unit per glyph) would make every gap look like a word break.
    // Such widths are impossibly small for user space — rescale them.
    if (Number.isFinite(width) && scaleX > 0 && width < scaleX * item.str.length * 0.1) width *= scaleX;
    const gap = prevEnd !== null && Number.isFinite(x) ? x - prevEnd : 0;
    const wordGap = Math.max(1, fontH * 0.15);
    const needsSpace = line && !line.endsWith(' ') && !item.str.startsWith(' ') && gap > wordGap;
    line += (needsSpace ? ' ' : '') + item.str;
    prevEnd = Number.isFinite(x) && Number.isFinite(width) ? x + width : null;
    lastY = y;
  }
  if (line) lines.push(line);
  return lines;
}

async function pdfText(file, maxChars) {
  let extractedChars = 0;
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  let accLen = 0; // track incrementally — rejoining all pages each loop is O(n^2)
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const lines = joinPdfItems(tc.items);
    for (const item of tc.items) extractedChars += (item.str || '').length;
    const block = `--- page ${i}/${pdf.numPages} ---\n` + lines.join('\n');
    accLen += block.length;
    pages.push(block);
    if (accLen > maxChars * 2) break;
  }
  let out = `${file}: ${pdf.numPages} page(s)\n` + pages.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n<TRUNCATED (${out.length - maxChars} more chars; ${pdf.numPages} pages total)>`;
  if (extractedChars < 10) out += '\n<note: no extractable text — this PDF may be a scan (OCR not supported)>';
  return out;
}
