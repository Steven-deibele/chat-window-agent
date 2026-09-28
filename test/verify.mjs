// Asserts results of e2e runs. Usage: node test/verify.mjs budget|hello|fill|retry|watch
import path from 'node:path';
import fs from 'node:fs';
import { XlsxDoc } from '../src/xlsx_doc.js';
import { DocxDoc } from '../src/docx_doc.js';

const scenario = process.argv[2];
const fails = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) fails.push(name);
}
const F = (n) => path.resolve('test-files', n);

if (scenario === 'budget') {
  const d = await XlsxDoc.load(F('Budget.xlsx'));
  const ws = d.sheet('Sheet1');
  check('B2 = 9999', ws.getCell('B2').value === 9999, String(ws.getCell('B2').value));
  check('A5 = "New item"', ws.getCell('A5').value === 'New item', String(ws.getCell('A5').value));
  check('E5 formula SUM(B5:D5)', ws.getCell('E5').value?.formula === 'SUM(B5:D5)', JSON.stringify(ws.getCell('E5').value));
  check('A1 bold', ws.getCell('A1').font?.bold === true);
  check('A1 fill FFFF00', ws.getCell('A1').fill?.fgColor?.argb === 'FFFFFF00', JSON.stringify(ws.getCell('A1').fill?.fgColor));
  check('col A width 24', Math.abs((ws.getColumn('A').width || 0) - 24) < 1, String(ws.getColumn('A').width));
  check('TOTAL row shifted to 6 with formula', ws.getCell('A6').value === 'TOTAL' && ws.getCell('B6').value?.formula === 'SUM(B2:B5)', JSON.stringify(ws.getCell('B6').value));
  check('backup exists', fs.existsSync(F('backups')) && fs.readdirSync(F('backups')).some((f) => f.startsWith('Budget.xlsx.')));
} else if (scenario === 'hello') {
  const d = await DocxDoc.load(F('checklist.docx'));
  const snap = d.snapshot();
  check('DRAFT -> FINAL', snap.includes('Vendor Compliance Checklist (FINAL)'), snap.split('\n')[0]);
  check('inserted tail paragraph', snap.includes('Prepared by chat-window-agent.'));
  check('P0 bold', d.topParagraphs()[0].getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'b').length > 0);
  check('reparse: table intact', snap.includes('[TABLE 0] 4 rows'));
} else if (scenario === 'fill' || scenario === 'watch') {
  const d = await DocxDoc.load(F('checklist.docx'));
  const snap = d.snapshot();
  check('item1 status', snap.includes('C1: ☒ Compliant (Policy.pdf p1 §1)'), snap.split('\n')[4]);
  check('item2 status', snap.includes('☒ Compliant (Policy.pdf p1 §2)'));
  check('item3 status', snap.includes('✗ Non-compliant (Policy.pdf p1 §3'));
  check('evidence bullet flipped', snap.includes('☒ All evidence attached'));
  check('appended review-method row', snap.includes('AI review of Policy.pdf + Budget.xlsx'));
  check('findings paragraph', snap.includes('Findings: item 3 lacks the annual review record'));
  check('table now 5 rows', snap.includes('[TABLE 0] 5 rows'));
} else if (scenario === 'retry') {
  const d = await XlsxDoc.load(F('Budget.xlsx'));
  check('A1 = "recovered" after feedback retry', d.sheet('Sheet1').getCell('A1').value === 'recovered', String(d.sheet('Sheet1').getCell('A1').value));
} else if (scenario === 'agent') {
  const x = await XlsxDoc.load(F('Budget.xlsx'));
  check('agent B2 = 4242', x.sheet('Sheet1').getCell('B2').value === 4242, String(x.sheet('Sheet1').getCell('B2').value));
  check('agent A1 bold', x.sheet('Sheet1').getCell('A1').font?.bold === true);
  check('agent tool file created', fs.existsSync('tools/notes.add.js'));
  check('agent tool ran (side effect)', fs.readFileSync(F('agent-note.txt'), 'utf8').includes('agent was here'));
  check('agent downloaded file', fs.existsSync(F('downloaded.html')) && fs.readFileSync(F('downloaded.html'), 'utf8').includes('Mock AI Chat'));
} else {
  console.error('unknown scenario'); process.exit(2);
}

console.log(fails.length ? `\n${fails.length} FAIL` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
