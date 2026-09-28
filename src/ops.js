// Op validation, backup and apply pipeline shared by edit/fill modes.
import fs from 'node:fs';
import path from 'node:path';

export const OPS_SPEC = {
  docx: `"op":"replace_text"   {find, replace, count?:"all"|"first", regex?:bool}
"op":"insert_paragraph" {text, style?:string, after: <P-index from snapshot> | "end"}
"op":"delete_paragraph" {index: <P-index>} | {match: "exact paragraph text"}
"op":"set_paragraph_style" {index | match, style}
"op":"format_paragraph" {index | match, bold?, italic?, underline?, size?}   // size in pt
"op":"set_table_cell"   {table: <TABLE index>, row, col, text}              // row/col are 0-based, from the snapshot grid
"op":"append_table_row" {table, cells: [text, ...]}                        // clones last row style
"op":"insert_table_row" {table, at: <row index>, cells: [text, ...]}`,
  xlsx: `"op":"set_cell"       {sheet, cell:"B2", value: <string|number|bool|null>} or {sheet, cell, formula:"SUM(A1:A5)"}
"op":"insert_rows"     {sheet, at, count?}
"op":"delete_rows"     {sheet, at, count?}
"op":"insert_cols"     {sheet, at, count?}
"op":"delete_cols"     {sheet, at, count?}
"op":"set_format"      {sheet, range:"A1:C1", bold?, italic?, size?, font_color?:"RRGGBB", fill?:"RRGGBB", align?:"left|center|right", wrap?:bool, number_format?:"0.00"}
"op":"add_sheet"       {name}
"op":"rename_sheet"    {from, to}
"op":"delete_sheet"    {name}
"op":"set_col_width"   {sheet, col:"A", width}
"op":"set_row_height"  {sheet, row, height}
"op":"merge"/"unmerge" {sheet, range:"A1:B2"}
"op":"freeze"          {sheet, cell:"A2"}`,
};

const REQUIRED = {
  docx: {
    replace_text: ['find', 'replace'],
    insert_paragraph: ['text'],
    delete_paragraph: [],
    set_paragraph_style: ['style'],
    format_paragraph: [],
    set_table_cell: ['table', 'row', 'col', 'text'],
    append_table_row: ['table'],
    insert_table_row: ['table', 'at'],
  },
  xlsx: {
    set_cell: ['sheet', 'cell'],
    insert_rows: ['sheet', 'at'], delete_rows: ['sheet', 'at'],
    insert_cols: ['sheet', 'at'], delete_cols: ['sheet', 'at'],
    set_format: ['sheet', 'range'],
    add_sheet: ['name'], rename_sheet: ['from', 'to'], delete_sheet: ['name'],
    set_col_width: ['sheet', 'col', 'width'], set_row_height: ['sheet', 'row', 'height'],
    merge: ['sheet', 'range'], unmerge: ['sheet', 'range'], freeze: ['sheet', 'cell'],
  },
};

export function validateOps(ops, kind) {
  if (!Array.isArray(ops)) return 'ops must be an array';
  const known = REQUIRED[kind];
  const errs = [];
  ops.forEach((op, i) => {
    const label = `op[${i}]`;
    if (!op || typeof op !== 'object') return errs.push(`${label}: not an object`);
    if (!op.op) return errs.push(`${label}: missing "op"`);
    if (!known[op.op]) return errs.push(`${label}: unknown op "${op.op}" for ${kind} files`);
    for (const f of known[op.op]) {
      if (op[f] === undefined) errs.push(`${label} (${op.op}): missing "${f}"`);
    }
    if (op.op === 'delete_paragraph' && op.index === undefined && op.match === undefined)
      errs.push(`${label} (delete_paragraph): needs "index" or "match"`);
    if (op.op === 'set_paragraph_style' && op.index === undefined && op.match === undefined)
      errs.push(`${label} (set_paragraph_style): needs "index" or "match"`);
    if (op.op === 'format_paragraph' && op.index === undefined && op.match === undefined)
      errs.push(`${label} (format_paragraph): needs "index" or "match"`);
    if (op.op === 'set_cell' && op.value === undefined && op.formula === undefined)
      errs.push(`${label} (set_cell): needs "value" or "formula"`);
  });
  return errs.length ? errs.join('; ') : null;
}

export function backupFile(file) {
  const dir = path.join(path.dirname(path.resolve(file)), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(dir, `${base}.${stamp}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

/** Apply ops to a docx or xlsx file. Returns {applied, errors, backup}. */
export async function applyOps(file, ops, { makeBackup = true } = {}) {
  const kind = path.extname(file).toLowerCase() === '.docx' ? 'docx' : 'xlsx';
  const backup = makeBackup ? backupFile(file) : null;
  const applied = [];
  const errors = [];
  let doc;
  if (kind === 'docx') {
    const { DocxDoc } = await import('./docx_doc.js');
    doc = await DocxDoc.load(file);
  } else {
    const { XlsxDoc } = await import('./xlsx_doc.js');
    doc = await XlsxDoc.load(file);
  }
  if (!ops.length) { return { applied, errors, backup, doc }; }
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      const fn = doc['op_' + op.op];
      if (typeof fn !== 'function') throw new Error(`unsupported op ${op.op}`);
      const msg = await fn.call(doc, op);
      applied.push(`op[${i}] ${op.op}: ${msg}`);
    } catch (e) {
      errors.push(`op[${i}] ${op.op}: ${e.message}`);
    }
  }
  if (applied.length) await doc.save(file);
  return { applied, errors, backup, doc };
}
