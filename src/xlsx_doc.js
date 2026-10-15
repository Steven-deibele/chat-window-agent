// Excel (.xlsx/.xlsm) reading + editing via exceljs.
// Note: exceljs round-trips most content but drops some exotic artifacts
// (pivot charts, some shapes). Timestamped backups are always kept.
import ExcelJS from 'exceljs';
import { atomicWriteFile } from './util.js';

const EXCEL_MAX_COL = 16384; // XFD
const EXCEL_MAX_ROW = 1048576;

function checkedCell(ref, label = 'cell') {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(ref || '').trim());
  if (!m) throw new Error(`bad ${label} ref "${ref}"`);
  const col = colToNum(m[1]);
  const row = +m[2];
  if (row < 1 || row > EXCEL_MAX_ROW || col > EXCEL_MAX_COL)
    throw new Error(`${label} "${ref}" is outside the Excel grid (max XFD${EXCEL_MAX_ROW})`);
  return { row, col };
}

/** insert/delete rows/cols: exceljs is 1-based and silently misbehaves on
 *  0/negative/huge positions — validate like the cell/range refs. */
function checkedSplice(op, max) {
  const at = Number(op.at);
  if (!Number.isInteger(at) || at < 1 || at > max)
    throw new Error(`${op.op} needs an integer "at" between 1 and ${max}, got ${JSON.stringify(op.at)}`);
  const count = op.count === undefined ? 1 : Number(op.count);
  if (!Number.isInteger(count) || count < 1 || count > 10000)
    throw new Error(`${op.op} needs an integer "count" between 1 and 10000, got ${JSON.stringify(op.count)}`);
  return { at, count };
}

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.formula) return '=' + v.formula;
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.error) return '#' + v.error;
    return JSON.stringify(v);
  }
  return String(v);
}

