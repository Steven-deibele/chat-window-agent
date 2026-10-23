// Automated end-to-end suite: real Chrome driven against the mock AI chat
// (mock/server.js), asserting the files each scenario produces. No API keys,
// no real AI. Run: node test/e2e.mjs   (or: npm test)
//
// Isolation: own Chrome debug port + profile under .wh-work/, own memory dir,
// mock chat on its own port. providers.json is backed up/restored around the
// calibrate scenario. The e2e Chrome instance is killed at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'src', 'app.js');
const PROFILE = path.join(ROOT, '.wh-work', 'e2e-profile');
let DEBUG_PORT;
const only = process.argv[2]; // optional: run a single scenario by name

const results = [];
function report(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : (detail ? '\n' + detail : '')}`);
  results.push({ name, ok });
}

async function freePort(from) {
  for (let p = from; p < from + 50; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => { try { s.close(); } catch {} res(false); });
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('no free loopback port available');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kill only Chrome/Edge processes using this suite's throwaway profile. */
async function killE2EChrome() {
  if (process.platform === 'win32') {
    const esc = PROFILE.replace(/'/g, "''");
    // .Contains() not -like: brackets in the path would be wildcard char classes in -like.
    // OrdinalIgnoreCase: Chrome may normalize path casing in its command line.
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('user-data-dir=${esc}', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const k = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => { k.on('close', r); k.on('error', r); setTimeout(r, 15000).unref?.(); });
  } else {
    const k = spawn('pkill', ['-f', `user-data-dir=${PROFILE}`], { stdio: 'ignore' });
    await new Promise((r) => { k.on('close', r); k.on('error', r); setTimeout(r, 10000).unref?.(); });
  }
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    WH_DEBUG_PORT: String(DEBUG_PORT),
    WH_NO_CLICK_WAIT: '1',                 // no human to click the composer in CI
    WH_PICKER: 'list',                     // never open native dialogs
    WH_MEMORY_DIR: path.join(ROOT, '.wh-work', 'e2e-memory'),
    ...extra,
  };
}

/** Spawn src/app.js, streaming output into a buffer. Returns controls. */
function runApp(argv, { env = {}, timeoutMs = 150000 } = {}) {
  // --profile: never touch the developer's real .chrome-profile (and keep
  // ensureChrome's stale-zombie kill aimed at the throwaway profile only)
  const c = spawn(process.execPath, [APP, ...argv, '--profile', PROFILE], {
    cwd: ROOT, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  // writing after the child exits emits an async EPIPE 'error' — without a
  // handler it crashes the whole suite runner (interactive scenarios only)
  c.stdin.on('error', () => {});
  const exited = new Promise((res) => c.on('close', (code) => res(code)));
  // tracked so SIGINT cleanup can kill a still-running scenario child
  activeProcs.add(c);
  c.on('close', () => activeProcs.delete(c));
  const timer = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
  timer.unref?.();
  return {
    proc: c,
    out: () => out,
    stdin: (s) => c.stdin.write(s),
    kill: () => { try { c.kill(); } catch {} },
    /** Resolve when `marker` appears in output or the process exits. */
    async waitFor(marker, ms = timeoutMs) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (out.includes(marker)) return true;
        if (await Promise.race([exited.then(() => true), sleep(250).then(() => false)])) break;
      }
      return out.includes(marker);
    },
    async waitExit(ms = timeoutMs) {
      const code = await Promise.race([exited, sleep(ms).then(() => null)]);
      clearTimeout(timer);
      if (code === null) { try { c.kill(); } catch {} await exited; return null; }
      return code;
    },
  };
}

/** Regenerate pristine test files (mutating scenarios need a clean base). */
async function resetSamples() {
  await new Promise((res, rej) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'samples', 'make_samples.mjs')], { cwd: ROOT, stdio: 'ignore' });
    c.on('close', (code) => (code === 0 ? res() : rej(new Error(`make_samples exit ${code}`))));
  });
  for (const f of ['agent-note.txt', 'downloaded.html']) fs.rmSync(path.join(ROOT, 'test-files', f), { force: true });
}

async function verify(scenario) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'test', 'verify.mjs'), scenario], { cwd: ROOT });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => res({ code, out }));
  });
}

const tail = (s, n = 1200) => s.slice(-n);

// --- scenarios ---------------------------------------------------------------
// Each: { name, reset?, args(base), env?, assert(code, out) | waitMarker + verify }

const scenarios = [
  {
    name: 'edit/budget (xlsx ops)',
    reset: true,
    args: (b) => ['edit', 'test-files/Budget.xlsx', '--provider', 'mock', '--url', `${b}/`, '--ask', 'BUDGET update'],
    verify: 'budget',
  },
  {
    name: 'edit/hello (docx ops)',
    reset: true,
    args: (b) => ['edit', 'test-files/checklist.docx', '--provider', 'mock', '--url', `${b}/`, '--ask', 'HELLODOC'],
    verify: 'hello',
  },
  {
    name: 'fill/checklist (evidence review)',
    reset: true,
    args: (b) => ['fill', 'test-files/checklist.docx', '--against', 'test-files/Policy.pdf', '--against', 'test-files/Budget.xlsx', '--provider', 'mock', '--url', `${b}/`, '--ask', 'CHECKLIST'],
    verify: 'fill',
  },
  {
    name: 'retry (bad JSON self-correction)',
    reset: true,
    args: (b) => ['edit', 'test-files/Budget.xlsx', '--provider', 'mock', '--url', `${b}/`, '--ask', 'RETRYTEST'],
    expectOut: ['parse error'],
    verify: 'retry',
  },
  {
    name: 'footerdecoy (real input chosen over footer decoy)',
    reset: true,
    args: (b) => ['edit', 'test-files/Budget.xlsx', '--provider', 'mock', '--url', `${b}/?scenario=footerdecoy`, '--ask', 'BUDGET update'],
    verify: 'budget',
  },
  {
    name: 'captcha (human-check wait, auto-continue)',
    reset: true,
    args: (b) => ['edit', 'test-files/checklist.docx', '--provider', 'mock', '--url', `${b}/?scenario=captcha`, '--ask', 'HELLODOC'],
    expectOut: ['human check'],
    verify: 'hello',
  },
  {
    name: 'loggedout (login-wall wait, auto-continue)',
    reset: true,
    args: (b) => ['edit', 'test-files/checklist.docx', '--provider', 'mock', '--url', `${b}/?scenario=loggedout`, '--ask', 'HELLODOC'],
    expectOut: ['not logged in'],
    verify: 'hello',
  },
  {
    name: 'watch (human types in the browser)',
    reset: true,
    args: (b) => ['edit', 'test-files/checklist.docx', '--provider', 'mock', '--url', `${b}/?scenario=watch`, '--watch'],
    waitMarker: 'applied op[', // the page auto-sends after 8s; kill once ops landed
    verify: 'watch',
  },
  {
    name: 'agent (tool loop: docs, tools.create, http, download)',
    reset: true,
    args: (b) => ['agent', '--provider', 'mock', '--url', `${b}/?scenario=agent`, '--ask', 'run the budget demo', '--yes', '--no-local'],
    verify: 'agent',
  },
  {
    name: 'agentbatch (multi-tool roundtrip)',
    args: (b) => ['agent', '--provider', 'mock', '--url', `${b}/?scenario=agentbatch`, '--ask', 'list and report', '--yes', '--no-local'],
    expectOut: ['batched fs.list + sys.info'],
  },
  {
    name: 'agentsub (parallel sub-agents in new tabs)',
    args: (b) => ['agent', '--provider', 'mock', '--url', `${b}/?scenario=agentsub`, '--ask', 'delegate the work', '--yes', '--no-local'],
    expectOut: ['spawned 2 sub-agents'],
  },
  {
    name: 'withlocal-missing (default sidecar skips silently, explicit flag fails)',
    // --with-local + a model ref that is NOT on disk: resolveSilentModelRef
    // must refuse (no download), and the explicit flag turns that into a
    // startup error before any chat is driven
    args: (b) => ['agent', '--provider', 'mock', '--url', `${b}/`, '--with-local', '--model', 'hf:e2e/not-a-real-repo/missing.gguf'],
    expectOut: ['--with-local: no local model ready'],
    expectExit: 1,
  },
  {
    name: 'agentcompress (auto-compress + handoff)',
    args: (b) => ['agent', '--provider', 'mock', '--url', `${b}/?scenario=agentcompress`, '--no-local'],
    env: { WH_COMPRESS_AT: '200' },
    interactive: async (h) => {
      if (!(await h.waitFor('agent ready'))) return false;
      h.stdin('hello\nexit\n');
      h.proc.stdin.end();
      return true;
    },
    expectOut: ['auto-compressing', 'WITH handoff'],
  },
  {
    name: 'agentwatch (agent steered from the browser)',
    args: (b) => ['agent', '--provider', 'mock', '--url', `${b}/?scenario=agentwatch`, '--watch', '--yes', '--no-local'],
    waitMarker: 'listed test-files for the user',
  },
  {
    name: 'calibrate (selector auto-detection)',
    args: (b) => ['calibrate', '--provider', 'mock', '--url', `${b}/?scenario=calibrate`],
    expectOut: ['assistant selector:'],
    touchesProvidersJson: true,
  },
  {
    name: 'doctor (selector diagnosis)',
    args: (b) => ['doctor', '--provider', 'mock', '--url', `${b}/`],
    expectOut: ['assistant', '-> 1'],
  },
];

// --- main --------------------------------------------------------------------
console.log('e2e: starting mock chat server…');
DEBUG_PORT = await freePort(18222);
await killE2EChrome(); // clear a stale browser from an interrupted prior run
const mockPort = await freePort(18123);
const mock = spawn(process.execPath, [path.join(ROOT, 'mock', 'server.js')], {
  cwd: ROOT, env: { ...process.env, MOCK_PORT: String(mockPort) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let mockOut = '';
mock.stdout.on('data', (d) => { mockOut += d; });
mock.stderr.on('data', (d) => { mockOut += d; });
const base = `http://127.0.0.1:${mockPort}`;
let mockUp = false;
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(base + '/')).ok) { mockUp = true; break; } } catch { /* not up yet */ }
  await sleep(250);
}
if (!mockUp) {
  mock.kill();
  console.error('FAIL  mock chat server never came up — aborting (no scenarios ran)');
  if (mockOut) console.error(tail(mockOut, 2000));
  process.exit(1);
}

