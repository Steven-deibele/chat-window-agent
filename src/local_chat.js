// Local GGUF backend: runs a model on this machine via node-llama-cpp
// (llama.cpp) instead of driving a browser chat window. LocalChat mirrors the
// AIChat interface used by the agent/edit loops (start, waitUntilReady, send,
// newChat, openInNewTab, stop) so the harness code is backend-agnostic.
//
// Model references:
//   path/to/file.gguf                  existing local file
//   hf:owner/repo:QUANT                Hugging Face, auto-downloaded to models/
//   hf:owner/repo/file.gguf            specific file in a repo
//   owner/repo:QUANT                   shorthand, hf: is added
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const MODELS_DIR = path.resolve('models');

const GB = 1024 ** 3;

/** Hardware facts relevant to model sizing. GPU/VRAM via node-llama-cpp
 *  (probing loads the llama backend — takes a couple of seconds). */
export async function systemSpecs({ probeGpu = true } = {}) {
  const specs = {
    cpuModel: os.cpus()[0]?.model || 'unknown CPU',
    cpuCores: os.cpus().length,
    totalRAM: os.totalmem(),
    freeRAM: os.freemem(),
    gpu: null,
    vram: null,
  };
  if (probeGpu) {
    try {
      const lib = await import('node-llama-cpp');
      const llama = await lib.getLlama({ logLevel: lib.LlamaLogLevel?.error }).catch(() => lib.getLlama());
      specs.gpu = llama.gpu || null;
      if (specs.gpu && typeof llama.getVramState === 'function') {
        const v = await llama.getVramState();
        specs.vram = { total: v.total, free: v.free };
      }
    } catch { /* no usable GPU backend — CPU-only recommendation */ }
  }
  return specs;
}

/** Recommended model size class for this machine. Budget = the .gguf FILE size
 *  that loads without hurting the system: on a real GPU, 85% of free VRAM;
 *  otherwise RAM headroom (min of 50% total / 75% currently free). A 15%
 *  runtime overhead (context/KV cache) is reserved on top. CPU-only machines
 *  are capped at the 8B class — bigger models fit in RAM but run unusably
 *  slowly. */
