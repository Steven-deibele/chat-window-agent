// Persistent memory across sessions (OptChat-inspired, simplified):
//   memory/memory.md     — the bounded "memory view", maintained by the AI via
//                          the memory.update tool (durable facts, decisions,
//                          preferences, project state). Injected into every new
//                          session's preamble.
//   memory/journal.jsonl — append-only log of every user request, agent final
//                          summary, and compress handoff — the "originals" the
//                          AI can look up with fs.search/fs.read when the view
//                          isn't detailed enough.
// Disable with WH_MEMORY=off; relocate with WH_MEMORY_DIR.
import fs from 'node:fs';
import path from 'node:path';

const VIEW_CAP = 6000;   // chars of memory.md injected into the preamble
const WRITE_CAP = 8000;  // max size memory.update may write
const ENTRY_CAP = 4000;  // per journal entry

export function memoryEnabled() {
  return process.env.WH_MEMORY !== 'off';
}

export function memoryDir() {
  return process.env.WH_MEMORY_DIR || path.resolve('memory');
}

/** The bounded memory view for preambles ('' when empty/disabled). */
export function loadMemoryView() {
  if (!memoryEnabled()) return '';
  try {
    return fs.readFileSync(path.join(memoryDir(), 'memory.md'), 'utf8').trim().slice(0, VIEW_CAP);
  } catch { return ''; }
}

/** Replace the memory view (memory.update tool). */
export function writeMemory(text) {
  if (!memoryEnabled()) throw new Error('memory is disabled (WH_MEMORY=off)');
  fs.mkdirSync(memoryDir(), { recursive: true });
  fs.writeFileSync(path.join(memoryDir(), 'memory.md'), String(text).slice(0, WRITE_CAP) + '\n');
}

/** Append to the session journal. Best effort — never breaks a session. */
export function appendJournal(role, text) {
  if (!memoryEnabled() || !text) return;
  try {
    fs.mkdirSync(memoryDir(), { recursive: true });
    const entry = { ts: new Date().toISOString(), role, text: String(text).slice(0, ENTRY_CAP) };
    fs.appendFileSync(path.join(memoryDir(), 'journal.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* journaling is best effort */ }
}
