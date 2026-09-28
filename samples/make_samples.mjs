// Creates test-files/: checklist.docx (compliance checklist), Budget.xlsx, Policy.pdf.
// Run: node samples/make_samples.mjs [--out test-files]
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

const outDir = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'test-files');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const p = (text, { bold = false, size } = {}) =>
  `<w:p ${NS}><w:r>${bold || size ? `<w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size * 2}"/>` : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const tc = (text, { bold = false } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${p(text, { bold })}</w:tc>`;
const tr = (cells, { header = false } = {}) => `<w:tr>${cells.map((c) => tc(c, { bold: header })).join('')}</w:tr>`;
const tbl = (rows) => `<w:tbl ${NS}><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>
${p('Vendor Compliance Checklist (DRAFT)', { bold: true, size: 16 })}
${p('Reviewed quarterly. Mark each item and cite evidence.')}
${tbl([
  tr(['Requirement', 'Status'], { header: true }),
  tr(['Fire safety training completed', '☐']),
  tr(['Passwords rotated quarterly', '☐']),
  tr(['Backup policy documented and reviewed', '☐']),
])}
${p('Notes:')}
${p('☐ All evidence attached')}
</w:body></w:document>`;

const zip = new JSZip();
zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file('word/document.xml', documentXml);
fs.writeFileSync(path.join(outDir, 'checklist.docx'), await zip.generateAsync({ type: 'nodebuffer' }));

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Sheet1');
ws.addRow(['Item', 'Q1', 'Q2', 'Q3', 'Q4', 'Year']);
ws.addRow(['Hardware', 1200, 1300, 1250, 1400, { formula: 'SUM(B2:E2)' }]);
ws.addRow(['Licenses', 800, 800, 800, 800, { formula: 'SUM(B3:E3)' }]);
ws.addRow(['Travel', 500, 200, 350, 900, { formula: 'SUM(B4:E4)' }]);
ws.addRow(['TOTAL', { formula: 'SUM(B2:B4)' }, { formula: 'SUM(C2:C4)' }, { formula: 'SUM(D2:D4)' }, { formula: 'SUM(E2:E4)' }, { formula: 'SUM(F2:F4)' }]);
await wb.xlsx.writeFile(path.join(outDir, 'Budget.xlsx'));

// Minimal single-page PDF with correct xref offsets.
const lines = [
  'ACME Security Policy (BP-1)',
  '1. Fire safety training is mandatory for all staff and was completed in Q1.',
  '2. Passwords must be rotated every 90 days; last rotation 2026-06-30.',
  '3. Backup policy BP-7 exists; the required annual review is pending.',
];
let content = 'BT /F1 12 Tf 72 720 Td 14 TL\n';
for (const l of lines) content += `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*\n`;
content += 'ET';
const objs = [
  '<</Type/Catalog/Pages 2 0 R>>',
  '<</Type/Pages/Kids[3 0 R]/Count 1>>',
  '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
  '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
fs.writeFileSync(path.join(outDir, 'Policy.pdf'), Buffer.from(pdf, 'latin1'));

console.log(`samples written to ${outDir}${path.sep}`);
