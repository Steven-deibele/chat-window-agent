// Smoke test for src/gui.js — run: node test/gui_smoke.mjs
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { createGuiServer, buildArgv } from '../src/gui.js';

// --- buildArgv unit checks ---
assert.deepEqual(buildArgv({ mode: 'edit', file: 'a.docx', against: ['b.pdf'], provider: 'claude', ask: 'fix it', noBackup: true, maxRetries: '5' }),
  ['edit', 'a.docx', '--against', 'b.pdf', '--provider', 'claude', '--ask', 'fix it', '--max-retries', '5', '--no-backup']);
assert.deepEqual(buildArgv({ mode: 'agent', file: 'x.xlsx', against: ['y.pdf'], yes: true, offload: 'bogus' }),
  ['agent', 'x.xlsx', 'y.pdf', '--yes']);
assert.deepEqual(buildArgv({ mode: 'models', provider: 'chatgpt' }), ['models']);
assert.deepEqual(buildArgv({ mode: 'nonsense' })[0], 'agent');
assert.deepEqual(buildArgv({ mode: 'agent', url: 'chat.example.com' }).slice(-2), ['--url', 'https://chat.example.com/'], 'scheme-less URL overrides are normalized');
console.log('buildArgv: ok');

// --- fake child process: deterministic busy/exit behavior, no browser ---
function fakeChild() {
  const c = new EventEmitter();
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.exitCode = null;
  c.kill = () => {
    if (c.exitCode === null) {
      c.exitCode = 0;
      queueMicrotask(() => c.emit('close', 0));
    }
    return true;
  };
  return c;
}
let fake = null;

