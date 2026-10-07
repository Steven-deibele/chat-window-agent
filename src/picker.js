// Interactive file picker. Prefers the native OS dialog (PowerShell on Windows,
// osascript on macOS, zenity on Linux); falls back to a numbered terminal list.
// Force the fallback with WH_PICKER=list.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const EXT_LABELS = {
  docx: 'Word documents', xlsx: 'Excel workbooks', xlsm: 'Excel workbooks',
  pdf: 'PDF documents', csv: 'CSV', txt: 'Text', md: 'Markdown',
};

function run(cmd, argv, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out }); } };
    const t = setTimeout(() => { try { child.kill(); } catch {} finish('timeout'); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => finish('error'));
    child.on('close', (code) => finish(code == null ? 'error' : code));
  });
}

/** Pick one file. Returns absolute path or null if cancelled. */
export async function pickFile(exts, { title = 'Select a file' } = {}) {
  const files = await pickFiles(exts, { title, multi: false });
  return files ? files[0] || null : null;
}

/** Pick one or many files. Returns string[] or null if cancelled. */
export async function pickFiles(exts, { title = 'Select file(s)', multi = false } = {}) {
  exts = [...new Set(exts)];
  if (process.env.WH_PICKER !== 'list') {
    try {
      const viaDialog = await dialogPick(exts, { title, multi });
      if (viaDialog !== undefined) return viaDialog; // null = user cancelled
    } catch { /* fall through to list */ }
  }
  return listPick(exts, { multi });
}

async function dialogPick(exts, { title, multi }) {
  if (process.platform === 'win32') {
    const psFilter = exts.map((e) => `${EXT_LABELS[e] || e} (*.${e})|*.${e}`).join('|') + '|All files (*.*)|*.*';
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "Add-Type -AssemblyName System.Drawing | Out-Null",
      // invisible topmost owner form: keeps the dialog in the foreground even
      // when the caller is a hidden/background process (GUI launcher, VBS)
      "$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.FormBorderStyle = 'None'; $f.Opacity = 0; $f.StartPosition = 'CenterScreen'",
      "$f.Show(); $f.Activate()",
      "$d = New-Object System.Windows.Forms.OpenFileDialog",
      `$d.Title = ${psStr(title)}`,
      `$d.Filter = ${psStr(psFilter)}`,
      `$d.Multiselect = ${multi ? '$true' : '$false'}`,
      "$r = $d.ShowDialog($f)",
      "$f.Close()",
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames -join \"`n\" } else { '' }",
    ].join('; ');
    const { code, out } = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', ps]);
    if (code !== 0) return undefined; // dialog unavailable -> list fallback
    const paths = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return paths.length ? paths : null;
  }
  if (process.platform === 'darwin') {
    const types = `{${exts.map((e) => `"${e}"`).join(',')}}`;
    const script = multi
      ? `choose file of type ${types} with multiple selections allowed with prompt ${asStr(title)}`
      : `choose file of type ${types} with prompt ${asStr(title)}`;
    const { code, out } = await run('osascript', ['-e', script]);
    if (code !== 0) return undefined;
    const paths = out.split(', ').map((s) => s.trim().replace(/^"|"$|'/g, '')).filter(Boolean);
    return paths.length ? paths : null;
  }
  // linux/BSD: zenity
  const zen = await run('which', ['zenity'], 5000);
  if (zen.code !== 0 || !zen.out.trim()) return undefined;
  const argv = ['--file-selection', '--title', title, `--file-filter=${EXT_LABELS[exts[0]] || 'Files'} | ${exts.map((e) => '*.' + e).join(' ')}`];
  if (multi) argv.push('--multiple', '--separator=\n');
  const { code, out } = await run('zenity', argv);
  if (code !== 0) return null; // zenity ran and was cancelled
  const paths = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return paths.length ? paths : null;
}

/** Expand --against entries: files pass through, directories contribute every
 *  supported document inside (recursive, capped). The file being edited is
 *  excluded. Returns absolute paths. */
export function expandEvidence(entries, excludeFile) {
  const EXTS = ['docx', 'xlsx', 'xlsm', 'pdf', 'csv', 'txt', 'md'];
  const out = new Set();
  const excl = excludeFile && path.resolve(excludeFile).toLowerCase();
  for (const entry of entries) {
    const p = path.resolve(entry);
    let st; try { st = fs.statSync(p); } catch { throw new Error(`--against path not found: ${p}`); }
    if (st.isFile()) { if (path.resolve(p).toLowerCase() !== excl) out.add(p); }
    else {
      for (const f of scanFiles(EXTS, p)) {
        if (path.resolve(f).toLowerCase() !== excl) out.add(path.resolve(f));
      }
    }
  }
  return [...out];
}

function psStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function asStr(s) { return JSON.stringify(String(s)); }

// --- terminal fallback: numbered list of supported files under cwd -----------
const SKIP_DIRS = new Set(['node_modules', '.git', '.chrome-profile', 'backups']);

function scanFiles(exts, dir = '.', out = [], depth = 0) {
  if (depth > 6 || out.length > 400) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) scanFiles(exts, full, out, depth + 1); }
    else if (exts.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(full);
  }
  return out;
}

async function listPick(exts, { multi }) {
  let files = scanFiles(exts);
  files = files
    .map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return { f, m: 0 }; } })
    .sort((a, b) => b.m - a.m)
    .slice(0, 50)
    .map((x) => x.f);
  if (!files.length) {
    console.log(`No ${exts.map((e) => '.' + e).join(' / ')} files found under ${path.resolve('.')}.`);
    return null;
  }
  console.log(`\nSelect ${multi ? 'one or more files' : 'a file'} (most recent first):`);
  files.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
  const answer = await ask(multi ? 'numbers, "all", or empty to cancel> ' : 'number> ');
  if (multi && /^\s*(all|a)\s*$/i.test(answer)) return files.map((f) => path.resolve(f));
  const idx = answer.split(/[,\s]+/).map((s) => +s - 1).filter((n) => Number.isInteger(n) && n >= 0 && n < files.length);
  const picked = [...new Set(idx)].map((i) => path.resolve(files[i]));
  if (!picked.length) { console.log('nothing selected'); return null; }
  return picked;
}

// One readline interface shared by all prompts, with a line queue: piped
// stdin can deliver several lines in one chunk and drop them otherwise.
let rlSingleton = null;
const lineQueue = [];
let lineWaiter = null;

function ensureRl() {
  if (rlSingleton) return;
  rlSingleton = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rlSingleton.on('line', (l) => {
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); } else lineQueue.push(l);
  });
}

function ask(prompt) {
  ensureRl();
  if (lineQueue.length) {
    const a = lineQueue.shift();
    process.stdout.write(`${prompt}${a}\n`);
    return Promise.resolve(a);
  }
  return new Promise((res) => {
    lineWaiter = res;
    rlSingleton.setPrompt(prompt);
    rlSingleton.prompt();
  });
}

/** Close the shared prompt interface (call before other stdin readers). */
export function closePrompt() {
  try { rlSingleton?.close(); } catch {}
  rlSingleton = null;
  lineQueue.length = 0;
}

/** Prompt on the shared stdin interface (used by the app REPL too). */
export function promptLine(prompt) { return ask(prompt); }
