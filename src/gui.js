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
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
  // zero: fields where 0 is meaningful (0 retries, 0 max steps); otherwise 0 is dropped
  const num = (v, { zero = false } = {}) =>
    (v === '' || v == null ? null : (Number.isFinite(+v) && (zero ? +v >= 0 : +v > 0) ? String(+v) : null));
  if (str(s.provider)) a.push('--provider', str(s.provider));
  // custom URLs reach the agent verbatim: validate the scheme here too
  // (/api/run doesn't go through saveCustomProvider's http(s) check)
  if (str(s.url)) {
    let u;
    try { u = new URL(/^[a-z]+:\/\//i.test(s.url) ? s.url : 'https://' + s.url); }
    catch { throw new Error(`bad custom URL ${JSON.stringify(String(s.url).slice(0, 80))}`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
      throw new Error(`custom URL must be http(s), got ${u.protocol}`);
    a.push('--url', u.href);
  }
  if (str(s.model)) a.push('--model', str(s.model));
  if (str(s.remoteProvider)) a.push('--remote-provider', str(s.remoteProvider));
  if (['off', 'low', 'normal', 'aggressive'].includes(s.offload)) a.push('--offload', s.offload);
  if (str(s.ask) && mode !== 'calibrate' && mode !== 'doctor') a.push('--ask', str(s.ask));
  const maxRetries = num(s.maxRetries, { zero: true });
  if (maxRetries) a.push('--max-retries', maxRetries);
  const timeout = num(s.timeout);
  if (timeout) a.push('--timeout', timeout);
  const maxSteps = num(s.maxSteps, { zero: true });
  if (maxSteps && mode === 'agent') a.push('--max-steps', maxSteps);
  const delay = num(s.delay);
  if (delay) a.push('--delay', delay);
  if (s.watch && mode !== 'calibrate') a.push('--watch');
  if (s.noBackup && (mode === 'edit' || mode === 'fill')) a.push('--no-backup');
  if (s.yes) a.push('--yes');
  if (s.plain) a.push('--plain');
  if (s.simple) a.push('--simple');
  // agent mode: the local sidecar checkbox is the explicit choice both ways —
  // checked pins --with-local (fail loudly if no model), unticked opts out
  // with --no-local (the CLI default is: load whenever a model is ready)
  if (mode === 'agent') a.push(s.withLocal ? '--with-local' : '--no-local');
  return a;
}

// --- child process + output buffer ------------------------------------------
let child = null;
let logBuf = [];           // replayed to every new SSE client
let logBytes = 0;
const sseClients = new Set();
const MAX_SSE_CLIENTS = 20; // bound FD usage: extra EventSource tabs get 503

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
  // SIGTERM first (lets app.js flush on POSIX; on Windows kill() is
  // TerminateProcess — immediate, no flush). SIGKILL fallback so a stuck
  // Chrome driver can't keep the GUI busy forever.
  try { child.kill(); } catch { /* already gone */ }
  if (process.platform === 'win32') return; // no graceful signal exists to escalate from
  const victim = child;
  // exitCode !== null means the child was already reaped — killing then could
  // hit a recycled PID belonging to an unrelated process
  const killer = setTimeout(() => {
    if (victim.exitCode === null) { try { victim.kill('SIGKILL'); } catch { /* exited */ } }
  }, 5000);
  killer.unref?.();
}

function runChild(argv, spawnProcess = spawn) {
  if (child) throw new Error('a session is already running — stop it first');
  logBuf = []; logBytes = 0;
  const printable = ['node src/app.js', ...argv.map((x) => (/\s/.test(x) ? `"${x}"` : x))].join(' ');
  pushLog('sys', `$ ${printable}\n`);
  child = spawnProcess(process.execPath, [APP_JS, ...argv], {
    cwd: APP_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // a dead child's stdin emits an async 'error' that would otherwise crash the
  // whole GUI server with an uncaught exception (e.g. /api/input racing exit)
  child.stdin.on('error', (e) => pushLog('err', `stdin write failed: ${e.message}\n`));
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
  // In tests/embedded use the server may already be closed; the timer must not
  // be the sole handle keeping that process alive. In production the listening
  // server keeps the loop alive, so the shutdown deadline still fires.
  shutdownTimer.unref?.();
}
function cancelShutdown() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
}

// --- HTTP --------------------------------------------------------------------
// Only loopback clients may drive the GUI: the browser page is served from
// this same server, so any other Host means DNS-rebinding or a foreign origin
// probing the port. Reject before touching any endpoint.
function loopbackOnly(req, res) {
  const host = String(req.headers.host || '').split(',')[0].trim().toLowerCase();
  // reject userinfo/scheme/path/whitespace in Host: new URL('http://x@127.0.0.1')
  // would otherwise report hostname 127.0.0.1 for a malformed header
  if (/[@/\\?#\s]/.test(host)) {
    json(res, { error: 'forbidden: bad host header' }, 403);
    return false;
  }
  let name;
  try { name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, ''); }
  catch { name = ''; }
  if (name !== '127.0.0.1' && name !== '::1' && name !== 'localhost') {
    json(res, { error: 'forbidden: loopback only' }, 403);
    return false;
  }
  if (req.method === 'OPTIONS') {
    json(res, { error: 'forbidden' }, 403);
    return false;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = String(req.headers.origin || '');
    if (origin) {
      let o = null;
      try { o = new URL(origin); } catch { /* rejected below */ }
      if (!o || o.protocol !== 'http:' || o.host.toLowerCase() !== host) {
        json(res, { error: 'forbidden: bad origin' }, 403);
        return false;
      }
    }
  }
  return true;
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireToken(req, res, u, token) {
  // Query-string token only for /api/stream: EventSource cannot set headers,
  // and confining it there keeps the token out of any future per-request
  // logging of API URLs.
  const given = req.headers['x-gui-token'] || (u.pathname === '/api/stream' ? u.searchParams.get('token') : null);
  if (!tokenMatches(given, token)) {
    json(res, { error: 'forbidden: bad GUI token' }, 403);
    return false;
  }
  return true;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function readBody(req) {
  // collect raw Buffers and decode at the end: chunk.length on a Buffer is
  // bytes (the cap must be byte-accurate) and Buffer.concat cannot split a
  // multi-byte UTF-8 sequence the way per-chunk string decoding can
  const chunks = [];
  let size = 0, tooLarge = false;
  for await (const chunk of req) {
    // keep draining even past the cap so the connection stays reusable
    if (tooLarge) continue;
    size += chunk.length;
    if (size > 1_000_000) { tooLarge = true; chunks.length = 0; continue; }
    chunks.push(chunk);
  }
  if (tooLarge) throw httpError(413, 'request body too large');
  const data = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(data || '{}'); }
  catch { throw httpError(400, 'malformed JSON body'); }
}

function json(res, obj, code = 200) {
  // a route that already wrote headers (e.g. an SSE stream) must not make the
  // error handler throw ERR_HTTP_HEADERS_SENT and leave an unhandled rejection
  if (res.headersSent) { try { res.end(); } catch { /* already ended */ } return; }
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
}

// Read once at startup: the client is served as a static asset (see the
// /gui-client.js route) so it lives in a real .js file instead of a giant
// template literal, and needs no escaping.
const CLIENT_JS = fs.readFileSync(new URL('./gui_client.js', import.meta.url), 'utf8');

function pageForToken(token) {
  // The token is embedded in the served page: anyone who can READ this origin
  // is trusted to drive it. The loopback Host check in loopbackOnly() is the
  // only thing keeping a DNS-rebinding browser tab from receiving the token —
  // do not weaken that gate.
  return PAGE.replaceAll('%%GUI_TOKEN%%', token);
}

async function handle(req, res, token, spawnProcess) {
  const u = new URL(req.url, 'http://localhost');
  if (!loopbackOnly(req, res)) return;
  if (u.pathname.startsWith('/api/') && !requireToken(req, res, u, token)) return;
  cancelShutdown();
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(pageForToken(token));
  }
  if (u.pathname === '/gui-client.js') {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(CLIENT_JS);
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
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return json(res, { ok: false, error: 'settings must be a JSON object' }, 400);
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
  if (u.pathname === '/api/preview' && req.method === 'POST') {
    // the page renders the exact argv the run will get — one source of truth
    // (buildArgv) instead of a mirrored copy of the mode gates in the client
    const body = await readBody(req);
    try { return json(res, { ok: true, argv: buildArgv(body) }); }
    catch (e) { return json(res, { ok: false, error: e.message }); }
  }
  if (u.pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    let argv;
    try { argv = buildArgv(body); } // single build: no duplicate fs walks, echo === what ran
    catch (e) { return json(res, { ok: false, error: e.message }, 400); } // bad form state (e.g. URL)
    try {
      runChild(argv, spawnProcess);
      return json(res, { ok: true, argv });
    } catch (e) { return json(res, { ok: false, error: e.message }, 409); } // session already running
  }
  if (u.pathname === '/api/input' && req.method === 'POST') {
    const body = await readBody(req);
    const writable = !!child && child.exitCode === null;
    if (writable && typeof body.line === 'string') {
      pushLog('in', `> ${body.line}\n`);
      try { child.stdin.write(body.line + '\n'); } catch { /* child exited mid-write */ }
    }
    return json(res, { ok: writable });
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
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('too many stream clients');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'sys', text: child ? '' : '(no session running yet)\n' })}\n\n`);
    for (const item of logBuf) res.write(`data: ${JSON.stringify(item)}\n\n`);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); scheduleShutdown(); });
    return;
  }
  json(res, { error: 'not found' }, 404);
}

export function createGuiServer({ spawnProcess = spawn } = {}) {
  const token = randomBytes(24).toString('base64url');
  const server = http.createServer((req, res) =>
    handle(req, res, token, spawnProcess).catch((e) => json(res, { error: e.message }, e.status || 500)));
  server.guiToken = token;
  return server;
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
:root{--bg:#14161a;--panel:#1d2026;--border:#30343c;--fg:#e6e8eb;--muted:#9aa0a8;--accent:#4f8cff;--ok:#3fb96b;--err:#e05c5c;--warn:#e0a94f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,sans-serif}
header{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header b{font-size:15px}
header .sp{flex:1}
#phase{font-size:12px;color:var(--accent);background:rgba(79,140,255,.12);border:1px solid rgba(79,140,255,.35);border-radius:999px;padding:3px 10px;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#phase.ok{color:var(--ok);background:rgba(63,185,107,.12);border-color:rgba(63,185,107,.35)}
#phase.err{color:var(--err);background:rgba(224,92,92,.12);border-color:rgba(224,92,92,.35)}
#phase.warn{color:var(--warn);background:rgba(224,169,79,.12);border-color:rgba(224,169,79,.35)}
main{display:grid;grid-template-columns:390px 1fr;gap:0;height:calc(100vh - 49px)}
form{padding:14px 16px;overflow:auto;border-right:1px solid var(--border)}
label{display:block;margin:10px 0 3px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
select,input[type=text],input[type=number],textarea{width:100%;background:#0f1114;border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:7px 9px;font:inherit}
select:focus,input:focus,textarea:focus{outline:none;border-color:var(--accent)}
textarea{min-height:64px;resize:vertical}
.row{display:flex;gap:8px;align-items:center}
.checks{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:8px}
.checks label{display:flex;gap:6px;align-items:center;margin:0;text-transform:none;letter-spacing:0;color:var(--fg);font-size:13px}
.checks input{width:auto}
button{background:var(--accent);border:0;color:#fff;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--border);color:var(--fg)}
button:disabled{opacity:.45;cursor:default}
button.primary{font-weight:600}
/* --- intro / steps / advanced --- */
.intro{background:linear-gradient(180deg,#1b2233,#1a1e26);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;padding:10px 12px;margin-bottom:6px}
.intro p{margin:0;font-size:12.5px;color:var(--fg);line-height:1.5}
.intro b{color:#fff}
.intro .how{color:var(--muted);font-size:11.5px;margin-top:4px}
.step{margin-top:14px}
.step>.steptitle{display:flex;align-items:center;gap:8px;margin:0 0 6px;color:var(--fg);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.step>.steptitle .n{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;flex:none}
.step .body{border:1px solid var(--border);border-radius:8px;padding:6px 12px 12px;background:var(--panel)}
details.adv{border:1px solid var(--border);border-radius:8px;background:var(--panel);padding:0;margin-top:14px}
details.adv>summary{cursor:pointer;list-style:none;padding:9px 12px;color:var(--fg);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;user-select:none}
details.adv>summary::-webkit-details-marker{display:none}
details.adv>summary::before{content:"▸ ";color:var(--accent)}
details.adv[open]>summary::before{content:"▾ "}
details.adv>.advbody{padding:0 12px 12px}
details.adv label:first-of-type{margin-top:0}
/* --- command preview + run --- */
#cmdwrap{margin-top:12px}
#cmdbar{display:flex;align-items:center;gap:8px;margin-bottom:4px}
#cmdbar .lbl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;flex:1}
#preview{margin:0;background:#0f1114;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font:12px ui-monospace,Consolas,monospace;color:var(--muted);word-break:break-all;white-space:pre-wrap}
#copybtn{padding:3px 9px;font-size:11px}
#evlist div{display:flex;justify-content:space-between;gap:8px;background:#0f1114;border:1px solid var(--border);border-radius:6px;padding:4px 8px;margin-top:4px;font-size:12px}
#evlist a{color:var(--err);cursor:pointer;text-decoration:none}
.right{display:flex;flex-direction:column;min-width:0}
#outwrap{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);color:var(--muted);font-size:12px}
#outwrap .title{font-weight:700;color:var(--fg);letter-spacing:.03em}
#outwrap .sp{flex:1}
#outwrap label{display:inline-flex;align-items:center;gap:5px;margin:0;text-transform:none;letter-spacing:0;color:var(--muted);font-size:12px;cursor:pointer}
#outwrap input{width:auto}
#outwrap button{padding:3px 9px;font-size:11px}
#out{flex:1;overflow:auto;margin:0;padding:12px 16px;font:12.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
#out .err{color:var(--err)} #out .sys{color:var(--muted)} #out .in{color:var(--accent)} #out .exit{color:var(--ok)}
#inputrow{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border)}
#stdin{flex:1}
#stdin:disabled{opacity:.5}
.hidden{display:none!important}
.status{font-size:12px;color:var(--muted)}
.help{font-size:11px;color:var(--muted);margin:2px 0 6px;line-height:1.35}
.fmdir{padding:6px 10px;border-radius:5px;cursor:pointer;font-size:13px}
.fmdir:hover{background:var(--border)}
#foldermodal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:10}
#foldermodal.hidden{display:none}
#foldermodal .box{background:var(--panel);border:1px solid var(--border);border-radius:8px;width:440px;max-height:70vh;display:flex;flex-direction:column}
#fmlist{flex:1;overflow:auto;padding:6px}
@media (max-width:760px){main{grid-template-columns:1fr;height:auto}form{border-right:0;border-bottom:1px solid var(--border)}.right{min-height:50vh}}
</style></head>
<body>
<header><b>chat-window-agent</b><span class="help" style="margin:0;max-width:34ch">edit Word &amp; Excel with a browser chat AI — no API keys</span>
<span class="sp"></span><span id="phase" class="hidden" title="what the session is doing right now"></span>
<span class="status" id="status">idle</span>
<button class="ghost" id="quitbtn" type="button">Quit</button></header>
<main>
<form id="f" onsubmit="return false">
  <div class="intro">
    <p><b>Drive a real AI chat in Chrome</b> to read and edit your documents — no API keys. Pick a <b>mode</b>, pick the <b>AI chat</b>, then <b>Run</b>. The session output appears on the right; type there to steer it.</p>
    <p class="how">First time? Log into your AI in the Chrome window it opens — the session is remembered.</p>
  </div>
  <div class="step">
    <div class="steptitle"><span class="n">1</span> What should it do?</div>
    <div class="body">
    <select name="mode" aria-label="Mode">
      <option value="agent">agent — conversational AI with tools (default)</option>
      <option value="edit">edit — edit one Word/Excel file</option>
      <option value="fill">fill — compliance checklist vs evidence docs</option>
      <option value="ask">ask — one question to a cloud chat, no tools</option>
      <option value="calibrate">calibrate — teach a custom chat UI</option>
      <option value="doctor">doctor — diagnose browser selectors</option>
      <option value="models">models — list downloaded local models</option>
    </select>
    <div class="help" id="modehelp"></div>
    </div>
  </div>
  <div class="step">
    <div class="steptitle"><span class="n">2</span> Which AI chat?</div>
    <div class="body">
    <div class="row"><select name="provider" id="provider" style="flex:1" aria-label="AI chat provider"></select>
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
      <label style="grid-column:1/-1" title="Loads a downloaded GGUF model on this machine next to the browser session (the CLI does this by default whenever a model is downloaded). The chat-window AI gets a local.ask tool to hand it on-machine work (summaries, extraction, drafting) — nothing leaves the computer. Untick to start without it (--no-local)."><input type="checkbox" name="withLocal"> local AI runs alongside (local.ask)</label>
    </div>
    <div class="help">your local model works next to the big chat-window AI — untick to skip it; nothing leaves the computer</div>
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
    </div>
  </div>
  <div class="step" id="filewrap">
    <div class="steptitle"><span class="n">3</span> Files <span class="help" style="margin:0;text-transform:none;letter-spacing:0">(optional)</span></div>
    <div class="body">
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
  </div>
  <div class="step">
    <div class="steptitle"><span class="n">4</span> Instruction <span class="help" style="margin:0;text-transform:none;letter-spacing:0">(optional)</span></div>
    <div class="body">
    <textarea name="ask" placeholder="e.g. fix the totals and flag anomalies" title="What the AI should do. Leave empty for an interactive session you steer from the input box on the right."></textarea>
    <div class="help">leave empty for an interactive session you steer from the input box on the right</div>
    </div>
  </div>

  <details class="adv" id="advanced">
    <summary>Advanced options</summary>
    <div class="advbody">
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
    <label>Chat URL override (optional)</label>
    <input type="text" name="url" placeholder="https://…">
    <div class="help">override the chat URL — also selects which already-open tab to drive</div>
    </div>
  </details>

  <div id="cmdwrap">
    <div id="cmdbar"><span class="lbl">Command that will run</span><button class="ghost" type="button" id="copybtn" title="Copy the command to the clipboard">Copy</button></div>
    <div id="preview"></div>
    <div class="row" style="margin-top:10px">
      <button id="run" type="button" class="primary" title="Run (Ctrl/Cmd + Enter)">▶ Run</button>
      <button class="ghost" id="stop" type="button" disabled>■ Stop</button>
    </div>
  </div>
</form>
<div class="right">
  <div id="outwrap">
    <span class="title">Session output</span>
    <span class="sp"></span>
    <label title="Keep the newest output in view"><input type="checkbox" id="autoscroll" checked> auto-scroll</label>
    <button class="ghost" type="button" id="clearbtn">Clear</button>
  </div>
  <pre id="out"></pre>
  <div id="inputrow"><input id="stdin" type="text" placeholder="Reply to the session here (answers agent&gt; prompts and [y/N] questions), then press Enter" disabled><button type="button" id="send" disabled>Send</button></div>
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
<script>window.__GUI_TOKEN__ = "%%GUI_TOKEN%%";</script>
<script src="/gui-client.js"></script>
</body></html>`;

// Run directly: node src/gui.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startGui().catch((e) => { console.error(`[gui] failed to start: ${e.message}`); process.exit(1); });
}