export function recommendModel(specs) {
  let budgetBytes, basis, cpuBound = false;
  if (specs.gpu && specs.vram && specs.vram.free > 2 * GB) {
    budgetBytes = specs.vram.free * 0.85;
    basis = `85% of free VRAM on ${specs.gpu}`;
  } else {
    budgetBytes = Math.min(specs.totalRAM * 0.5, specs.freeRAM * 0.75);
    basis = 'RAM headroom (min of 50% total / 75% currently free)';
    cpuBound = true;
  }
  budgetBytes /= 1.15;
  const tiers = [
    { fileGB: 0.4, label: '0.5B class (smoke tests only)', pull: 'hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:q4_k_m' },
    { fileGB: 1.1, label: '1.5B class (simple tasks)', pull: 'hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:q4_k_m' },
    { fileGB: 2.0, label: '3B class', pull: 'hf:Qwen/Qwen2.5-3B-Instruct-GGUF:q4_k_m' },
    { fileGB: 5.0, label: '7-8B class (good agent quality)', pull: 'hf:LiquidAI/LFM2.5-8B-GGUF:Q4_K_M' },
    { fileGB: 9.0, label: '14B class', pull: 'hf:Qwen/Qwen2.5-14B-Instruct-GGUF:q4_k_m' },
    { fileGB: 20.0, label: '32B class', pull: 'hf:Qwen/Qwen2.5-32B-Instruct-GGUF:q4_k_m' },
  ];
  let tier = null;
  for (const t of tiers) if (t.fileGB * GB <= budgetBytes) tier = t;
  if (!tier) return { budgetBytes, basis, cpuBound, tier: { ...tiers[0], tight: true } };
  const capped = cpuBound && tier.fileGB > 5.0;
  if (capped) tier = tiers.find((t) => t.fileGB === 5.0);
  return { budgetBytes, basis, cpuBound, capped, tier };
}
/** .gguf files already downloaded, with sizes. */
export function listLocalModels() {
  if (!fs.existsSync(MODELS_DIR)) return [];
  return fs.readdirSync(MODELS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.gguf'))
    .map((f) => {
      const st = fs.statSync(path.join(MODELS_DIR, f));
      return { file: path.join(MODELS_DIR, f), name: f, sizeMB: Math.round(st.size / 1048576) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Normalize a user model reference into something resolveModelFile accepts. */
export function normalizeModelRef(ref) {
  if (!ref) return null;
  if (fs.existsSync(ref)) return path.resolve(ref);
  if (/^hf:/i.test(ref)) return ref;
  if (/^[^\s/]+\/[^\s]+$/.test(ref)) return `hf:${ref}`; // owner/repo[:quant]
  return ref; // leave full URLs etc. to resolveModelFile
}

/** Resolve + (if needed) download the model, returning a local file path. */
export async function ensureLocalModel(ref, { log = () => {} } = {}) {
  const norm = normalizeModelRef(ref);
  if (!norm) throw new Error('no model configured — pass --model <ref>, set "model" on the "local" provider in providers.json, or run: run.bat models pull <hf:owner/repo:QUANT>');
  if (fs.existsSync(norm)) return norm;
  const { resolveModelFile } = await import('node-llama-cpp');
  log(`resolving model "${norm}" (downloads into ${MODELS_DIR} on first use)…`);
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  return resolveModelFile(norm, MODELS_DIR);
}

/** Interactive model picker: flag/provider value wins, else choose from
 *  downloaded models or enter a new hf: reference. */
export async function pickModelRef(pre, { promptLine, log = () => {} } = {}) {
  if (pre) return pre;
  const local = listLocalModels();
  if (!promptLine) {
    if (local.length === 1) return local[0].file;
    throw new Error('no model configured — pass --model <ref> or run: run.bat models pull <hf:owner/repo:QUANT>');
  }
  if (local.length) {
    console.log('  local models:');
    local.forEach((m, i) => console.log(`    ${i + 1}) ${m.name}  (${m.sizeMB} MB)`));
    console.log(`    ${local.length + 1}) download a new one (enter hf:owner/repo:QUANT)`);
    const pick = (await promptLine(`model (1-${local.length + 1})> `)).trim();
    const idx = +pick - 1;
    if (local[idx]) return local[idx].file;
  } else {
    log('no models downloaded yet — enter a Hugging Face reference, e.g. hf:LiquidAI/LFM2.5-8B-GGUF:Q4_K_M (or hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:q4_k_m for a small test model)');
  }
  const ref = (await promptLine('model ref (hf:owner/repo:QUANT or .gguf path)> ')).trim();
  if (!ref) throw new Error('no model selected');
  return ref;
}

/** In-process chat backed by a GGUF model. Duck-types AIChat for the harness. */
export class LocalChat {
  constructor(provider, opts = {}) {
    this.p = provider;
    this.modelRef = opts.modelRef || provider.model || process.env.WH_LOCAL_MODEL || null;
    this.timeoutMs = opts.timeoutMs || provider.replyTimeoutMs || 600000;
    this.log = opts.log || (() => {});
    this.isLocal = true;
    this._shared = opts.shared || null; // sub-agents share the loaded model
  }

  async start() {
    if (this._shared) return this; // sub-agent: model already loaded
    const modelPath = await ensureLocalModel(this.modelRef, { log: this.log });
    this.log(`loading ${path.basename(modelPath)} — first load takes a moment…`);
    const lib = await import('node-llama-cpp');
    // Try GPU first; if the model doesn't fit the (often tiny/shared) VRAM,
    // fall back to CPU automatically. WH_LOCAL_GPU=off skips the GPU attempt.
    const attempts = process.env.WH_LOCAL_GPU === 'off' ? [false] : [undefined, false];
    let lastErr = null;
    for (const gpu of attempts) {
      try {
        const opts = { logLevel: lib.LlamaLogLevel?.error };
        if (gpu === false) opts.gpu = false;
        const llama = await lib.getLlama(opts).catch(() => lib.getLlama(gpu === false ? { gpu: false } : undefined));
        const model = await llama.loadModel({ modelPath });
        const context = await model.createContext();
        this._shared = { lib, llama, model, context, owner: this };
        this._makeSession();
        this.log(`model ready on ${gpu === false ? 'CPU' : `GPU (${llama.gpu || 'auto'})`} (${path.basename(modelPath)})`);
        return this;
      } catch (e) {
        lastErr = e;
        if (gpu === undefined && /vram|too large|out of memory|no memory/i.test(e.message)) {
          this.log(`GPU load failed (${e.message}) — retrying on CPU…`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  _makeSession() {
    const { lib, context } = this._shared;
    const sequence = context.getSequence();
    this._sequence = sequence;
    this.session = new lib.LlamaChatSession({ contextSequence: sequence });
  }

  async waitUntilReady() { /* model is loaded in start() */ }

  bounded(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || 'local inference'} stalled (${ms / 1000}s)`)), ms)),
    ]);
  }

  /** Send a message, return the reply text. Same contract as AIChat.send. */
  async send(text) {
    const t0 = Date.now();
    try {
      const reply = await this.bounded(this.session.prompt(text), this.timeoutMs, 'local model reply');
      this.log(`local model replied in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return String(reply ?? '').trim();
    } catch (e) {
      if (/context|kv|sequence|token/i.test(e.message)) {
        throw new Error(`local model context overflow (${e.message}) — use /clear or /compress to reset, or a model with a larger context`);
      }
      throw e;
    }
  }

  /** Fresh conversation, model stays loaded (like AIChat.newChat). */
  async newChat() {
    try { this.session?.dispose?.(); } catch { /* older node-llama-cpp */ }
    try { this._sequence?.dispose?.(); } catch { /* sequence reuse is fine */ }
    this._makeSession();
  }

  /** Sub-agent: separate conversation (sequence) on the SAME loaded model.
   *  The harness closes sub.page when done — provide a shim that disposes
   *  the sub session instead of a browser tab. */
  async openInNewTab() {
    const sub = new LocalChat(this.p, { modelRef: this.modelRef, timeoutMs: this.timeoutMs, log: this.log, shared: this._shared });
    sub._makeSession();
    sub.page = { close: async () => { try { sub.session?.dispose?.(); } catch { /* already gone */ } try { sub._sequence?.dispose?.(); } catch { /* already gone */ } } };
    return sub;
  }

  async reattach() { return this; }

  stop() {
    if (!this._shared || this._shared.owner !== this) return; // subs don't own the model
    const s = this._shared;
    this._shared = null;
    (async () => {
      try { await s.context.dispose(); } catch { /* shutting down anyway */ }
      try { await s.model.dispose(); } catch { /* shutting down anyway */ }
    })();
  }
}
