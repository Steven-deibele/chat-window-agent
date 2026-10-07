// GUI launcher — a settings window for chat-window-agent, no terminal needed.
// Zero dependencies: a tiny local HTTP server serves a settings page (opened in
// a Chrome/Edge app-style window, or the default browser), builds the CLI
// command from the form, spawns src/app.js, streams its output back over SSE,
// and forwards typed input to the child's stdin (REPL and [y/N] prompts work).
//
//   node src/gui.js            (or: run.bat gui)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProviders } from './providers.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(SRC_DIR, '..');
const APP_JS = path.join(SRC_DIR, 'app.js');
const SETTINGS_FILE = path.join(APP_ROOT, 'gui-settings.json');

const MODES = ['agent', 'edit', 'fill', 'ask', 'calibrate', 'doctor', 'models'];
const DOC_EXTS = new Set(['docx', 'xlsx', 'xlsm', 'pdf', 'csv', 'txt', 'md']);
const EDIT_EXTS = ['docx', 'xlsx', 'xlsm'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.chrome-profile', 'backups', 'models', '.wh-work']);

// --- helpers ---------------------------------------------------------------
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s) => String(s).replace(ANSI, '');

function scanDocs(dir = APP_ROOT, out = [], depth = 0) {
  if (depth > 3 || out.length >= 200) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= 200) break;
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) scanDocs(p, out, depth + 1); }
    else if (DOC_EXTS.has(e.name.split('.').pop().toLowerCase())) out.push(path.relative(APP_ROOT, p));
  }
  return out;
}

function listModels() {
  const dir = path.join(APP_ROOT, 'models');
  try { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.gguf')); }
  catch { return []; }
}

function chromeCandidates() {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ].filter(Boolean);
}

function openWindow(url) {
  const exe = chromeCandidates().find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  try {
    if (exe) spawn(exe, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* user can open the printed URL manually */ }
}

// --- command building ------------------------------------------------------
/** agent-mode helper: files pass through; a directory contributes its documents
 *  (recursive, capped, skipping junk dirs). */
function expandDocs(f, out = [], depth = 0) {
  let st;
  try { st = fs.statSync(f); } catch { out.push(f); return out; } // let app.js report a bad path
  if (!st.isDirectory()) { out.push(f); return out; }
  if (depth > 3 || out.length >= 20) return out;
  let entries;
  try { entries = fs.readdirSync(f, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= 20) break;
    if (e.name.startsWith('.')) continue;
    const p = path.join(f, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) expandDocs(p, out, depth + 1); }
    else if (DOC_EXTS.has(e.name.split('.').pop().toLowerCase())) out.push(p);
  }
  return out;
}
/** Build a safe argv for src/app.js from the posted form state (whitelisted). */
export function buildArgv(s = {}) {
  const mode = MODES.includes(s.mode) ? s.mode : 'agent';
  if (mode === 'models') return ['models']; // list-only; ignores all flags
  const a = [mode];
  const against = Array.isArray(s.against) ? s.against.filter(Boolean) : [];
  if (mode === 'edit' || mode === 'fill') {
    if (s.file) a.push(String(s.file));
    for (const f of against) a.push('--against', String(f));
  } else if (mode === 'agent') {
    // agent mode attaches files positionally — expand folder entries to their documents
    for (const f of [s.file, ...against].filter(Boolean)) a.push(...expandDocs(String(f)));
  }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v) => (Number.isFinite(+v) && +v > 0 ? String(+v) : null);
  if (str(s.provider)) a.push('--provider', str(s.provider));
  if (str(s.url)) a.push('--url', str(s.url));
  if (str(s.model)) a.push('--model', str(s.model));
  if (str(s.remoteProvider)) a.push('--remote-provider', str(s.remoteProvider));
  if (['off', 'low', 'normal', 'aggressive'].includes(s.offload)) a.push('--offload', s.offload);
  if (str(s.ask) && mode !== 'calibrate' && mode !== 'doctor') a.push('--ask', str(s.ask));
  if (num(s.maxRetries)) a.push('--max-retries', num(s.maxRetries));
  if (num(s.timeout)) a.push('--timeout', num(s.timeout));
  if (num(s.maxSteps) && mode === 'agent') a.push('--max-steps', num(s.maxSteps));
  if (num(s.delay)) a.push('--delay', num(s.delay));
  if (s.watch && mode !== 'calibrate') a.push('--watch');
  if (s.noBackup && (mode === 'edit' || mode === 'fill')) a.push('--no-backup');
  if (s.yes) a.push('--yes');
  if (s.plain) a.push('--plain');
  if (s.simple) a.push('--simple');
  if (s.withLocal && mode === 'agent') a.push('--with-local');
  return a;
}

