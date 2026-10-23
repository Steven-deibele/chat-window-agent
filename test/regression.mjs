// Regression checks for bugs found during code review. Run: node test/regression.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bounded, atomicWriteFile } from '../src/util.js';
import { registry } from '../src/tools/registry.js';
import { DocxDoc } from '../src/docx_doc.js';
import { XlsxDoc } from '../src/xlsx_doc.js';

await assert.rejects(
  bounded(new Promise(() => {}), 20, 'probe'),
  /probe stalled \(0\.02s\)/,
  'stalled promises must reject instead of exiting silently',
);

registry.registerFile('tools/notes.add.js');
const tool = await registry.get('notes.add');
assert.equal(tool?.meta?.name, 'notes.add', 'user tools register and load');

const shadow = 'tools/fs.read.js';
fs.writeFileSync(shadow, 'export const meta = { name: "fs.read" };\nexport async function run() { return "shadow"; }\n');
try {
  assert.throws(() => registry.registerFile(shadow), /built-in tool/, 'files cannot shadow built-ins');
} finally {
  fs.rmSync(shadow, { force: true });
}

const docx = await DocxDoc.load('test-files/checklist.docx');
await assert.rejects(
  docx.op_replace_text({ find: '^', replace: 'X', regex: true }),
  /must consume at least one character/,
  'zero-length regex replacements are rejected',
);
const regexDoc = await DocxDoc.load('test-files/checklist.docx');
await regexDoc.op_replace_text({ find: 'DRAFT', replace: 'FINAL', regex: true });
assert(regexDoc.snapshot().includes('Vendor Compliance Checklist (FINAL)'), 'worker-backed regex replacement still works');
regexDoc.op_insert_paragraph({ text: 'a'.repeat(38) + 'b', after: 'end' });
// Put the pathological paragraph first: V8 otherwise learns from earlier short
// paragraphs and optimizes the pathological case away before the long text.
const longP = regexDoc.paragraphs().at(-1);
regexDoc.body.insertBefore(longP, regexDoc.body.firstChild);
await assert.rejects(
  regexDoc.op_replace_text({ find: '^(a|aa)+$', replace: 'X', regex: true }),
  /timed out.*(slow pattern|catastrophic backtracking)/,
  'catastrophic regexes are terminated in the worker instead of blocking the process',
);

const xlsx = await XlsxDoc.load('test-files/Budget.xlsx');
assert.throws(
  () => xlsx.op_merge({ sheet: 'Sheet1', range: 'A1:ZZ10000' }),
  /too large/,
  'merge ranges use the same size cap as formatting ranges',
);
assert.throws(
  () => xlsx.op_merge({ sheet: 'Sheet1', range: 'A1:XFD1048577' }),
  /outside the Excel grid/,
  'ranges outside the Excel grid are rejected with a clear error',
);
assert.throws(
  () => xlsx.op_set_cell({ sheet: 'Sheet1', cell: 'A0', value: 'bad' }),
  /outside the Excel grid/,
  'row-zero writes are rejected instead of silently dropped on save',
);
assert.throws(
  () => xlsx.op_freeze({ sheet: 'Sheet1', cell: 'A0' }),
  /outside the Excel grid/,
  'row-zero freeze panes are rejected',
);
assert.throws(
  () => xlsx.op_insert_rows({ sheet: 'Sheet1', at: 0 }),
  /integer "at"/,
  'row-zero inserts are rejected (exceljs is 1-based)',
);
assert.throws(
  () => xlsx.op_delete_cols({ sheet: 'Sheet1', at: 2, count: 0 }),
  /integer "count"/,
  'zero-count deletes are rejected instead of becoming count:1',
);
assert.throws(
  () => xlsx.op_insert_cols({ sheet: 'Sheet1', at: 1.5 }),
  /integer "at"/,
  'fractional splice positions are rejected',
);
{
  // in-memory only (never saved): checks the result message, not the file
  const msg = xlsx.op_set_cell({ sheet: 'Sheet1', cell: '$b$2', value: 7 });
  assert(msg.includes('!B2 ='), `set_cell echoes the normalized ref, got: ${msg}`);
}
assert.throws(
  () => xlsx.op_insert_cols({ sheet: 'Sheet1', at: 20000 }),
  /integer "at" between 1 and 16384/,
  'column splices are bounded by the column grid (XFD), not the row grid',
);

// fs.search: the user regex runs in the worker too — pathological patterns
// are terminated instead of stalling the session's event loop
const searchTool = await registry.get('fs.search');
const searchTarget = 'test-files/search-check.txt';
// Pathological line FIRST: like the docx case, V8 otherwise learns from the
// earlier short line and optimizes the pathological match away
fs.writeFileSync(searchTarget, 'a'.repeat(38) + 'b\nneedle line\n');
try {
  const found = await searchTool.run({ pattern: 'needle', root: searchTarget });
  assert(found.includes('search-check.txt:2: needle line'), 'fs.search finds plain matches');
  await assert.rejects(
    searchTool.run({ pattern: '^(a|aa)+$', root: searchTarget }),
    /timed out.*(slow pattern|catastrophic backtracking)/,
    'pathological fs.search patterns are terminated in the worker',
  );
  await assert.rejects(
    searchTool.run({ pattern: '([', root: searchTarget }),
    /bad search pattern/,
    'invalid fs.search patterns get a friendly error',
  );
} finally {
  fs.rmSync(searchTarget, { force: true });
}