const server = createGuiServer({
  spawnProcess: () => {
    fake = fakeChild();
    return fake;
  },
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const authHeaders = { 'x-gui-token': server.guiToken };
const api = (p, init = {}) => fetch(base + p, {
  ...init,
  headers: { ...authHeaders, ...(init.headers || {}) },
});
const waitUntil = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

// Captured up front; restored in finally even when an assertion fails.
const settingsFile = 'gui-settings.json';
const settingsBefore = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
const provFile = 'providers.json';
const provBefore = fs.existsSync(provFile) ? fs.readFileSync(provFile, 'utf8') : null;
let sseRes = null;
let sseDone = Promise.resolve();

try {
  assert.deepEqual(buildArgv({ mode: 'agent', provider: 'chatgpt', withLocal: true, model: 'models/m.gguf' }),
    ['agent', '--provider', 'chatgpt', '--model', 'models/m.gguf', '--with-local']);
  assert(!buildArgv({ mode: 'edit', withLocal: true }).includes('--with-local'), 'withLocal only for agent');

  const page = await (await fetch(base + '/')).text();
  assert(page.includes('chat-window-agent') && page.includes('--watch'), 'page served');
  assert(page.includes('window.__GUI_TOKEN__ = "') && !page.includes('%%GUI_TOKEN%%'), 'server token was injected');
  assert(page.includes('<script src="/gui-client.js">'), 'client script is served as an external asset');
  const clientJs = await (await fetch(base + '/gui-client.js')).text();
  new Function(clientJs); // catches syntax errors before the browser does
  assert(clientJs.includes('window.__GUI_TOKEN__'), 'client reads the injected token');
  assert(clientJs.includes('/waiting \\d+s'), 'phase regex survived');
  assert(clientJs.includes('/[\\s"\']/.test(p)'), 'command quoting regex survived');

  assert((await fetch(base + '/api/options')).status === 403, 'API requires token');
  const originProbe = (origin) => api('/api/provider/custom', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: '{"url":""}',
  });
  assert((await originProbe('http://127.0.0.1:9999')).status === 403, 'other loopback origin rejected');
  assert((await originProbe(base)).status === 400, 'server origin accepted');

  const opts = await (await api('/api/options')).json();
  assert(opts.providers.some((p) => p.name === 'chatgpt'), 'providers listed');
  assert(opts.providers.some((p) => p.name === 'local' && p.local), 'local provider flagged');
  assert(Array.isArray(opts.models), 'models listed (may be empty on a clean checkout)');
  console.log('options: ok —', opts.providers.length, 'providers,', opts.models.length, 'models,', opts.docs.length, 'docs');

  await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'edit', provider: 'claude' }) });
  const saved = await (await api('/api/settings')).json();
  assert(saved.provider === 'claude', 'settings persisted');
  console.log('settings: ok');

  const cp = await (await api('/api/provider/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'chat.example-corp.com', plain: true }) })).json();
  assert(cp.ok && cp.name, 'custom provider created');
  const opts2 = await (await api('/api/options')).json();
  const custom = opts2.providers.find((p) => p.name === cp.name);
  assert(custom && custom.label.includes('chat.example-corp.com'), 'custom provider listed');
  assert(!custom.local, 'custom provider is a browser provider');
  const bad = await api('/api/provider/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '' }) });
  assert(bad.status === 400, 'empty URL rejected');
  const badScheme = await api('/api/provider/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'javascript:alert(1)' }) });
  assert(badScheme.status === 400, 'non-http provider URL rejected');
  const unparsable = await api('/api/provider/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://' }) });
  assert(unparsable.status === 400, 'unparseable provider URL gets HTTP 400');
  assert.match((await unparsable.json()).error, /bad custom provider URL/, 'unparseable URL error is actionable, not a raw TypeError');
  const malformed = await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert(malformed.status === 400, 'malformed JSON gets HTTP 400');
  console.log('custom provider: ok —', cp.name);

  // SSE listener (manual: no global EventSource in this Node)
  let sseText = '';
  let exitSeen = false;
  sseRes = await fetch(base + '/api/stream?token=' + encodeURIComponent(server.guiToken));
  const decoder = new TextDecoder();
  sseDone = (async () => {
    for await (const chunk of sseRes.body) {
      for (const m of decoder.decode(chunk, { stream: true }).split('\n\n')) {
        const line = m.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        sseText += msg.text;
        if (msg.type === 'exit') exitSeen = true;
      }
    }
  })();
  assert(await waitUntil(() => sseText.includes('(no session running yet)')), 'SSE connected');

  // preview endpoint: one buildArgv for both preview and run (no client mirror)
  const pvState = { mode: 'edit', file: 'a.docx', provider: 'mock', maxRetries: '0' };
  const pv = await (await api('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pvState) })).json();
  assert(pv.ok, 'preview builds argv');
  assert.deepEqual(pv.argv, buildArgv(pvState), 'preview matches buildArgv (incl. --max-retries 0)');
  assert(pv.argv.includes('0'), 'zero max-retries survives to the preview');
  const pvBad = await (await api('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'agent', url: 'javascript:alert(1)' }) })).json();
  assert(!pvBad.ok && /bad custom URL|http/i.test(pvBad.error), 'preview surfaces buildArgv errors instead of 500ing');
  console.log('preview: ok —', pv.argv.join(' '));

  const run = await (await api('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'models' }) })).json();
  assert(run.ok, 'run accepted');

  // The injected fake never exits until told to, so this cannot race a fast child.
  const busy = await (await api('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'models' }) })).json();
  assert(!busy.ok, 'concurrent run rejected');

  fake.stdout.write('fake models output\n');
  fake.kill();
  assert(await waitUntil(() => exitSeen), 'fake child exit streamed');
  assert(sseText.includes('$ node src/app.js models'), 'command echoed');
  assert(sseText.includes('fake models output'), 'child output streamed');
  console.log('run+stream: ok');
  console.log('--- streamed output ---\n' + sseText.trim());
} finally {
  if (provBefore === null) fs.rmSync(provFile, { force: true }); else fs.writeFileSync(provFile, provBefore);
  if (settingsBefore === null) fs.rmSync(settingsFile, { force: true }); else fs.writeFileSync(settingsFile, settingsBefore);
  if (fake?.exitCode === null) fake.kill();
  if (sseRes) await sseRes.body.cancel().catch(() => {});
  const closed = new Promise((r) => server.close(r));
  server.closeIdleConnections?.(); // keep-alive fetch sockets would otherwise hold close()
  server.closeAllConnections?.();  // cancel() does not always close an active SSE socket promptly
  await closed;
  await sseDone.catch(() => {});
}
