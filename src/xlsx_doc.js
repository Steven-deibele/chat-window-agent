// Excel (.xlsx/.xlsm) reading + editing via exceljs.
// Note: exceljs round-trips most content but drops some exotic artifacts
// (pivot charts, some shapes). Timestamped backups are always kept.
import fs from 'node:fs';
import ExcelJS from 'exceljs';

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

  rangeCells(ws, range) {
    // "B2" or "A1:C10"
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(String(range || '').trim());
    if (!m) throw new Error(`bad range "${range}" (use "B2" or "A1:C10")`);
    const c1 = colToNum(m[1]), r1 = +m[2];
    const c2 = m[3] ? colToNum(m[3]) : c1, r2 = m[4] ? +m[4] : r1;
    const out = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) out.push(ws.getCell(r, c));
    }
    return out;
  }

  op_set_cell(op) {
    const ws = this.sheet(op.sheet);
    const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(op.cell || '').trim());
    if (!m) throw new Error(`bad cell ref "${op.cell}"`);
    const cell = ws.getCell(+m[2], colToNum(m[1]));
    if (op.formula !== undefined) cell.value = { formula: String(op.formula).replace(/^=/, '') };
    else if (op.value === undefined) throw new Error('set_cell needs "value" or "formula"');
    else cell.value = op.value;
    return `set ${ws.name}!${op.cell} = ${op.formula !== undefined ? '=' + op.formula : JSON.stringify(op.value)}`;
  }

  op_insert_rows(op) {
    const ws = this.sheet(op.sheet); const n = op.count || 1;
    ws.spliceRows(op.at, 0, ...Array.from({ length: n }, () => []));
    adjustFormulas(ws, { axis: 'row', at: op.at, count: n, insert: true });
    return `inserted ${n} row(s) at ${op.at} in ${ws.name} (formulas adjusted)`;
  }
  op_delete_rows(op) {
    const ws = this.sheet(op.sheet); const n = op.count || 1;
    ws.spliceRows(op.at, n);
    adjustFormulas(ws, { axis: 'row', at: op.at, count: n, insert: false });
    return `deleted ${n} row(s) at ${op.at} in ${ws.name} (formulas adjusted)`;
  }
  op_insert_cols(op) {
    const ws = this.sheet(op.sheet); const n = op.count || 1;
    ws.spliceColumns(op.at, 0, ...Array.from({ length: n }, () => []));
    adjustFormulas(ws, { axis: 'col', at: op.at, count: n, insert: true });
    return `inserted ${n} col(s) at ${op.at} in ${ws.name} (formulas adjusted)`;
  }
  op_delete_cols(op) {
    const ws = this.sheet(op.sheet); const n = op.count || 1;
    ws.spliceColumns(op.at, n);
    adjustFormulas(ws, { axis: 'col', at: op.at, count: n, insert: false });
    return `deleted ${n} col(s) at ${op.at} in ${ws.name} (formulas adjusted)`;
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
  op_merge(op) { const ws = this.sheet(op.sheet); ws.mergeCells(op.range); return `merged ${ws.name}!${op.range}`; }
  op_unmerge(op) { const ws = this.sheet(op.sheet); ws.unmergeCells(op.range); return `unmerged ${ws.name}!${op.range}`; }
  op_freeze(op) {
    const ws = this.sheet(op.sheet);
    const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(op.cell || '').trim());
    if (!m) throw new Error(`bad cell ref "${op.cell}"`);
    const x = colToNum(m[1]) - 1, y = +m[2] - 1;
    ws.views = [x || y ? { state: 'frozen', xSplit: x, ySplit: y, topLeftCell: op.cell.toUpperCase() } : { state: 'frozen', ySplit: 1 }];
    return `frozen panes at ${ws.name}!${op.cell}`;
  }

  async save(dest) {
    await this.wb.xlsx.writeFile(dest || this.path);
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

function colToNumS(s) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function adjustFormulas(ws, { axis, at, count, insert }) {
  const rewrite = (formula) =>
    formula.replace(REF, (m, cDollar, colL, rDollar, rowD) => {
      const val = axis === 'col' ? colToNumS(colL) : +rowD;
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