// multi-file search: batched worker calls must attribute hits to the right
// file and line (the batch concatenates many files' lines into one texts[])
const searchDir = 'test-files/search-batch';
fs.mkdirSync(searchDir, { recursive: true });
fs.writeFileSync(`${searchDir}/one.txt`, 'alpha\nshared-needle one\n');
fs.writeFileSync(`${searchDir}/two.txt`, 'shared-needle two\nbeta\nshared-needle two again\n');
try {
  const multi = await searchTool.run({ pattern: 'shared-needle', root: searchDir });
  const rows = multi.split('\n');
  assert.equal(rows.length, 3, `all hits across both files found, got: ${multi}`);
  assert(rows.some((r) => /one\.txt:2: shared-needle one$/.test(r)), 'hit in first file has correct file:line');
  assert(rows.some((r) => /two\.txt:1: shared-needle two$/.test(r)), 'hit at line 1 of second file');
  assert(rows.some((r) => /two\.txt:3: shared-needle two again$/.test(r)), 'second hit in second file keeps its line number');
} finally {
  fs.rmSync(searchDir, { recursive: true, force: true });
}

// tools.create is approval-gated: creation is the only choke point for code
// that later runs ungated in the main process
const createTool = await registry.get('tools.create');
let createPrompts = 0;
const createdFile = 'tools/review-tmp.js';
const deniedCreate = await createTool.run(
  { name: 'review-tmp', code: "return 'must not exist';" },
  { confirm: async () => { createPrompts++; return false; } },
);
assert.match(deniedCreate, /DENIED/, 'tools.create requires approval');
assert.equal(createPrompts, 1, 'tools.create approval prompt was shown');
assert(!fs.existsSync(createdFile), 'denied tools.create writes no file');
const approvedCreate = await createTool.run(
  { name: 'review-tmp', description: 'temp review tool', code: "return 'made:' + args.x;" },
  { confirm: async () => true },
);
try {
  assert.match(approvedCreate, /created and registered/, 'approved tools.create succeeds');
  const made = await registry.get('review-tmp');
  assert.equal(await made.run({ x: '1' }, {}), 'made:1', 'created tool runs after approval');
} finally {
  fs.rmSync(createdFile, { force: true });
}

// long/invalid regex patterns are rejected with friendly errors, not raw throws
await assert.rejects(
  docx.op_replace_text({ find: 'a'.repeat(501), replace: 'X', regex: true }),
  /too long/,
  'overlong regex patterns are rejected',
);
await assert.rejects(
  docx.op_replace_text({ find: '([', replace: 'X', regex: true }),
  /bad regex/,
  'invalid regex patterns get a friendly error',
);

const codeTool = await registry.get('code.run');
let codePrompts = 0;
const denied = await codeTool.run(
  { code: "console.log('must not run')" },
  { confirm: async () => { codePrompts++; return false; } },
);
assert.match(denied, /DENIED/, 'privileged code.run requires approval');
assert.equal(codePrompts, 1, 'code.run approval prompt was shown');
await assert.rejects(
  codeTool.run({ code: "await import('node:http')" }, { confirm: async () => true }),
  /dynamic import\(\) is not supported/,
  'unsupported dynamic imports fail with an actionable error',
);
const methodCallOut = await codeTool.run(
  { code: "const loader = { import: (s) => 'loaded:' + s }; return loader.import('mod');" },
  { confirm: async () => true },
);
assert.match(methodCallOut, /RESULT: loaded:mod/, 'obj.import(...) method calls are not mistaken for dynamic import');
const codeOut = await codeTool.run(
  { code: "console.log(require('node:path').basename('/tmp/example.txt')); return 2 + 2;" },
  { confirm: async () => true },
);
assert.match(codeOut, /example\.txt[\s\S]*RESULT: 4/, 'approved worker code can require modules and return values');
const detachedOut = await codeTool.run(
  { code: "setTimeout(() => console.log('late'), 60000); return 'done';" },
  { confirm: async () => true },
);
assert.match(detachedOut, /RESULT: done/, 'completed workers are terminated instead of leaving snippet timers behind');
const syntaxOut = await codeTool.run({ code: 'if (' }, { confirm: async () => true });
assert.match(syntaxOut, /SYNTAX ERROR/, 'worker syntax errors return to the caller');
const exitOut = await codeTool.run({ code: "require('node:process').exit(0)" }, { confirm: async () => true });
assert.match(exitOut, /worker exited before returning/, 'silent worker exits fail fast');

