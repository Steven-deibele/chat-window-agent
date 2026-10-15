// Small shared helpers.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Race a promise against a deadline so a stalled call (CDP, local inference)
 *  fails loudly instead of freezing the session forever. The timer is cleared
 *  as soon as the real work settles. NOTE: this does not cancel the underlying
 *  work — the promise keeps running; only the waiter stops waiting.
 *  NOTE: the timer is intentionally ref'd (no unref): it must keep the process
 *  alive long enough to deliver the stall error even when the underlying work
 *  holds no event-loop handles (e.g. a never-settling promise). */
export function bounded(p, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} stalled (${ms / 1000}s)`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Run a worker_threads worker and settle exactly once, then terminate it so a
 *  snippet/timer it left behind cannot pin the event loop.
 *
 *  The worker posts zero or more streaming messages plus exactly one terminal
 *  message. `onMessage(m)` returns `undefined` to ignore a streaming message,
 *  or a value to settle with. `onTimeout`/`onError`/`onExit` produce the value
 *  to settle with when no terminal message arrives.
 *
 *  A worker 'exit' event is deferred one tick so a terminal message already in
 *  flight is delivered first — otherwise a fast, clean exit could race the
 *  message and turn success into a spurious "worker exited" error.
 *  @param {URL} entry  worker entry module URL
 *  @param {object} workerData
 *  @returns {Promise<*>} the value produced by whichever handler settled first */
export async function runWorker(entry, workerData, { timeoutMs, onMessage, onTimeout, onError, onExit }) {
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(entry, { workerData });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    // settle exactly once; a handler that throws must reject the promise rather
    // than escape the event handler and leave this promise pending forever
    const settle = (produce) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      let value;
      try { value = produce(); } catch (e) { reject(e); return; }
      resolve(value);
    };
    timer = setTimeout(() => settle(onTimeout), timeoutMs);
    worker.on('message', (m) => {
      if (settled) return;
      let value;
      try { value = onMessage(m); }
      // the throw happens inside settle's producer, so settle's own try/catch
      // turns it into a rejection instead of escaping the event handler
      catch (e) { settle(() => { throw e; }); return; }
      if (value !== undefined) settle(() => value);
    });
    worker.once('error', (e) => settle(() => onError(e)));
    worker.once('exit', (n) => setImmediate(() => settle(() => onExit(n))));
  });
}

/** Run a user-supplied regex in regex_worker.js so a pathological pattern can
 *  be terminated (RegExp is synchronous; an in-process timer cannot stop
 *  catastrophic backtracking). Throws on bad pattern, worker error, or
 *  timeout. See src/regex_worker.js for the workerData protocol. */
export async function runRegexWorker(workerData, timeoutMs = 5000) {
  const r = await runWorker(
    new URL('./regex_worker.js', import.meta.url),
    workerData,
    {
      timeoutMs,
      // one timeout budget covers ALL texts: a slow-but-legitimate pattern on
      // large input can hit it too, so don't blame backtracking outright
      onMessage: (m) => (m.ok ? m : { error: new Error(m.error) }),
      onTimeout: () => ({ error: new Error(`regex timed out after ${timeoutMs / 1000}s (slow pattern or catastrophic backtracking)`) }),
      onError: (e) => ({ error: e }),
      onExit: (n) => ({ error: new Error(n === 0 ? 'regex worker exited before returning a result' : `regex worker exited with code ${n}`) }),
    },
  );
  if (r.error) throw r.error;
  return r;
}

/** Unique sibling temp path for atomic save: same volume as target, no PID reuse. */
export function atomicTempPath(target) {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
}

/** Flush a just-written temp file before replacing the user's document. */
export function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Best-effort directory flush after rename (no-op on Windows: Win32 has no
 *  directory-fsync equivalent and rename is atomic within a volume anyway). */
export function fsyncParent(target) {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(path.dirname(path.resolve(target)), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* durability is best-effort on platforms that allow directory fsync */ }
}

/** Async sibling of atomicWriteFileSync for large buffers (documents): the
 *  write/fsync/rename happen off the main thread so one save cannot stall the
 *  event loop (CDP callbacks, SSE streaming). */
export async function atomicWriteFile(target, data) {
  const tmp = atomicTempPath(target);
  let mode = null;
  try { mode = fs.statSync(target).mode; } catch { /* new file: default mode */ }
  try {
    await fs.promises.writeFile(tmp, data, mode !== null ? { mode } : undefined);
    const fh = await fs.promises.open(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    await fs.promises.rename(tmp, target);
    fsyncParent(target);
  } catch (e) {
    try { await fs.promises.rm(tmp, { force: true }); } catch { /* already gone */ }
    throw e;
  }
}

/** Write-then-rename so a failed save never corrupts the user's document.
 *  Preserves the original file mode when replacing an existing path.
 *  NOTE: ACLs/ownership are NOT preserved on replace — the temp file inherits
 *  the parent directory's (on Windows: the folder's DACL). Acceptable for
 *  user documents; don't use this for files with custom ACLs. */
export function atomicWriteFileSync(target, data) {
  const tmp = atomicTempPath(target);
  let mode = null;
  try { mode = fs.statSync(target).mode; } catch { /* new file: default mode */ }
  try {
    fs.writeFileSync(tmp, data, mode !== null ? { mode } : undefined);
    fsyncFile(tmp);
    fs.renameSync(tmp, target);
    fsyncParent(target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    throw e;
  }
}