// --- child process + output buffer ------------------------------------------
let child = null;
let logBuf = [];           // replayed to every new SSE client
let logBytes = 0;
const sseClients = new Set();

function pushLog(type, text) {
  text = stripAnsi(text);
  logBuf.push({ type, text });
  logBytes += text.length;
  while (logBytes > 300_000 && logBuf.length > 1) logBytes -= logBuf.shift().text.length;
  const line = `data: ${JSON.stringify({ type, text })}\n\n`;
  for (const res of sseClients) res.write(line);
}

function stopChild() {
  if (!child) return;
  try { child.kill(); } catch { /* already gone */ }
}

function runChild(argv) {
  if (child) throw new Error('a session is already running — stop it first');
  logBuf = []; logBytes = 0;
  const printable = ['node src/app.js', ...argv.map((x) => (/\s/.test(x) ? `"${x}"` : x))].join(' ');
  pushLog('sys', `$ ${printable}\n`);
  child = spawn(process.execPath, [APP_JS, ...argv], {
    cwd: APP_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => pushLog('out', d.toString('utf8')));
  child.stderr.on('data', (d) => pushLog('err', d.toString('utf8')));
  child.on('error', (e) => pushLog('err', `failed to start: ${e.message}\n`));
  child.on('close', (code) => {
    pushLog('exit', `\n— process exited (code ${code}) —\n`);
    child = null;
    scheduleShutdown();
  });
}

// --- auto-shutdown when the window is closed --------------------------------
let shutdownTimer = null;
function scheduleShutdown() {
  if (child || sseClients.size > 0 || shutdownTimer) return;
  shutdownTimer = setTimeout(() => { console.log('[gui] window closed — shutting down'); process.exit(0); }, 5000);
}
function cancelShutdown() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
}

