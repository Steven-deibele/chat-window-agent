// Throwaway smoke test for src/gui.js — run: node test/gui_smoke.mjs
import assert from 'node:assert';
import { createGuiServer, buildArgv } from '../src/gui.js';

// --- buildArgv unit checks ---
assert.deepEqual(buildArgv({ mode: 'edit', file: 'a.docx', against: ['b.pdf'], provider: 'claude', ask: 'fix it', noBackup: true, maxRetries: '5' }),
  ['edit', 'a.docx', '--against', 'b.pdf', '--provider', 'claude', '--ask', 'fix it', '--max-retries', '5', '--no-backup']);
assert.deepEqual(buildArgv({ mode: 'agent', file: 'x.xlsx', against: ['y.pdf'], yes: true, offload: 'bogus' }),
  ['agent', 'x.xlsx', 'y.pdf', '--yes']);
assert.deepEqual(buildArgv({ mode: 'models', provider: 'chatgpt' }), ['models']);
assert.deepEqual(buildArgv({ mode: 'nonsense' })[0], 'agent');
console.log('buildArgv: ok');

// --- HTTP end-to-end ---
const server = createGuiServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
assert.deepEqual(buildArgv({ mode: 'agent', provider: 'chatgpt', withLocal: true, model: 'models/m.gguf' }),
  ['agent', '--provider', 'chatgpt', '--model', 'models/m.gguf', '--with-local']);
assert(!buildArgv({ mode: 'edit', withLocal: true }).includes('--with-local'), 'withLocal only for agent');
const base = `http://127.0.0.1:${server.address().port}`;

const page = await (await fetch(base + '/')).text();
assert(page.includes('chat-window-agent') && page.includes('--watch'), 'page served');

const opts = await (await fetch(base + '/api/options')).json();
assert(opts.providers.some((p) => p.name === 'chatgpt'), 'providers listed');
assert(opts.providers.some((p) => p.name === 'local' && p.local), 'local provider flagged');
assert(opts.models.some((m) => m.endsWith('.gguf')), 'models listed');
console.log('options: ok —', opts.providers.length, 'providers,', opts.models.length, 'models,', opts.docs.length, 'docs');

// settings round-trip (gui-settings.json restored afterwards)
const settingsFile = 'gui-settings.json';
const settingsBefore = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'edit', provider: 'claude' }) });
const saved = await (await fetch(base + '/api/settings')).json();
assert(saved.provider === 'claude', 'settings persisted');
console.log('settings: ok');

// custom provider creation (providers.json restored afterwards)
import fs from 'node:fs';
const provFile = 'providers.json';
const provBefore = fs.existsSync(provFile) ? fs.readFileSync(provFile, 'utf8') : null;
const cp = await (await fetch(base + '/api/provider/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'chat.example-corp.com', plain: true }) })).json();
assert(cp.ok && cp.name, 'custom provider created');
const opts2 = await (await fetch(base + '/api/options')).json();
const custom = opts2.providers.find((p) => p.name === cp.name);
assert(custom && custom.label.includes('chat.example-corp.com'), 'custom provider listed');
assert(!custom.local, 'custom provider is a browser provider');
const bad = await (await fetch(base + '/api/provider/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '' }) }));
assert(bad.status === 400, 'empty URL rejected');
if (provBefore === null) fs.unlinkSync(provFile); else fs.writeFileSync(provFile, provBefore);
if (settingsBefore === null) fs.rmSync(settingsFile, { force: true }); else fs.writeFileSync(settingsFile, settingsBefore);
console.log('custom provider: ok —', cp.name);

// SSE listener (manual: no global EventSource in this Node)
let sseText = '';
let exitSeen = false;
const sseRes = await fetch(base + '/api/stream');
const decoder = new TextDecoder();
(async () => {
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
await new Promise((r) => setTimeout(r, 300));

// run the fast, browser-free `models` command through the GUI plumbing
const run = await (await fetch(base + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'models' }) })).json();
assert(run.ok, 'run accepted');

// a second run while busy must be rejected
const busy = await (await fetch(base + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'models' }) })).json();
assert(!busy.ok, 'concurrent run rejected');

await new Promise((r) => { const t = setInterval(() => { if (exitSeen) { clearInterval(t); r(); } }, 100); });
assert(sseText.includes('$ node src/app.js models'), 'command echoed');
assert(sseText.toLowerCase().includes('gguf'), 'models output streamed');
console.log('run+stream: ok');
console.log('--- streamed output ---\n' + sseText.trim());

sseRes.body.cancel();
server.close();
process.exit(0);