export class XlsxDoc {
  static async load(path) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    return new XlsxDoc(path, wb);
  }

  constructor(path, wb) {
    this.path = path;
    this.wb = wb;
  }

  sheet(nameOrIndex) {
    if (typeof nameOrIndex === 'number') {
      const ws = this.wb.worksheets[nameOrIndex - 1];
      if (!ws) throw new Error(`sheet number ${nameOrIndex} out of range (1..${this.wb.worksheets.length})`);
      return ws;
    }
    const ws = this.wb.worksheets.find(
      (s) => s.name.toLowerCase() === String(nameOrIndex).toLowerCase(),
    );
    if (!ws) throw new Error(`no sheet named "${nameOrIndex}" (have: ${this.wb.worksheets.map((s) => s.name).join(', ')})`);
    return ws;
  }

  snapshot(maxRows = 80, maxCols = 30, maxChars = 20000) {
    const lines = [];
    for (const ws of this.wb.worksheets) {
      lines.push(`[SHEET ${ws.name}] ${ws.rowCount} rows x ${ws.columnCount} cols`);
      const rMax = Math.min(ws.rowCount || 0, maxRows);
      for (let r = 1; r <= rMax; r++) {
        const row = ws.getRow(r);
        const parts = [];
        let any = false;
        const cMax = Math.min(ws.columnCount || 0, maxCols);
        for (let c = 1; c <= cMax; c++) {
          const t = cellText(row.getCell(c));
          if (t) any = true;
          parts.push(t.replace(/[\t\n\r]/g, ' '));
        }
        lines.push(`R${r}: ` + (any ? parts.join('\t') : '<empty>'));
      }
      if (ws.rowCount > rMax) lines.push(`  <${ws.rowCount - rMax} more rows>`);
    }
    let out = lines.join('\n');
    if (out.length > maxChars) out = out.slice(0, maxChars) + `\n<TRUNCATED (${out.length - maxChars} more chars)>`;
    return out;
  }

  checkedRange(range) {
    // "B2" or "A1:C10" (absolute "$A$1:$B$2" forms accepted like checkedCell)
    const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(String(range || '').trim());
    if (!m) throw new Error(`bad range "${range}" (use "B2" or "A1:C10")`);
    const c1 = colToNum(m[1]), r1 = +m[2];
    const c2 = m[3] ? colToNum(m[3]) : c1, r2 = m[4] ? +m[4] : r1;
    // Excel's own grid limits — clearer error than a giant allocation or a
    // silently discarded row-zero edit downstream
    if (r1 < 1 || r2 < 1 || c1 > EXCEL_MAX_COL || c2 > EXCEL_MAX_COL || r1 > EXCEL_MAX_ROW || r2 > EXCEL_MAX_ROW)
      throw new Error(`range "${range}" is outside the Excel grid (max XFD${EXCEL_MAX_ROW})`);
    const total = (Math.abs(r2 - r1) + 1) * (Math.abs(c2 - c1) + 1);
    if (total > 10000) throw new Error(`range "${range}" covers ${total} cells — too large (max 10000); split it into smaller ranges`);
    // ref: normalized form for exceljs — uppercase (it rejects lowercase) and
    // corners sorted (it does not normalize reversed refs like "C10:A1")
    const [ra, rb] = [Math.min(r1, r2), Math.max(r1, r2)];
    const [ca, cb] = [Math.min(c1, c2), Math.max(c1, c2)];
    const ref = m[3] ? `${numToCol(ca)}${ra}:${numToCol(cb)}${rb}` : `${numToCol(ca)}${ra}`;
    return { r1, c1, r2, c2, total, ref };
  }

  rangeCells(ws, range) {
    const { r1, c1, r2, c2 } = this.checkedRange(range);
    const out = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) out.push(ws.getCell(r, c));
    }
    return out;
  }

  op_set_cell(op) {
    const ws = this.sheet(op.sheet);
    const { row, col } = checkedCell(op.cell);
    const cell = ws.getCell(row, col);
    if (op.formula !== undefined) cell.value = { formula: String(op.formula).replace(/^=/, '') };
    else if (op.value === undefined) throw new Error('set_cell needs "value" or "formula"');
    else cell.value = op.value;
    // echo the normalized ref, not the raw op.cell ($-prefixes, lowercase)
    const ref = `${numToCol(col)}${row}`;
    return `set ${ws.name}!${ref} = ${op.formula !== undefined ? '=' + op.formula : JSON.stringify(op.value)}`;
  }

  op_insert_rows(op) {
    const ws = this.sheet(op.sheet); const { at, count: n } = checkedSplice(op, EXCEL_MAX_ROW);
    ws.spliceRows(at, 0, ...Array.from({ length: n }, () => []));
    adjustFormulas(ws, { axis: 'row', at, count: n, insert: true });
    return `inserted ${n} row(s) at ${at} in ${ws.name} (formulas adjusted)`;
  }
  op_delete_rows(op) {
    const ws = this.sheet(op.sheet); const { at, count: n } = checkedSplice(op, EXCEL_MAX_ROW);
    ws.spliceRows(at, n);
    adjustFormulas(ws, { axis: 'row', at, count: n, insert: false });
    return `deleted ${n} row(s) at ${at} in ${ws.name} (formulas adjusted)`;
  }
  op_insert_cols(op) {
    const ws = this.sheet(op.sheet); const { at, count: n } = checkedSplice(op, EXCEL_MAX_COL);
    ws.spliceColumns(at, 0, ...Array.from({ length: n }, () => []));
    adjustFormulas(ws, { axis: 'col', at, count: n, insert: true });
    return `inserted ${n} col(s) at ${at} in ${ws.name} (formulas adjusted)`;
  }
  op_delete_cols(op) {
    const ws = this.sheet(op.sheet); const { at, count: n } = checkedSplice(op, EXCEL_MAX_COL);
    ws.spliceColumns(at, n);
    adjustFormulas(ws, { axis: 'col', at, count: n, insert: false });
    return `deleted ${n} col(s) at ${at} in ${ws.name} (formulas adjusted)`;
  }

  op_set_format(op) {
    const ws = this.sheet(op.sheet);
    const cells = this.rangeCells(ws, op.range);
    for (const cell of cells) {
      const f = { ...(cell.font || {}) };
      if (op.bold !== undefined) f.bold = !!op.bold;
      if (op.italic !== undefined) f.italic = !!op.italic;
      if (op.size !== undefined) f.size = op.size;
      if (op.font_color) f.color = { argb: argb(op.font_color) };
      cell.font = f;
      if (op.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(op.fill) } };
      if (op.align || op.wrap !== undefined) {
        cell.alignment = { ...(cell.alignment || {}) };
        if (op.align) cell.alignment.horizontal = op.align;
        if (op.wrap !== undefined) cell.alignment.wrapText = !!op.wrap;
      }
      if (op.number_format) cell.numFmt = op.number_format;
    }
    return `formatted ${ws.name}!${op.range} (${cells.length} cells)`;
  }

  op_add_sheet(op) { this.wb.addWorksheet(op.name); return `added sheet "${op.name}"`; }
  op_rename_sheet(op) { const ws = this.sheet(op.from); ws.name = op.to; return `renamed sheet "${op.from}" -> "${op.to}"`; }
  op_delete_sheet(op) { const ws = this.sheet(op.name); this.wb.removeWorksheet(ws.id); return `deleted sheet "${op.name}"`; }
  op_set_col_width(op) { const ws = this.sheet(op.sheet); ws.getColumn(op.col).width = op.width; return `set ${ws.name} col ${op.col} width ${op.width}`; }
  op_set_row_height(op) { const ws = this.sheet(op.sheet); ws.getRow(op.row).height = op.height; return `set ${ws.name} row ${op.row} height ${op.height}`; }
  op_merge(op) { const ws = this.sheet(op.sheet); const range = this.checkedRange(op.range).ref; ws.mergeCells(range); return `merged ${ws.name}!${range}`; }
  op_unmerge(op) { const ws = this.sheet(op.sheet); const range = this.checkedRange(op.range).ref; ws.unmergeCells(range); return `unmerged ${ws.name}!${range}`; }
  op_freeze(op) {
    const ws = this.sheet(op.sheet);
    const { row, col } = checkedCell(op.cell);
    const x = col - 1, y = row - 1;
    // rebuild the ref from validated parts: raw op.cell may be lowercase,
    // $-prefixed, or not a string at all (toUpperCase would throw)
    const ref = `${numToCol(col)}${row}`;
    ws.views = [x || y ? { state: 'frozen', xSplit: x, ySplit: y, topLeftCell: ref } : { state: 'frozen', ySplit: 1 }];
    return `frozen panes at ${ws.name}!${ref}`;
  }

  async save(dest) {
    // atomic write: a failed save must never corrupt the user's workbook.
    // writeBuffer + shared helper instead of writeFile-to-temp: one
    // implementation of the atomic-write semantics (mode preservation, fsync).
    await atomicWriteFile(dest || this.path, await this.wb.xlsx.writeBuffer());
  }
}

