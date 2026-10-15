// Word (.docx) reading + editing via direct OOXML manipulation.
// Preserves formatting: we only touch w:t text nodes and insert new simple
// paragraphs/rows; everything else in the package round-trips untouched.
import fs from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { atomicWriteFile, runRegexWorker } from './util.js';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W = (name) => `{${NS_W}}${name}`;
const REGEX_TIMEOUT_MS = 5000;

/** Run user-supplied regexes in a worker: RegExp is synchronous, so an
 *  in-process timer cannot stop catastrophic backtracking. */
async function regexMatchSpans(texts, pattern, count) {
  const m = await runRegexWorker({ texts, pattern, count }, REGEX_TIMEOUT_MS);
  return m.matches;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function colName(n) { // 1 -> A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export class DocxDoc {
  static async load(path) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path));
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error(`${path}: not a valid .docx (missing word/document.xml)`);
    const xml = await entry.async('string');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error(`${path}: document.xml parse error`);
    return new DocxDoc(path, zip, doc);
  }

  constructor(path, zip, doc) {
    this.path = path;
    this.zip = zip;
    this.doc = doc;
  }

  get body() { return this.doc.documentElement.getElementsByTagNameNS(NS_W, 'body')[0]; }

  /** body-level blocks (w:p paragraphs and w:tbl tables) in document order */
  blocks() {
    return [...this.body.childNodes].filter(
      (n) => n.nodeType === 1 && (n.localName === 'p' || n.localName === 'tbl'),
    );
  }

  paragraphs() { // all paragraphs incl. those inside tables, in document order
    return [...this.doc.getElementsByTagNameNS(NS_W, 'p')];
  }

  topParagraphs() { // body-level only; these carry the P-index used in ops
    return this.blocks().filter((b) => b.localName === 'p');
  }

  tables() { return [...this.doc.getElementsByTagNameNS(NS_W, 'tbl')]; }

  static pText(p) {
    let s = '';
    for (const t of p.getElementsByTagNameNS(NS_W, 't')) s += t.textContent;
    return s;
  }

  pStyle(p) {
    const ps = p.getElementsByTagNameNS(NS_W, 'pStyle')[0];
    return ps ? ps.getAttributeNS(NS_W, 'val') || ps.getAttribute('w:val') || 'Normal' : 'Normal';
  }

  // ---- snapshot -------------------------------------------------------------
  snapshot(maxChars = 20000) {
    const lines = [];
    let pi = 0, ti = 0;
    for (const b of this.blocks()) {
      if (b.localName === 'p') {
        const text = DocxDoc.pText(b);
        if (text.trim()) lines.push(`P${pi} | ${this.pStyle(b)} | ${text}`);
        else lines.push(`P${pi} | ${this.pStyle(b)} | <empty>`);
        pi++;
      } else {
        const rows = b.getElementsByTagNameNS(NS_W, 'tr');
        lines.push(`[TABLE ${ti}] ${rows.length} rows`);
        for (let r = 0; r < rows.length; r++) {
          const cells = rows[r].getElementsByTagNameNS(NS_W, 'tc');
          const parts = [];
          for (let c = 0; c < cells.length; c++) {
            parts.push(`C${c}: ${DocxDoc.pText(cells[c]).slice(0, 120)}`);
          }
          lines.push(`  R${r}: ${parts.join(' | ')}`);
        }
        ti++;
      }
    }
    let out = lines.join('\n');
    if (out.length > maxChars) out = out.slice(0, maxChars) + `\n<TRUNCATED (${out.length - maxChars} more chars)>`;
    return out;
  }

  // ---- helpers --------------------------------------------------------------
  pByIndex(index) {
    const ps = this.topParagraphs();
    if (!Number.isInteger(index) || index < 0 || index >= ps.length) {
      throw new Error(`paragraph index ${index} out of range (0..${ps.length - 1})`);
    }
    return ps[index];
  }

  pByMatch(match) {
    const p = this.paragraphs().find((pp) => DocxDoc.pText(pp).trim() === match.trim());
    if (!p) throw new Error(`no paragraph with exact text "${match.slice(0, 60)}"`);
    return p;
  }

  tableByIndex(index) {
    const ts = this.tables();
    if (!Number.isInteger(index) || index < 0 || index >= ts.length) {
      throw new Error(`table index ${index} out of range (0..${ts.length - 1})`);
    }
    return ts[index];
  }

  cell(tbl, r, c) {
    const rows = tbl.getElementsByTagNameNS(NS_W, 'tr');
    if (r < 0 || r >= rows.length) throw new Error(`table row ${r} out of range (0..${rows.length - 1})`);
    const cells = rows[r].getElementsByTagNameNS(NS_W, 'tc');
    if (c < 0 || c >= cells.length) throw new Error(`table col ${c} out of range (0..${cells.length - 1}) at row ${r}`);
    return cells[c];
  }

  importXml(xmlString) {
    const frag = new DOMParser().parseFromString(xmlString, 'text/xml');
    const err = frag.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('internal: bad xml fragment');
    return this.doc.importNode(frag.documentElement, true);
  }

  // ---- ops ------------------------------------------------------------------
  replaceInParagraph(p, matcher, replacement) {
    // matcher(text) -> list of [start, end) spans
    const ts = [...p.getElementsByTagNameNS(NS_W, 't')];
    if (!ts.length) return 0;
    // char offsets per text node, kept in a local Map — annotating the live
    // DOM nodes (_base) leaks scratch state into the document tree
    const bases = new Map();
    let base = 0;
    for (const sp of ts) { bases.set(sp, base); base += sp.textContent.length; }
    const full = ts.map((t) => t.textContent).join('');
    const matches = matcher(full);
    if (!matches.length) return 0;
    // matches are sorted and non-overlapping; char positions ascend across
    // spans, so a single match pointer gives O(chars + matches)
    let mi = 0;
    for (const t of ts) {
      const s0 = bases.get(t), e0 = s0 + t.textContent.length;
      let out = '';
      for (let i = s0; i < e0; i++) {
        while (mi < matches.length && matches[mi][1] <= i) mi++;
        const m = mi < matches.length ? matches[mi] : null;
        if (m && m[0] <= i) { if (i === m[0]) out += replacement; } else out += full[i];
      }
      t.textContent = out;
      if (/^\s|\s$/.test(out)) t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'space', 'preserve');
    }
    return matches.length;
  }

  async op_replace_text(op) {
    // empty-string find would match at every position (and, with count=all,
    // hang the literal builder forever) — reject up front. Note: not !op.find —
    // find:0/false stringify to valid one-character literals.
    if (op.find == null || String(op.find) === '')
      throw new Error('replace_text needs a non-empty "find"');
    const find = String(op.find);
    const count = op.count === 'first' ? 1 : Infinity;
    const paragraphs = this.paragraphs();
    let n = 0;
    if (op.regex) {
      // Hostile-input defense in depth: cap pattern size, compile once for a
      // friendly syntax error, then execute in a terminable worker (ReDoS).
      if (find.length > 500) throw new Error('replace_text regex too long (max 500 chars)');
      try { new RegExp(find, 'g'); } catch (e) { throw new Error(`bad regex ${JSON.stringify(find.slice(0, 40))}: ${e.message}`); }
      const spans = await regexMatchSpans(paragraphs.map((p) => DocxDoc.pText(p)), find, count);
      for (let i = 0; i < paragraphs.length; i++)
        n += this.replaceInParagraph(paragraphs[i], () => spans[i], op.replace);
    } else {
      // count is global across the document (same contract as the regex worker):
      // 'first' = first occurrence overall, not first per paragraph.
      let remaining = count;
      const build = (text) => {
        const out = [];
        let i = 0;
        while (out.length < remaining) {
          const j = text.indexOf(find, i);
          if (j < 0) break;
          out.push([j, j + find.length]);
          i = j + find.length;
        }
        remaining -= out.length;
        return out;
      };
      for (const p of paragraphs) n += this.replaceInParagraph(p, build, op.replace);
    }
    if (!n) throw new Error(`no match for ${JSON.stringify(find.slice(0, 40))}`);
    return `replaced ${n} occurrence(s)`;
  }

  op_insert_paragraph(op) {
    const style = op.style ? `<w:pPr><w:pStyle w:val="${esc(op.style)}"/></w:pPr>` : '';
    const np = this.importXml(
      `<w:p xmlns:w="${NS_W}">${style}<w:r><w:t xml:space="preserve">${esc(op.text ?? '')}</w:t></w:r></w:p>`,
    );
    if (op.after === 'end' || op.after === undefined) {
      const last = this.body.lastChild;
      if (last && last.localName === 'sectPr') this.body.insertBefore(np, last);
      else this.body.appendChild(np);
      return 'inserted paragraph at end';
    }
    const anchor = this.pByIndex(op.after);
    this.body.insertBefore(np, anchor.nextSibling);
    return `inserted paragraph after P${op.after}`;
  }

  op_delete_paragraph(op) {
    const p = op.index !== undefined ? this.pByIndex(op.index) : this.pByMatch(op.match);
    p.parentNode.removeChild(p);
    return `deleted paragraph ${op.index !== undefined ? 'P' + op.index : JSON.stringify(String(op.match).slice(0, 40))}`;
  }

  op_set_paragraph_style(op) {
    const p = op.index !== undefined ? this.pByIndex(op.index) : this.pByMatch(op.match);
    let pPr = p.getElementsByTagNameNS(NS_W, 'pPr')[0];
    if (!pPr) { pPr = this.doc.createElementNS(NS_W, 'w:pPr'); p.insertBefore(pPr, p.firstChild); }
    let st = pPr.getElementsByTagNameNS(NS_W, 'pStyle')[0];
    if (!st) { st = this.doc.createElementNS(NS_W, 'w:pStyle'); pPr.insertBefore(st, pPr.firstChild); }
    st.setAttributeNS(NS_W, 'w:val', op.style);
    return `set style ${op.style}`;
  }

  op_format_paragraph(op) {
    const p = op.index !== undefined ? this.pByIndex(op.index) : this.pByMatch(op.match);
    let runs = [...p.getElementsByTagNameNS(NS_W, 'r')];
    if (!runs.length) {
      const r = this.doc.createElementNS(NS_W, 'w:r');
      const t = this.doc.createElementNS(NS_W, 'w:t');
      r.appendChild(t); p.appendChild(r); runs = [r];
    }
    for (const r of runs) {
      let rPr = r.getElementsByTagNameNS(NS_W, 'rPr')[0];
      if (!rPr) { rPr = this.doc.createElementNS(NS_W, 'w:rPr'); r.insertBefore(rPr, r.firstChild); }
      const ensure = (tag) => {
        let el = rPr.getElementsByTagNameNS(NS_W, tag)[0];
        if (!el) { el = this.doc.createElementNS(NS_W, 'w:' + tag); rPr.appendChild(el); }
        return el;
      };
      if (op.bold !== undefined) ensure('b');
      if (op.italic !== undefined) ensure('i');
      if (op.underline !== undefined) ensure('u');
      if (op.size !== undefined) { const sz = ensure('sz'); sz.setAttributeNS(NS_W, 'w:val', String(Math.round(op.size * 2))); }
    }
    return `formatted ${runs.length} run(s)`;
  }

  setCellText(tc, text) {
    let p = tc.getElementsByTagNameNS(NS_W, 'p')[0];
    if (!p) { p = this.importXml(`<w:p xmlns:w="${NS_W}"/>`); tc.appendChild(p); }
    const ts = [...p.getElementsByTagNameNS(NS_W, 't')];
    if (ts.length) {
      ts[0].textContent = String(text);
      if (/^\s|\s$/.test(String(text))) ts[0].setAttributeNS('http://www.w3.org/XML/1998/namespace', 'space', 'preserve');
      for (const t of ts.slice(1)) t.textContent = '';
    } else {
      const r = this.importXml(`<w:r xmlns:w="${NS_W}"><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`);
      p.appendChild(r);
    }
  }

  op_set_table_cell(op) {
    const tbl = this.tableByIndex(op.table);
    const tc = this.cell(tbl, op.row, op.col);
    this.setCellText(tc, op.text ?? '');
    return `set [TABLE ${op.table}] R${op.row}C${op.col}`;
  }

  op_append_table_row(op) {
    const tbl = this.tableByIndex(op.table);
    const rows = tbl.getElementsByTagNameNS(NS_W, 'tr');
    const last = rows[rows.length - 1];
    if (!last) throw new Error(`table ${op.table} has no rows to clone`);
    const nr = last.cloneNode(true);
    const cells = nr.getElementsByTagNameNS(NS_W, 'tc');
    (op.cells || []).forEach((text, i) => { if (cells[i]) this.setCellText(cells[i], String(text)); });
    last.parentNode.appendChild(nr);
    return `appended row to [TABLE ${op.table}] (${(op.cells || []).length} cells)`;
  }

  op_insert_table_row(op) {
    const tbl = this.tableByIndex(op.table);
    const rows = tbl.getElementsByTagNameNS(NS_W, 'tr');
    if (op.at < 0 || op.at > rows.length) throw new Error(`row position ${op.at} out of range (0..${rows.length})`);
    const proto = rows[Math.min(op.at, rows.length - 1)];
    const nr = proto.cloneNode(true);
    const cells = nr.getElementsByTagNameNS(NS_W, 'tc');
    (op.cells || []).forEach((text, i) => { if (cells[i]) this.setCellText(cells[i], String(text)); });
    rows[op.at].parentNode.insertBefore(nr, rows[op.at]);
    return `inserted row at [TABLE ${op.table}] R${op.at}`;
  }

  // ---- save -----------------------------------------------------------------
  async save(dest) {
    const xml = new XMLSerializer().serializeToString(this.doc);
    this.zip.file('word/document.xml', xml);
    const buf = await this.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    // atomic write: a failed save must never corrupt the user's document
    await atomicWriteFile(dest || this.path, buf);
  }
}