const provFile = path.join(ROOT, 'providers.json');
const provBefore = fs.existsSync(provFile) ? fs.readFileSync(provFile, 'utf8') : null;
const toolFile = path.join(ROOT, 'tools', 'notes.add.js');
const toolBefore = fs.existsSync(toolFile) ? fs.readFileSync(toolFile, 'utf8') : null;

let failed = 0;
let ranAny = false;

// Ctrl+C (or a terminal close) must not leave providers.json/tools mutated,
// the mock server or app children running, or the e2e Chrome alive — the
// finally below only runs on normal completion.
let cleaned = false;
const activeProcs = new Set();
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of activeProcs) { try { p.kill(); } catch { /* already gone */ } }
  if (provBefore === null) fs.rmSync(provFile, { force: true }); else fs.writeFileSync(provFile, provBefore);
  if (toolBefore === null) fs.rmSync(toolFile, { force: true }); else fs.writeFileSync(toolFile, toolBefore);
  mock.kill();
  try { await resetSamples(); } catch { /* leave whatever the last scenario produced */ }
  await killE2EChrome();
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\ne2e: ${sig} — cleaning up`);
    await cleanup();
    process.exit(130);
  });
}

try {
  // browser-free module checks first (fast fail for broken doc/pdf plumbing)
  const { snapshotFile } = await import('../src/reader.js');
  await resetSamples();
  const pdf = await snapshotFile(path.join(ROOT, 'test-files', 'Policy.pdf'));
  report('pdf evidence text extraction', /Fire safety training is mandatory/.test(pdf.text), tail(pdf.text, 400));
  for (const [name, file] of [
    ['scrub (secret redaction)', 'scrub.mjs'],
    ['review regressions', 'regression.mjs'],
    ['HTTP SSRF guard', 'security.mjs'],
  ]) {
    const c = spawn(process.execPath, [path.join(ROOT, 'test', file)], { cwd: ROOT });
    let detail = '';
    c.stdout.on('data', (d) => { detail += d; });
    c.stderr.on('data', (d) => { detail += d; });
    const code = await new Promise((r) => c.on('close', r));
    report(name, code === 0, tail(detail));
  }

  for (const sc of scenarios) {
    if (only && !sc.name.toLowerCase().includes(only.toLowerCase())) continue;
    ranAny = true;
    console.log(`\n=== ${sc.name} ===`);
    try {
      if (sc.reset) await resetSamples();
      const h = runApp(sc.args(base), { env: sc.env });
      let ok = true;
      let detail = '';
      if (sc.interactive && !(await sc.interactive(h))) { ok = false; detail = 'session never became ready'; }
      if (sc.waitMarker) {
        if (ok && !(await h.waitFor(sc.waitMarker))) { ok = false; detail = `never saw "${sc.waitMarker}"`; }
        h.kill();
        await h.waitExit(10000);
      } else if (ok) {
        const code = await h.waitExit();
        // expectExit: scenarios that assert a deliberate startup failure
        if (code !== (sc.expectExit ?? 0)) { ok = false; detail = `exit code ${code}`; }
      } else {
        // failed before/inside interactive: kill the child — a live one holds
        // the shared debug port + profile and cascade-fails later scenarios
        h.kill();
        await h.waitExit(10000);
      }
      const out = h.out();
      if (ok && sc.expectOut) {
        for (const m of sc.expectOut) {
          if (!out.includes(m)) { ok = false; detail = `missing output "${m}"`; }
        }
      }
      if (ok && sc.verify) {
        const v = await verify(sc.verify);
        if (v.code !== 0) { ok = false; detail = 'verify failed:\n' + tail(v.out); }
      }
      report(sc.name, ok, ok ? '' : `${detail}\n--- output tail ---\n${tail(out)}\n--- mock server tail ---\n${tail(mockOut, 600)}`);
    } catch (e) {
      report(sc.name, false, e.stack || String(e));
    }
  }
} finally {
  await cleanup();
}

if (only && !ranAny) {
  console.error(`\nFAIL  no scenario matches "${only}". Available: ${scenarios.map((s) => s.name.split(' ')[0]).join(', ')}`);
  process.exit(1);
}

failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} e2e checks passed`);
process.exit(failed ? 1 : 0);
