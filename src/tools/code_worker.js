// Worker for the approval-gated code.run tool. This is intentionally not a
// privilege sandbox: snippets may require modules, use fetch, and read env.
// Protocol: console output streams as {type:'log', line} so the parent keeps
// partial output on timeout; completion is a single {type:'result', ...}.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const postLog = (line) => parentPort.postMessage({ type: 'log', line });
// objects log as JSON (not "[object Object]") so snippets can print data
const fmt = (a) => a.map((x) => {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x) ?? String(x); } catch { return String(x); }
}).join(' ');
const moduleShim = { exports: {} };
const sandbox = {
  console: {
    log: (...a) => postLog(fmt(a)),
    error: (...a) => postLog('ERR ' + fmt(a)),
    warn: (...a) => postLog('WARN ' + fmt(a)),
  },
  require: createRequire(path.join(workerData.cwd, 'code-run.cjs')),
  process: { env: workerData.env, platform: process.platform, cwd: () => workerData.cwd },
  setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
  Buffer, __dirname: workerData.cwd,
  module: moduleShim, exports: moduleShim.exports,
  fetch, URL, URLSearchParams, TextEncoder, TextDecoder,
};
const send = (status, extra = {}) => parentPort.postMessage({ type: 'result', status, ...extra });

let script;
try { script = new vm.Script(`(async () => {\n${workerData.code}\n})()`); }
catch (e) { send('syntax', { error: e.message }); }
if (script) {
  Promise.resolve(script.runInNewContext(sandbox, { timeout: workerData.timeoutMs }))
    .then((value) => {
      let result;
      if (value !== undefined) {
        try { result = typeof value === 'string' ? value : JSON.stringify(value); }
        catch { result = String(value); }
      }
      send('ok', { result });
    })
    .catch((e) => send('throw', {
      error: e.message,
      stack: String(e.stack || '').split('\n').slice(0, 3).join('\n'),
    }));
}
