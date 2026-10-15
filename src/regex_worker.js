// Worker for user-supplied document regexes. The parent terminates this worker
// on timeout; RegExp backtracking cannot be interrupted on the main thread.
import { parentPort, workerData } from 'node:worker_threads';

try {
  if (workerData.mode === 'test') {
    // Line-test mode (fs.search): which texts match at all — spans not needed,
    // and zero-width patterns are legitimate here (no 'g' flag, no exec loop).
    const re = new RegExp(workerData.pattern, workerData.flags || 'i');
    const hits = [];
    for (let i = 0; i < workerData.texts.length; i++) if (re.test(workerData.texts[i])) hits.push(i);
    parentPort.postMessage({ ok: true, hits });
  } else {
  // count is GLOBAL across the document: 'first' means the first occurrence
  // overall, not the first in every paragraph. Paragraphs are processed in
  // document order, so a shared remaining-budget preserves that ordering.
  let remaining = workerData.count;
  const matches = workerData.texts.map((text) => {
    // Fresh instance per paragraph: regex engines may reuse state or optimization
    // decisions across strings, changing pathological matching behavior.
    const re = new RegExp(workerData.pattern, 'g');
    const out = [];
    let m;
    while (out.length < remaining && (m = re.exec(text))) {
      if (m[0] === '') throw new Error('replace_text regex must consume at least one character');
      out.push([m.index, m.index + m[0].length]);
    }
    remaining -= out.length;
    return out;
  });
  parentPort.postMessage({ ok: true, matches });
  }
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