// --- HTTP --------------------------------------------------------------------
async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  cancelShutdown();
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (u.pathname === '/api/options') {
    const providers = Object.entries(loadProviders()).map(([name, p]) => ({
      name, label: p.label || name, local: !!p.local, plain: !!p.plain, simple: !!p.simple,
    }));
    return json(res, { providers, models: listModels(), docs: scanDocs() });
  }
  if (u.pathname === '/api/provider/custom' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const { saveCustomProvider } = await import('./providers.js');
      const r = saveCustomProvider({ url: String(body.url || '').trim(), name: String(body.name || '').trim(), plain: !!body.plain, simple: !!body.simple, delay: +body.delay || 0 });
      return json(res, { ok: true, name: r.name });
    } catch (e) { return json(res, { ok: false, error: e.message }, 400); }
  }
  if (u.pathname === '/api/settings' && req.method === 'GET') {
    try { return json(res, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
    catch { return json(res, {}); }
  }
  if (u.pathname === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(body, null, 2)); } catch { /* best effort */ }
    return json(res, { ok: true });
  }
  if (u.pathname === '/api/pick' && req.method === 'POST') {
    const body = await readBody(req);
    const exts = (Array.isArray(body.exts) ? body.exts : EDIT_EXTS).filter((e) => DOC_EXTS.has(String(e)));
    const { pickFiles } = await import('./picker.js');
    const picked = await pickFiles(exts.length ? exts : EDIT_EXTS, { title: 'Select file(s)', multi: !!body.multi }).catch(() => null);
    return json(res, { files: picked || [] });
  }
  if (u.pathname === '/api/browse') {
    // In-page folder browser: lists subdirectories (+ document count) of a path.
    // No path = list drive roots (Windows) or / (unix).
    let p = u.searchParams.get('path');
    if (!p) {
      const roots = [];
      if (process.platform === 'win32') {
        for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { fs.accessSync(L + ':\\'); roots.push(L + ':'); } catch { /* drive absent */ } }
      } else roots.push('/');
      return json(res, { path: '', parent: '', dirs: roots, docs: 0 });
    }
    p = path.resolve(p);
    const dirs = [];
    let docs = 0;
    try {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) dirs.push(e.name);
        else if (DOC_EXTS.has(e.name.split('.').pop().toLowerCase())) docs++;
      }
    } catch (e) { return json(res, { error: `cannot open ${p}: ${e.message}` }, 400); }
    dirs.sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(p);
    return json(res, { path: p, parent: parent !== p ? parent : '', dirs, docs });
  }
  if (u.pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      runChild(buildArgv(body));
      return json(res, { ok: true, argv: buildArgv(body) });
    } catch (e) { return json(res, { ok: false, error: e.message }, 409); }
  }
  if (u.pathname === '/api/input' && req.method === 'POST') {
    const body = await readBody(req);
    if (child && typeof body.line === 'string') {
      pushLog('in', `> ${body.line}\n`);
      child.stdin.write(body.line + '\n');
    }
    return json(res, { ok: !!child });
  }
  if (u.pathname === '/api/stop' && req.method === 'POST') {
    stopChild();
    return json(res, { ok: true });
  }
  if (u.pathname === '/api/quit' && req.method === 'POST') {
    json(res, { ok: true });
    stopChild();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'sys', text: child ? '' : '(no session running yet)\n' })}\n\n`);
    for (const item of logBuf) res.write(`data: ${JSON.stringify(item)}\n\n`);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); scheduleShutdown(); });
    return;
  }
  json(res, { error: 'not found' }, 404);
}

export function createGuiServer() {
  return http.createServer((req, res) => handle(req, res).catch((e) => json(res, { error: e.message }, 500)));
}

export async function startGui() {
  const server = createGuiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`[gui] settings window: ${url}`);
  openWindow(url);
  return server;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>chat-window-agent</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#14161a;--panel:#1d2026;--border:#30343c;--fg:#e6e8eb;--muted:#9aa0a8;--accent:#4f8cff;--ok:#3fb96b;--err:#e05c5c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,sans-serif}
header{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
header b{font-size:15px}
header .sp{flex:1}
main{display:grid;grid-template-columns:360px 1fr;gap:0;height:calc(100vh - 49px)}
form{padding:14px 16px;overflow:auto;border-right:1px solid var(--border)}
label{display:block;margin:10px 0 3px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
select,input[type=text],input[type=number],textarea{width:100%;background:#0f1114;border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:7px 9px;font:inherit}
textarea{min-height:64px;resize:vertical}
.row{display:flex;gap:8px;align-items:center}
.checks{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:8px}
.checks label{display:flex;gap:6px;align-items:center;margin:0;text-transform:none;letter-spacing:0;color:var(--fg);font-size:13px}
.checks input{width:auto}
button{background:var(--accent);border:0;color:#fff;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--border);color:var(--fg)}
button:disabled{opacity:.45;cursor:default}
#preview{margin-top:12px;background:#0f1114;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font:12px ui-monospace,Consolas,monospace;color:var(--muted);word-break:break-all;white-space:pre-wrap}
#evlist div{display:flex;justify-content:space-between;gap:8px;background:#0f1114;border:1px solid var(--border);border-radius:6px;padding:4px 8px;margin-top:4px;font-size:12px}
#evlist a{color:var(--err);cursor:pointer;text-decoration:none}
.right{display:flex;flex-direction:column;min-width:0}
#out{flex:1;overflow:auto;margin:0;padding:12px 16px;font:12.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
#out .err{color:var(--err)} #out .sys{color:var(--muted)} #out .in{color:var(--accent)} #out .exit{color:var(--ok)}
#inputrow{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border)}
#stdin{flex:1}
.hidden{display:none!important}
.status{font-size:12px;color:var(--muted)}
.help{font-size:11px;color:var(--muted);margin:2px 0 6px;line-height:1.35}
.fmdir{padding:6px 10px;border-radius:5px;cursor:pointer;font-size:13px}
.fmdir:hover{background:var(--border)}
#foldermodal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10}
#foldermodal.hidden{display:none}
#foldermodal .box{background:var(--panel);border:1px solid var(--border);border-radius:8px;width:440px;max-height:70vh;display:flex;flex-direction:column}
#fmlist{flex:1;overflow:auto;padding:6px}
</style></head>
<body>
<header><b>chat-window-agent</b><span class="status" id="status">idle</span><span class="sp"></span>
<button class="ghost" id="quitbtn" type="button">Quit</button></header>
<main>
<form id="f" onsubmit="return false">
  <label>Mode</label>
  <select name="mode">
    <option value="agent">agent — conversational AI with tools (default)</option>
    <option value="edit">edit — edit one Word/Excel file</option>
    <option value="fill">fill — compliance checklist vs evidence docs</option>
    <option value="ask">ask — one question to a cloud chat, no tools</option>
    <option value="calibrate">calibrate — teach a custom chat UI</option>
    <option value="doctor">doctor — diagnose browser selectors</option>
    <option value="models">models — list downloaded local models</option>
  </select>
  <div class="help" id="modehelp"></div>
  <label>AI chat (provider)</label>
  <div class="row"><select name="provider" id="provider" style="flex:1"></select>
  <button class="ghost" type="button" id="addprov" title="Add a company/custom chat window">＋ Custom…</button></div>
  <div class="help">which AI chat window to drive — log in once in its Chrome window; ＋ Custom… adds your company chat</div>
  <div id="provform" class="hidden" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:6px">
    <label>Work chat URL</label>
    <input type="text" id="purl" placeholder="https://chat.mycompany.com">
    <label>Short name (optional)</label>
    <input type="text" id="pname" placeholder="derived from URL if empty">
    <div class="checks">
      <label><input type="checkbox" id="pplain"> neutral framing (preset AI)</label>
      <label><input type="checkbox" id="psimple"> simple protocol (weak model)</label>
    </div>
    <label>Startup delay (s)</label>
    <input type="number" id="pdelay" min="0" value="0">
    <div class="row" style="margin-top:8px"><button type="button" id="psave">Save provider</button></div>
  </div>
  <div id="sidecar" class="hidden">
    <div class="checks" style="margin-top:6px">
      <label style="grid-column:1/-1" title="Loads a downloaded GGUF model on this machine next to the browser session. The chat-window AI gets a local.ask tool to hand it on-machine work (summaries, extraction, drafting) — nothing leaves the computer."><input type="checkbox" name="withLocal"> local AI runs alongside (local.ask)</label>
    </div>
    <div class="help">your local model works next to the big chat-window AI — it can hand the local model on-machine work, nothing leaves the computer</div>
  </div>
  <div id="filewrap">
    <label>File to edit / attach</label>
    <div class="row"><input type="text" name="file" list="docs" placeholder="(optional — picker opens if empty)">
    <button class="ghost" type="button" id="browse">Browse…</button></div>
    <datalist id="docs"></datalist>
    <div class="help">the document to work on — Word/Excel for edit/fill, any document for agent; a picker opens if left empty</div>
    <label>Evidence documents / folder (--against)</label>
    <div id="evlist"></div>
    <div class="row"><button class="ghost" type="button" id="addev">Add files…</button>
    <button class="ghost" type="button" id="addevfolder">Add folder…</button></div>
    <div class="help">read-only reference material the AI reviews — a folder means every document inside it</div>
  </div>
  <label>Instruction (optional — empty = interactive session)</label>
  <textarea name="ask" placeholder="e.g. fix the totals and flag anomalies" title="What the AI should do. Leave empty for an interactive session you steer from the input box on the right."></textarea>
  <div class="help">leave empty for an interactive session you steer from the input box on the right</div>
  <label>Options</label>
  <div class="checks">
    <label title="You type requests directly in the browser chat window; the tool watches and applies every AI reply. The input box here is unused."><input type="checkbox" name="watch"> --watch (chat in browser)</label>
    <label title="Run shell commands and file writes WITHOUT asking you yes/no first. Convenient but riskier."><input type="checkbox" name="yes"> --yes (skip approvals)</label>
    <label title="Don't save a timestamped backup before editing a document (backups/ folder)."><input type="checkbox" name="noBackup"> --no-backup</label>
    <label title="Neutral 'planning component' framing for company/preset AIs that refuse the agent role."><input type="checkbox" name="plain"> --plain (neutral framing)</label>
    <label title="Simplified protocol: one tool per reply, short rules. Helps weaker models follow instructions."><input type="checkbox" name="simple"> --simple (weak models)</label>
  </div>
  <div class="row">
    <div style="flex:1"><label title="Self-correction rounds when the AI's reply is broken or fails to apply (default 3).">--max-retries</label><input type="number" name="maxRetries" min="0" placeholder="3"></div>
    <div style="flex:1"><label title="Maximum tool steps per request in agent mode (default 40).">--max-steps</label><input type="number" name="maxSteps" min="0" placeholder="(default)"></div>
  </div>
  <div class="row">
    <div style="flex:1"><label title="How long to wait for an AI reply before failing, in milliseconds (default from the provider).">--timeout (ms)</label><input type="number" name="timeout" min="0" placeholder="(provider)"></div>
    <div style="flex:1"><label title="Wait this many seconds after the chat opens before the first message — time to pick a model or adjust chat settings.">--delay (s)</label><input type="number" name="delay" min="0" placeholder="0"></div>
  </div>
  <div id="modelwrap" class="hidden">
    <label>Local model (--model)</label>
    <select name="model" id="modelsel"></select>
    <div class="help">which downloaded GGUF model runs on this machine (download more with: run.bat models pull …)</div>
  </div>
  <div id="localopts" class="hidden">
    <div class="row">
      <div style="flex:1"><label title="How eagerly the local model asks the big cloud AI for help: off = never, low = only when stuck, normal = hard thinking goes to the big AI, aggressive = the local model is only the hands.">Offload</label><select name="offload">
        <option value="">(default)</option><option>off</option><option>low</option><option>normal</option><option>aggressive</option>
      </select></div>
      <div style="flex:1"><label title="Which cloud chat window the local model consults via the remote.ask tool.">Remote provider</label><select name="remoteProvider" id="remotesel"></select></div>
    </div>
  </div>
  <label>Chat URL override (optional)</label>
  <input type="text" name="url" placeholder="https://…">
  <div class="help">override the chat URL — also selects which already-open tab to drive</div>
  <div id="preview"></div>
  <div class="row" style="margin-top:12px">
    <button id="run" type="button">▶ Run</button>
    <button class="ghost" id="stop" type="button" disabled>■ Stop</button>
  </div>
</form>
<div class="right">
  <pre id="out"></pre>
  <div id="inputrow"><input id="stdin" type="text" placeholder="type a reply / instruction and press Enter (goes to the session)"><button type="button" id="send">Send</button></div>
</div>
</main>
<div id="foldermodal" class="hidden">
  <div class="box">
    <div style="padding:10px 12px;border-bottom:1px solid var(--border)"><b>Select evidence folder</b><div class="help" id="fmpath" style="word-break:break-all"></div></div>
    <div id="fmlist"></div>
    <div class="row" style="padding:10px 12px;border-top:1px solid var(--border)">
      <button type="button" id="fmselect">Select this folder</button>
      <button class="ghost" type="button" id="fmup">⬅ Up</button>
      <button class="ghost" type="button" id="fmcancel">Cancel</button>
    </div>
  </div>
</div>
<script>
const $ = (s) => document.querySelector(s);
const f = $('#f');
let providers = [], running = false;

async function api(p, body) {
  const r = await fetch(p, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

function state() {
  const d = new FormData(f), s = {};
  for (const [k, v] of d) s[k] = v;
  for (const c of f.querySelectorAll('input[type=checkbox]')) s[c.name] = c.checked;
  s.against = [...document.querySelectorAll('#evlist span')].map((e) => e.dataset.p);
  return s;
}

function preview() {
  const s = state();
  if (s.mode === 'models') { $('#preview').textContent = 'run.bat models'; return; }
  const parts = ['run.bat', s.mode];
  if ((s.mode === 'edit' || s.mode === 'fill') && s.file) parts.push(s.file);
  if (s.mode === 'agent') for (const x of [s.file, ...s.against].filter(Boolean)) parts.push(x);
  if ((s.mode === 'edit' || s.mode === 'fill')) for (const x of s.against) parts.push('--against', x);
  for (const [k, flag] of [['provider','--provider'],['url','--url'],['model','--model'],['remoteProvider','--remote-provider'],['offload','--offload'],['ask','--ask'],['maxRetries','--max-retries'],['timeout','--timeout'],['maxSteps','--max-steps'],['delay','--delay']])
    if (s[k]) parts.push(flag, s[k]);
  for (const [k, flag] of [['watch','--watch'],['yes','--yes'],['noBackup','--no-backup'],['plain','--plain'],['simple','--simple'],['withLocal','--with-local']])
    if (s[k] && (k !== 'withLocal' || s.mode === 'agent')) parts.push(flag);
  $('#preview').textContent = parts.map((p) => (/\\s/.test(p) ? '"' + p + '"' : p)).join(' ');
}

let saveT;
const MODE_HELP = {
  agent: 'general assistant with tools: reads/edits files, runs commands, browses the web — chat with it in the input box on the right',
  edit: 'focused editing of one Word/Excel document, one instruction at a time',
  fill: 'reviews a Word checklist against the evidence documents and marks/fills it in',
  ask: 'sends one question to a cloud chat window and prints the answer — no tools, no files',
  calibrate: 'teaches the tool a company chat UI by watching one exchange, then saves it as a provider',
  doctor: 'checks that the saved selectors still match the chat page (run after a site redesign)',
  models: 'lists the local GGUF models downloaded in models/',
};
function changed() {
  const p = providers.find((x) => x.name === f.provider.value);
  $('#modehelp').textContent = MODE_HELP[f.mode.value] || '';
  const isLocal = !!(p && p.local);
  $('#localopts').classList.toggle('hidden', !isLocal);
  $('#sidecar').classList.toggle('hidden', isLocal || f.mode.value !== 'agent');
  $('#modelwrap').classList.toggle('hidden', !(isLocal || (f.withLocal.checked && !isLocal)));
  const fileModes = ['agent', 'edit', 'fill'];
  $('#filewrap').classList.toggle('hidden', !fileModes.includes(f.mode.value));
  f.noBackup.closest('label').classList.toggle('hidden', !['edit', 'fill'].includes(f.mode.value));
  preview();
  clearTimeout(saveT);
  saveT = setTimeout(() => api('/api/settings', state()), 400);
}

function setRunning(on) {
  running = on;
  $('#run').disabled = on; $('#stop').disabled = !on;
  $('#status').textContent = on ? 'running…' : 'idle';
}

const out = $('#out');
function append(type, text) {
  if (!text) return;
  const span = document.createElement('span');
  span.className = type; span.textContent = text;
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

const es = new EventSource('/api/stream');
es.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  append(m.type, m.text);
  if (m.type === 'exit') setRunning(false);
};

$('#run').onclick = async () => {
  out.textContent = ''; // clear before starting so the echoed command isn't wiped
  const r = await api('/api/run', state());
  if (!r.ok) return append('err', r.error + '\\n');
  setRunning(true);
};
$('#stop').onclick = () => api('/api/stop');
$('#quitbtn').onclick = async () => { await api('/api/quit'); document.body.innerHTML = '<p style="padding:2em">chat-window-agent has shut down — you can close this window.</p>'; };
function sendInput() {
  const el = $('#stdin');
  if (!el.value) return;
  api('/api/input', { line: el.value });
  el.value = '';
}
$('#send').onclick = sendInput;
$('#stdin').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendInput(); });
function addEv(p) {
  const div = document.createElement('div');
  div.innerHTML = '<span></span><a>✕</a>';
  div.querySelector('span').textContent = p; div.querySelector('span').dataset.p = p;
  div.querySelector('a').onclick = () => { div.remove(); changed(); };
  $('#evlist').appendChild(div);
}
const DOC_EXTS_ALL = ['docx', 'xlsx', 'xlsm', 'pdf', 'csv', 'txt', 'md'];
$('#browse').onclick = async () => {
  const mode = f.mode.value;
  const exts = mode === 'fill' ? ['docx'] : mode === 'edit' ? ['docx', 'xlsx', 'xlsm'] : DOC_EXTS_ALL;
  const r = await api('/api/pick', { multi: false, exts });
  if (r.files && r.files[0]) { f.file.value = r.files[0]; changed(); }
};
$('#addev').onclick = async () => {
  const r = await api('/api/pick', { multi: true, exts: DOC_EXTS_ALL });
  for (const p of r.files || []) addEv(p);
  changed();
};
// in-page folder browser (no native dialog — works however the GUI was launched)
let fmPath = '';
async function fmShow(p) {
  const r = await api('/api/browse' + (p ? '?path=' + encodeURIComponent(p) : ''));
  if (r.error) { append('err', r.error + String.fromCharCode(10)); return; }
  fmPath = r.path;
  $('#fmpath').textContent = r.path ? r.path + (r.docs ? ' — ' + r.docs + ' document(s) directly inside' : ' — no documents directly inside') : 'This computer — pick a drive';
  const list = $('#fmlist');
  list.innerHTML = '';
  if (!r.dirs.length) list.innerHTML = '<div class="help" style="padding:6px">(no subfolders)</div>';
  for (const d of r.dirs) {
    const div = document.createElement('div');
    div.className = 'fmdir';
    div.textContent = '📁 ' + d;
    div.onclick = () => fmShow(r.path ? r.path + '/' + d : d);
    list.appendChild(div);
  }
  $('#fmup').disabled = !r.parent;
  $('#fmup').onclick = () => fmShow(r.parent || '');
  $('#fmselect').disabled = !r.path;
}
$('#addevfolder').onclick = () => { $('#foldermodal').classList.remove('hidden'); fmShow(''); };
$('#fmcancel').onclick = () => $('#foldermodal').classList.add('hidden');
$('#fmselect').onclick = () => {
  if (fmPath) { addEv(fmPath); changed(); }
  $('#foldermodal').classList.add('hidden');
};

function renderProviders(list) {
  $('#provider').innerHTML = list.map((p) => '<option value="' + p.name + '">' + p.label + (p.local ? ' (offline)' : '') + '</option>').join('');
}
$('#addprov').onclick = () => $('#provform').classList.toggle('hidden');
$('#psave').onclick = async () => {
  const r = await api('/api/provider/custom', { url: $('#purl').value.trim(), name: $('#pname').value.trim(), plain: $('#pplain').checked, simple: $('#psimple').checked, delay: +$('#pdelay').value || 0 });
  if (!r.ok) return append('err', 'custom provider: ' + r.error + String.fromCharCode(10));
  const opts = await api('/api/options');
  providers = opts.providers;
  renderProviders(providers);
  f.provider.value = r.name;
  $('#provform').classList.add('hidden');
  append('sys', 'saved provider "' + r.name + '" — select it above; run mode "doctor" on it if the chat UI is unusual\\n');
  changed();
};

(async function init() {
  const [opts, saved] = await Promise.all([api('/api/options'), api('/api/settings')]);
  providers = opts.providers;
  renderProviders(providers);
  $('#remotesel').innerHTML = '<option value="">(default)</option>' + opts.providers.filter((p) => !p.local).map((p) => '<option value="' + p.name + '">' + p.label + '</option>').join('');
  $('#modelsel').innerHTML = '<option value="">(default)</option>' + opts.models.map((m) => '<option value="models/' + m + '">' + m + '</option>').join('');
  $('#docs').innerHTML = opts.docs.map((d) => '<option value="' + d.replace(/"/g, '&quot;') + '">').join('');
  for (const [k, v] of Object.entries(saved)) {
    const el = f.elements[k];
    if (!el || k === 'against') continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  // default: local AI runs alongside whenever a model is downloaded (user can untick)
  if (!('withLocal' in saved) && opts.models.length) f.withLocal.checked = true;
  for (const p of saved.against || []) addEv(p);
  f.addEventListener('input', changed);
  changed();
})();
</script>
</body></html>`;

// Run directly: node src/gui.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startGui();
}