function colToNum(s) {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function argb(hex) {
  const h = String(hex).replace('#', '').toUpperCase();
  return h.length === 6 ? 'FF' + h : h;
}

// --- formula reference adjustment on row/col insert+delete (Excel-style) ---
const REF = /(?<![A-Za-z0-9_$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g;

function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function adjustFormulas(ws, { axis, at, count, insert }) {
  const rewrite = (formula) =>
    formula.replace(REF, (m, cDollar, colL, rDollar, rowD) => {
      const val = axis === 'col' ? colToNum(colL) : +rowD;
      let out;
      if (insert) out = val >= at ? val + count : val;
      else if (val >= at + count) out = val - count;
      else if (val >= at) out = at; // reference inside deleted span: clamp
      else out = val;
      if (out === val) return m;
      return cDollar + (axis === 'col' ? numToCol(out) : colL) + rDollar + (axis === 'row' ? out : rowD);
    });
  let touched = 0;
  for (let r = 1; r <= (ws.rowCount || 0); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= (ws.columnCount || 0); c++) {
      const cell = row.getCell(c);
      const v = cell && cell.value;
      if (v && typeof v === 'object' && typeof v.formula === 'string' && v.formula) {
        const nf = rewrite(v.formula);
        if (nf !== v.formula) { cell.value = { formula: nf, result: v.result }; touched++; }
      }
    }
  }
  return touched;
}
