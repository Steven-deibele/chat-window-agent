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

async function pdfText(file, maxChars) {
  let extractedChars = 0;
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // reconstruct lines using item Y positions
    let lastY = null, line = '';
    const lines = [];
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
      extractedChars += item.str.length;
      lastY = y;
    }
    if (line) lines.push(line);
    pages.push(`--- page ${i}/${pdf.numPages} ---\n` + lines.join('\n'));
    if (pages.join('\n').length > maxChars * 2) break;
  }
  let out = `${file}: ${pdf.numPages} page(s)\n` + pages.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n<TRUNCATED (${out.length - maxChars} more chars; ${pdf.numPages} pages total)>`;
  if (extractedChars < 10) out += '\n<note: no extractable text — this PDF may be a scan (OCR not supported)>';
  return out;
}