// reversed ranges normalize to sorted corners for exceljs
const reversed = await XlsxDoc.load('test-files/Budget.xlsx');
assert.equal(reversed.checkedRange('c10:A1').ref, 'A1:C10', 'reversed/lowercase ranges normalize to sorted uppercase refs');
assert.equal(reversed.checkedRange('B2').ref, 'B2', 'single-cell ref stays intact');
assert.equal(reversed.checkedRange('$A$1:$B$2').ref, 'A1:B2', 'absolute ($) refs normalize like relative ones');
reversed.op_merge({ sheet: 'Sheet1', range: 'D20:C19' });
assert(reversed.sheet('Sheet1').getCell('C19').isMerged, 'reversed merge range merges the sorted region');

// async atomic write: correct bytes, no temp file left behind
const atomicTarget = 'test-files/atomic-check.txt';
await atomicWriteFile(atomicTarget, Buffer.from('atomic payload'));
assert.equal(fs.readFileSync(atomicTarget, 'utf8'), 'atomic payload', 'atomicWriteFile writes the buffer');
assert(!fs.readdirSync('test-files').some((f) => f.startsWith('atomic-check.txt.')), 'atomicWriteFile leaves no temp file behind');
fs.rmSync(atomicTarget, { force: true });

// PDF line reconstruction: word breaks from x-gaps, in any width unit space
const { joinPdfItems } = await import('../src/reader.js');
const mkItem = (str, x, y, width, fontSize = 12) => ({ str, transform: [fontSize, 0, 0, fontSize, x, y], width, height: fontSize });
assert.equal(
  joinPdfItems([mkItem('Hello', 0, 100, 40), mkItem('world', 44, 100, 35)]).join(''),
  'Hello world',
  'user-space widths: a 4pt gap reads as a word break',
);
assert.equal(
  joinPdfItems([mkItem('Hello', 0, 100, 3.3), mkItem('world', 44, 100, 2.9)]).join(''),
  'Hello world',
  'text-space widths (~1 unit/glyph) are rescaled so gaps still work',
);
assert.equal(
  joinPdfItems([mkItem('wor', 0, 100, 25), mkItem('ld', 25.2, 100, 15)]).join(''),
  'world',
  'kerned glyph splits inside a word stay joined',
);
assert.deepEqual(
  joinPdfItems([mkItem('line1', 0, 100, 30), mkItem('line2', 0, 80, 30)]),
  ['line1', 'line2'],
  'y movement starts a new line',
);

// replace_text count:"first" = first occurrence in the DOCUMENT, not per paragraph
for (const useRegex of [false, true]) {
  const d = await DocxDoc.load('test-files/checklist.docx');
  d.op_insert_paragraph({ text: 'alpha repeated-token here', after: 'end' });
  d.op_insert_paragraph({ text: 'beta repeated-token here', after: 'end' });
  const msg = await d.op_replace_text({ find: 'repeated-token', replace: 'swapped', count: 'first', regex: useRegex });
  assert.equal(msg, 'replaced 1 occurrence(s)', `${useRegex ? 'regex' : 'literal'} count:first replaces exactly one occurrence`);
  const snap = d.snapshot();
  assert(snap.includes('alpha swapped here'), 'first paragraph was replaced');
  assert(snap.includes('beta repeated-token here'), 'second paragraph keeps the original text');
}

// resolveSilentModelRef (default-on local sidecar): never prompts, never
// downloads — a missing ref falls back to the single downloaded model, and
// returns null (skip the sidecar) when nothing resolves offline. MODELS_DIR
// binds to the cwd at import time, so the checks run in a temp cwd.
{
  fs.mkdirSync('.wh-work', { recursive: true });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join('.wh-work', 'resolver-')));
  const prevCwd = process.cwd();
  process.chdir(tmp); // MODELS_DIR binds to the cwd at import time
  const { resolveSilentModelRef, normalizeModelRef } = await import('../src/local_chat.js');
  try {
    fs.mkdirSync('models', { recursive: true });
    // no ref, no downloads -> null (sidecar silently skipped)
    assert.equal(await resolveSilentModelRef(null), null, 'no model configured and none downloaded -> null');
    // configured ref not on disk and not downloadable -> null, no exception
    assert.equal(await resolveSilentModelRef('hf:e2e/not-a-real-repo/missing.gguf'), null,
      'missing hf: ref must not download or throw');
    // exactly one downloaded model -> it is the fallback
    fs.writeFileSync('models/single.gguf', 'x');
    assert.equal(await resolveSilentModelRef(null), path.join(tmp, 'models', 'single.gguf'),
      'single downloaded model is the silent default');
    // several downloaded, none configured -> null (ambiguous; needs models use)
    fs.writeFileSync('models/second.gguf', 'x');
    assert.equal(await resolveSilentModelRef(null), null, 'several models without a default -> null');
    // explicit ref that exists on disk wins regardless
    fs.writeFileSync('models/pinned.gguf', 'x');
    assert.equal(await resolveSilentModelRef('models/pinned.gguf'), path.join(tmp, 'models', 'pinned.gguf'),
      'existing file ref resolves directly');
    // normalizeModelRef keeps hf: refs verbatim for the offline resolver
    assert.equal(normalizeModelRef('hf:owner/repo:Q4'), 'hf:owner/repo:Q4', 'hf: refs are not rewritten');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('regression checks: ok');
