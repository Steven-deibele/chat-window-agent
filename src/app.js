#!/usr/bin/env node
// chat-window-agent — edit Word/Excel files using a browser chat AI (no API needed).
//
// Modes:
//   edit <file>   [--against doc...]   interactive: you type requests, the AI returns JSON ops, they are applied.
//   fill <docx>   --against doc...     compliance mode: AI reviews source docs and fills the Word checklist.
//   doctor [--provider p]              diagnose browser connection + selectors.
//
// Common flags:
//   --provider chatgpt|claude|gemini|local|<custom>   (default chatgpt; interactive chooser otherwise)
//   --model <ref>      local provider model: hf:owner/repo:QUANT (auto-downloads) or .gguf path
//   --remote-provider <name>   browser provider the local agent consults via the remote.ask tool
//   --offload <level>  local model division of labor: off|low|normal|aggressive (default: provider's, usually normal)
//   --url <url>        override chat URL (tab matching follows this host)
//   --ask "..."        run one instruction non-interactive, then exit
//   --watch            you chat in the browser; the tool applies every AI reply
//   --against <file>   (repeatable) source documents fed to the AI as read-only evidence
//   --no-backup        skip timestamped backups (backups/ dir)
//   --max-retries N    feedback retries when the AI reply fails to parse/apply (default 3)
//   --timeout ms       reply wait timeout (default from provider)
//
// agent:     node src/app.js agent [files...] [--ask "goal"] [--yes] [--max-steps N]
//            autonomous tool loop; the AI can create new tools (tools/) mid-run.
// calibrate: node src/app.js calibrate --provider <custom>
//            watch one exchange in a custom/company chat UI and auto-detect its
//            selectors (saved to providers.json). For corporate chat windows.
// models:    node src/app.js models [list|pull <ref>|use <ref>|rm <name>]
//            manage local GGUF models (models/ dir) for --provider local.
import path from 'node:path';
import { buildPreamble, buildAgentPreamble, OFFLOAD_LEVELS } from './prompts.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProviders } from './providers.js';
import { AIChat, ensureChrome } from './ai_browser.js';
import { snapshotFile, kindOf } from './reader.js';
import { applyOps, validateOps } from './ops.js';

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m', B: '\x1b[1m' };

function parseArgs(argv) {
  const a = { _: [], against: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--provider') a.provider = argv[++i];
    else if (t === '--url') a.url = argv[++i];
    else if (t === '--ask') a.ask = argv[++i];
    else if (t === '--against' || t === '--with') a.against.push(argv[++i]);
    else if (t === '--watch') a.watch = true;
    else if (t === '--no-backup') a.noBackup = true;
    else if (t === '--max-retries') a.maxRetries = +argv[++i];
    else if (t === '--yes' || t === '-y') a.yes = true;
    else if (t === '--max-steps') a.maxSteps = +argv[++i];
    else if (t === '--timeout') a.timeout = +argv[++i];
    else if (t === '--profile') a.profile = argv[++i];
    else if (t === '--plain') a.plain = true;
    else if (t === '--model') a.model = argv[++i];
    else if (t === '--remote-provider') a.remoteProvider = argv[++i];
    else if (t === '--offload') a.offload = argv[++i];
    else if (t === '--simple') a.simple = true;
    else if (t === '--with-local') a.withLocal = true;
    else if (t === '--delay') a.delay = +argv[++i];
    else if (t === '--pause') a.pause = true;
    else if (t.startsWith('--')) throw new Error(`unknown flag ${t}`);
    else a._.push(t);
  }
  return a;
}

/** Create the chat backend for a provider: browser-driven (AIChat) or a local
 *  GGUF model (LocalChat, provider "local"). Both expose the same
 *  start/waitUntilReady/send/newChat/openInNewTab/stop surface. */
async function makeChat(provider, args, { promptLine } = {}) {
  if (!provider.local) {
    const chat = new AIChat(provider, { urlOverride: args.url, timeoutMs: args.timeout, log: (m) => console.log(`${C.d}${m}${C.x}`) });
    await chat.start({ profileDir: args.profile || defaultProfile() });
    return chat;
  }
  const { LocalChat, pickModelRef } = await import('./local_chat.js');
  const modelRef = await pickModelRef(args.model || provider.model, {
    promptLine: promptLine && process.stdin.isTTY ? promptLine : null,
    log: (m) => console.log(`${C.d}${m}${C.x}`),
  });
  const chat = new LocalChat(provider, { modelRef, timeoutMs: args.timeout, log: (m) => console.log(`${C.d}${m}${C.x}`) });
  await chat.start();
  return chat;
}


/** Let the user adjust chat settings (model, toggles) before the first message. */
async function preSendPause(args, provider) {
  const delay = args.delay ?? provider?.delay;
  if (args.pause && process.stdin.isTTY) {
    const { promptLine } = await import('./picker.js');
    await promptLine(`${C.y}Adjust the chat settings in Chrome, then press Enter to start...${C.x} `);
  } else if (delay > 0) {
    console.log(`${C.y}waiting ${delay}s before starting — adjust the chat settings in Chrome now...${C.x}`);
    await new Promise((r) => setTimeout(r, delay * 1000));
  }
}
/** Repair common LLM JSON breakage: raw newlines/tabs inside strings, smart
 *  quotes, missing closers, trailing commas. Returns parsed object or null. */
function parseLenientJson(raw) {
  let s = String(raw);
  // smart quotes -> straight
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // escape raw newlines/tabs/CR that appear INSIDE string literals
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') { out += '\\r'; continue; }
    if (inStr && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  s = out.replace(/,\s*([}\]])/g, '$1').trim();
  // balance missing closers using a proper stack
  const stack = [];
  inStr = false; esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') stack.pop();
  }
  const body = s.slice(s.indexOf('{'));
  if (!body.startsWith('{')) return null;
  const missing = stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
  try { return JSON.parse(body + missing); } catch { return null; }
}

function extractJson(text) {
  const dbg = process.env.WH_DEBUG;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const candidates = fences.map((m) => m[1]).reverse();
  // some chat renderers strip ``` fences and inject code-header/line-number rows
  // ("json" / "1" / "2"…). Strip those before trying the whole text.
  const deGuttered = text
    .split('\n')
    .filter((l) => !/^\s*\d+\s*$/.test(l) && !/^(json|javascript|js|text)$/i.test(l.trim()) && !/^thinking( completed)?$/i.test(l.trim()))
    .join('\n');
  candidates.push(deGuttered, text);
  for (const c of candidates) {
    const cleaned = c.replace(/,\s*([}\]])/g, '$1').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0) continue;
    const slice = end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === 'object') return obj;
    } catch { /* strict parse failed */ }
    const repaired = parseLenientJson(slice);
    if (repaired && typeof repaired === 'object') { if (dbg) console.error('extractJson: repaired a malformed block'); return repaired; }
    if (dbg) console.error('extractJson candidate fail:', JSON.stringify(cleaned.slice(0, 80)));
  }
  return null;
}

function printResult(res) {
  for (const line of res.applied) console.log(`${C.g}  applied ${line}${C.x}`);
  for (const line of res.errors) console.log(`${C.r}  failed  ${line}${C.x}`);
  if (res.backup) console.log(`${C.d}  backup: ${res.backup}${C.x}`);
}

/** chat.send with one retry that re-resolves the tab (CDP tabs go stale
 *  after navigations/reloads: "interrupted", "Target closed", ...). */
async function sendReliable(chat, text) {
  try {
    return await chat.send(text);
  } catch (e) {
    chat.page = await chat.reattach();
    return await chat.send(text);
  }
}

class Session {
  constructor({ chat, file, kind, maxRetries = 3, makeBackup = true }) {
    this.chat = chat; this.file = file; this.kind = kind;
    this.maxRetries = maxRetries; this.makeBackup = makeBackup;
    this.dirty = false;
  }

  /** Handle one AI reply: parse JSON, apply ops, run feedback retry loop. */
  async handleReply(replyText) {
    let text = replyText;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const parsed = extractJson(text);
      if (!parsed || !Array.isArray(parsed.ops)) {
        const looksLikeJson = /```|"ops"\s*:/.test(text);
        if (!looksLikeJson) {
          console.log(`\n${C.b}${C.B}AI:${C.x}\n${text.trim()}`);
          return;
        }
        if (attempt === this.maxRetries) {
          console.log(`${C.r}  could not parse a json block from the AI after ${this.maxRetries + 1} replies.${C.x}`);
          console.log(text.trim());
          return;
        }
        console.log(`${C.y}  parse error: reply did not contain a valid {"ops":[...]} json block${C.x}`);
        text = await sendReliable(this.chat, `TOOL FEEDBACK (automated): your reply could not be parsed as JSON. Reply again with ONE corrected \`\`\`json block: {"ops":[...],"notes":"..."} — strict JSON, double quotes, no trailing commas, nothing outside the block.`);
        continue;
      }
      const schemaErr = validateOps(parsed.ops, this.kind);
      if (schemaErr) {
        console.log(`${C.y}  invalid ops: ${schemaErr}${C.x}`);
        text = await sendReliable(this.chat, `TOOL FEEDBACK (automated): your ops were rejected: ${schemaErr}. Reply again with the corrected json block only.`);
        continue;
      }
      if (!parsed.ops.length) {
        console.log(`${C.b}AI: no changes. ${parsed.notes || ''}${C.x}`);
        return;
      }
      const res = await applyOps(this.file, parsed.ops, { makeBackup: this.makeBackup && !this.dirty });
      this.dirty = this.dirty || res.applied.length > 0;
      printResult(res);
      if (parsed.notes) console.log(`${C.d}  notes: ${parsed.notes}${C.x}`);
      if (res.errors.length && attempt < this.maxRetries) {
        text = await sendReliable(this.chat, `TOOL FEEDBACK (automated): some ops failed:\n${res.errors.join('\n')}\nReply with a corrected json block for the failed operations only.`);
        continue;
      }
      return;
    }
    console.log(`${C.r}giving up after ${this.maxRetries + 1} attempts; last AI reply not applied.${C.x}`);
  }
}

/** Autonomous agent: tool loop through the chat. */
async function runAgent(args, providers, providerName) {
  const { registry, sysInfo } = await import('./tools/registry.js');
  registry.loadUserTools((m) => console.log(`${C.y}${m}${C.x}`));
  let envBlock = '';
  try { envBlock = JSON.stringify(sysInfo(), null, 2); } catch { envBlock = 'unavailable'; }
  const manifest = await registry.manifest();
  const { promptLine } = await import('./picker.js');

  const files = args._.slice(0, 4).map((f) => path.resolve(f));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
  const fileSnapshots = [];
  for (const f of files) {
    const s = await snapshotFile(f, { maxChars: 8000 });
    fileSnapshots.push(`FILE ${f} (${s.kind}):\n${s.text}`);
  }

  const provider = providers[providerName];
  if (args.watch && provider.local) throw new Error('--watch drives a browser chat window; the local provider has none. Use the agent> REPL or --ask instead.');
  const offload = args.offload || provider.offload || 'off';
  if (!OFFLOAD_LEVELS.includes(offload)) throw new Error(`bad --offload "${offload}" (have: ${OFFLOAD_LEVELS.join('|')})`);
  const remoteChats = new Map(); // remote.ask sessions: name -> { chat, ownConnection }
  let localSidecar = null; // --with-local: GGUF model running alongside the browser chat
  const chat = await makeChat(provider, args, { promptLine });
  try {
    await chat.waitUntilReady();
    await preSendPause(args, provider);
    const confirm = async (what) => {
      if (args.yes) return true;
      const a = (await promptLine(`${C.y}allow ${what}? [y/N]> ${C.x}`)).trim().toLowerCase();
      return a.startsWith('y');
    };
    const ctx = { log: (m) => console.log(`${C.d}${m}${C.x}`), confirm, cwd: process.cwd() };

    // remote.ask tool: lets the (usually local) agent consult a big cloud AI in
    // a browser chat window. Lazily opens one session per provider, reuses it.
    ctx.askRemote = async (question, name) => {
      const remoteName = name || args.remoteProvider || (provider.local ? 'chatgpt' : providerName);
      const prov = providers[remoteName];
      if (!prov || prov.local) throw new Error(`remote.ask needs a browser chat provider (have: ${Object.keys(providers).filter((n) => !providers[n].local).join(', ')})`);
      let rc = remoteChats.get(remoteName);
      if (!rc) {
        if (remoteName === providerName && !provider.local) {
          rc = { chat: await chat.openInNewTab(), ownConnection: false }; // sibling tab on the same site
        } else {
          const c = new AIChat(prov, { timeoutMs: args.timeout, log: (m) => console.log(`${C.d}[remote ${remoteName}] ${m}${C.x}`) });
          await c.start({ profileDir: args.profile || defaultProfile() });
          rc = { chat: c, ownConnection: true };
        }
        await rc.chat.waitUntilReady();
        remoteChats.set(remoteName, rc);
        console.log(`${C.d}remote.ask: opened a ${prov.label || remoteName} chat${C.x}`);
        // Prime the remote chat like a person would, once: then every
        // remote.ask is just a plain conversational message.
        await sendReliable(rc.chat, "Hi! Quick heads-up: I work with a small local AI that handles tasks on my computer. When it gets stuck, I'll paste its question here — please answer the way you'd answer a colleague: natural, concise, plain text. No JSON, no special formatting, no protocol — just a helpful human-style reply.");
      }
      return sendReliable(rc.chat, String(question));
    };

    // local.ask tool: with --with-local, a GGUF model runs on this machine
    // alongside the browser chat so the big AI can hand it on-machine work
    // (summaries, extraction, drafting) — nothing leaves the computer.
    if (args.withLocal && !provider.local) {
      const { LocalChat, pickModelRef } = await import('./local_chat.js');
      const modelRef = await pickModelRef(args.model || providers.local?.model, {
        promptLine: process.stdin.isTTY ? promptLine : null,
        log: (m) => console.log(`${C.d}${m}${C.x}`),
      });
      localSidecar = new LocalChat(providers.local || { label: 'local' }, { modelRef, timeoutMs: args.timeout, log: (m) => console.log(`${C.d}[local] ${m}${C.x}`) });
      await localSidecar.start();
      ctx.askLocal = async (question) => localSidecar.send(String(question));
      console.log(`${C.d}local.ask: local model ready (${modelRef}) — the chat-window AI can consult it${C.x}`);
    }
    const maxSteps = args.maxSteps ?? 40;
    const sessionCtx = { fileSnapshots, pending: [] };

    // Session-size tracking for auto-compression: long sessions hit the chat's
    // context limit and bloat the DOM that reply-detection probes.
    let sessionChars = 0;
    const rawSend = chat.send.bind(chat);
    chat.send = async (text) => {
      sessionChars += text.length;
      const r = await rawSend(text);
      sessionChars += (r || '').length;
      return r;
    };
    const compressAt = +(process.env.WH_COMPRESS_AT || (provider.local ? 16000 : 100000)); // local models have far smaller context windows

    let lastTurnProtocol = false; // did the last turn follow the json protocol at all?
    const { loadMemoryView, appendJournal } = await import('./memory.js');
    // Persistent memory: bounded view re-read on every (re)start, so a compress
    // or a new run picks up whatever the AI saved via memory.update.
    const memNote = () => {
      const view = loadMemoryView();
      return view ? `PERSISTENT MEMORY (saved on this machine, survives sessions — keep it current with the memory.update tool; older detail is in memory/journal.jsonl, searchable with fs.search/fs.read):\n${view}` : '';
    };
    const preambleText = (note) =>
      [buildAgentPreamble({ manifest, fileSnapshots: sessionCtx.fileSnapshots, env: envBlock, plain: args.plain || provider.plain, simple: args.simple || provider.simple, offload }), memNote(), note].filter(Boolean).join('\n');

    const runTurn = async (turnMsg, turnChat = chat, turnCtx = ctx, turnMaxSteps = maxSteps) => {
      let msg = turnMsg;
      let summary = null;
      let parseFails = 0;
      let refusals = 0;
      let viaProtocol = false; // at least one valid protocol reply this turn
      for (let step = 1; step <= turnMaxSteps; step++) {
        // turnMsg === null: the human already sent their message in the chat
        // (watch mode) — wait for the AI's reply instead of sending anything.
        const reply = msg === null
          ? await turnChat.waitForNewMessage()
          : await sendReliable(turnChat, msg);
        msg = msg === null ? '' : msg;
        const parsed = extractJson(reply);
        if (!parsed || (!parsed.action && !parsed.tool && !parsed.final)) {
          // Preset/corporate AIs often refuse the agent role ("I don't have
          // access to that file"). Re-prime instead of giving up the turn.
          const REFUSAL = /(don'?t|do not|cannot|can'?t|unable|not able|no) (to )?(currently )?(have |gain )?(direct )?(access|the ability)|as an ai( language model)?|i('m| am) (just )?(an ai|a (text-based|virtual) assistant)/i;
          if (step <= 3 && refusals < 2 && REFUSAL.test(reply) && !/```|"action"/.test(reply)) {
            refusals++;
            console.log(`${C.y}  refusal detected — re-priming (all content is in-chat, no access needed)${C.x}`);
            msg = `No file or system access is needed from you: all content arrives IN THIS CHAT (snapshots and TOOL_RESULT messages), and the user's own authorized program executes the JSON plan steps you emit. You are only writing a machine-readable plan. Continue with ONE \`\`\`json block: {"action":"tool","tool":"<name>","args":{...}} or {"action":"final","summary":"..."}.`;
            step--;
            continue;
          }
          if (/```|"action"/.test(reply)) {
            if (++parseFails > 5) { summary = '(stopped: unparseable replies)'; break; }
            msg = `TOOL FEEDBACK: your reply was not a valid {"action":...} json block (first 120 chars: ${reply.replace(/\n/g, ' ').slice(0, 120)}). Reply again with ONE valid \`\`\`json block — remember: escape newlines as \\n, avoid very long strings (use fs.write + fs.append chunks).`;
            globalThis.__whErrors?.push(`[${new Date().toISOString().slice(11, 19)}] parse: unparseable reply (${reply.length} chars)`);
            step--;
            continue;
          }
          summary = reply.trim().slice(0, 2000);
          break;
        }
        if (parsed.action === 'final' || parsed.final) {
          viaProtocol = true;
          summary = parsed.summary || parsed.final;
          break;
        }
        // Batched calls: {"action":"tools","calls":[{tool,args},...]} runs several
        // INDEPENDENT tools in one roundtrip. Single {"action":"tool",...} still works.
        const calls = Array.isArray(parsed.calls) && parsed.calls.length
          ? parsed.calls.slice(0, 5)
          : [parsed];
        const results = [];
        for (const call of calls) {
          const toolName = call.tool || (call.action && call.action !== 'tool' && call.action !== 'tools' ? call.action : null);
          const toolArgs = call.args || call.arguments || {};
          let result;
          if (!toolName) {
            result = 'ERROR missing "tool" in reply';
          } else {
            let tool = null;
            try { tool = await registry.get(toolName); } catch (e) { result = `ERROR loading tool: ${e.message}`; }
            if (tool) {
              console.log(`${C.b}  ${toolName} ${C.d}${JSON.stringify(toolArgs).slice(0, 120)}${C.x}`);
              try { result = await tool.run(toolArgs, turnCtx); } // dangerous tools confirm themselves via ctx.confirm (with full detail)
              catch (e) { result = `ERROR ${e.message}`; }
            }
            else if (!result) result = `ERROR unknown tool "${toolName}" — call tools.list, or create it with tools.create`;
          }
          if (typeof result === 'string' && result.startsWith('ERROR')) globalThis.__whErrors?.push(`[${new Date().toISOString().slice(11, 19)}] tool ${toolName}: ${result.slice(0, 200)}`);
          const resStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          console.log(`${C.d}  -> ${resStr.slice(0, 200).replace(/\n/g, ' ')}${C.x}`);
          results.push(`${toolName || '?'}: ${resStr}`);
        }
        const combined = results.join('\n');
        viaProtocol = true;
        const sticky = (args.plain || args.simple || provider.plain || provider.simple)
          ? '\nPROTOCOL REMINDER: reply with ONE ```json block ONLY — {"action":"tool","tool":"NAME","args":{...}} or {"action":"final","summary":"..."}. No prose, no explanations, nothing after the block.'
          : '';
        msg = `TOOL_RESULT${results.length > 1 ? `S (${results.length} calls)` : ''} ${combined.slice(0, 6000)}\nContinue: next {"action":"tool",...} step, or {"action":"final",...}.${step === turnMaxSteps - 1 ? ' (One step left — reply with final next.)' : ''}${sticky}`;
      }
      if (summary === null) {
        const reply = await sendReliable(turnChat, 'TOOL_BUDGET exhausted — reply with {"action":"final","summary":...} now.');
        const parsed = extractJson(reply);
        summary = parsed?.summary || parsed?.final || reply.trim().slice(0, 500);
      }
      lastTurnProtocol = viaProtocol;
      return summary;
    };

    /** Sub-agents: each task runs the SAME tool loop in a NEW browser tab with a
     *  fresh chat (agent.spawn tool calls this). Parallel-safe: CDP input is
     *  per-target, so concurrent tabs don't steal each other's focus. */
    let subSeq = 0;
    ctx.spawnSubAgent = async (task) => {
      const id = ++subSeq;
      const sub = await chat.openInNewTab();
      const subCtx = {
        ...ctx,
        log: (m) => console.log(`${C.d}[sub ${id}] ${m}${C.x}`),
        spawnSubAgent: async () => { throw new Error('sub-agents cannot spawn further sub-agents — do the work directly'); },
      };
      sub.log = subCtx.log;
      try {
        console.log(`${C.b}[sub ${id}]${C.x} ${C.d}new tab — subtask: ${String(task).slice(0, 120)}${C.x}`);
        const subPreamble = buildAgentPreamble({
          manifest, fileSnapshots: [], env: envBlock, plain: args.plain || provider.plain, simple: args.simple || provider.simple, offload,
          contexts: ['SUB-AGENT ROLE: you were spawned by the parent agent to do ONE subtask in this fresh chat. Complete the SUBTASK below using tools, then reply {"action":"final","summary":...} with everything the parent needs. You cannot spawn further sub-agents.'],
        });
        const summary = await runTurn(`${subPreamble}\nSUBTASK: ${task}`, sub, subCtx, Math.min(maxSteps, 15));
        console.log(`${C.g}[sub ${id}] done:${C.x} ${C.d}${String(summary).slice(0, 200).replace(/\n/g, ' ')}${C.x}`);
        return summary;
      } finally {
        try { await sub.page.close(); } catch { /* tab already gone */ }
      }
    };

    /** /clear and /compress: start a fresh chat (drops old context + DOM).
     *  withSummary: first ask the AI for a compact handoff, then seed the new
     *  chat with preamble + summary so work continues seamlessly. */
    const resetSession = async ({ withSummary }) => {
      let summary = '';
      if (withSummary) {
        console.log(`${C.d}compressing: asking the AI for a session summary first…${C.x}`);
        try {
          summary = await runTurn('CONTEXT MANAGEMENT (not a user task): this chat is near its context limit. Reply with {"action":"final","summary":"<compact handoff: user goals, decisions made, files created/edited with full paths, key tool results, pending tasks>"} — max 400 words, no tool calls unless essential.');
          if (!summary || summary === '(stopped: unparseable replies)') summary = '';
        } catch (e) {
          console.log(`${C.y}summary step failed: ${e.message} — starting fresh without it${C.x}`);
          summary = '';
        }
      }
      if (summary) appendJournal('compress', summary);
      console.log(`${C.d}starting a new chat${summary ? ' seeded with the session summary' : ' (previous context dropped)'}…${C.x}`);
      await chat.newChat();
      sessionChars = 0;
      const note = summary
        ? `PREVIOUS SESSION SUMMARY (the chat was compressed to stay under the context limit — continue seamlessly from it):\n${summary.slice(0, 6000)}`
        : null;
      const ack = await runTurn(preambleText(note) + '\nAcknowledge with {"action":"final","summary":"context restored"} and wait for the next request.');
      console.log(`${C.g}new chat ready.${C.x} ${C.d}AI:${C.x} ${String(ack).slice(0, 160)}`);
    };

    const goalSummary = await runTurn(preambleText(args.ask
      ? `GOAL: ${args.ask}\nStart on the GOAL immediately with tool steps (acknowledge by acting, not by replying "ready"); end with {"action":"final","summary":...} once the goal is achieved.`
      : "Awaiting the user's first request; the next message will contain it." + '\nFirst, acknowledge the protocol with {"action":"final","summary":"ready"}.'));
    if (!lastTurnProtocol) {
      console.log(`${C.y}${C.B}WARNING: this chat did not follow the json protocol on the first exchange.${C.x}`);
      console.log(`${C.y}Its system prompt is likely overriding the harness. Things that help:${C.x}`);
      console.log(`${C.y}  1. pick a different model / turn off custom personas in the chat settings (use --delay or --pause)${C.x}`);
      console.log(`${C.y}  2. put the protocol in the chat's custom-instructions/system field if it has one${C.x}`);
      console.log(`${C.y}  3. enable neutral framing + simple protocol: run.bat config <provider>  (plain=y simple=y)${C.x}`);
      console.log(`${C.y}Continuing anyway — watch the first tool steps closely.${C.x}`);
    }
    if (args.ask) {
      appendJournal('user', args.ask);
      appendJournal('agent', goalSummary);
      console.log(`\n${C.g}${C.B}DONE:${C.x} ${goalSummary}`);
      return;
    }
    if (args.watch) {
      console.log(`\n${C.B}agent watch mode${C.x} — type your requests directly in the chat window; I run the tools and post results there. Ctrl+C here to stop.`);
      const origSend = chat.send.bind(chat);
      let ownSends = 0; // baselineUser was captured AFTER the preamble — don't double-count it
      chat.send = async (text) => { ownSends++; return origSend(text); };
      const baselineUser = await chat.userCount();
      for (;;) {
        let human;
        try { human = await chat.waitForHumanMessage(baselineUser, () => ownSends); }
        catch (e) { console.log(`${C.y}${e.message}${C.x}`); break; }
        console.log(`\n${C.b}${C.B}you (chat):${C.x} ${human.slice(0, 200)}`);
        try {
          const summary = await runTurn(null);
          appendJournal('user', human);
          appendJournal('agent', summary);
          console.log(`${C.b}${C.B}agent:${C.x} ${summary}${C.x}`);
        } catch (e) {
          console.log(`${C.r}turn failed: ${e.message}${C.x} — still watching`);
        }
      }
      return;
    }
    console.log(`\n${C.B}agent ready${C.x} ${C.d}— /tools to list, /file <path> to attach, /memory to see persistent memory, /compress to summarize+restart the chat, /clear to start fresh, exit to quit${C.x}`);
    for (;;) {
      const line = (await promptLine(`${C.g}agent>${C.x} `).catch(() => null))?.trim();
      if (line === null || line === undefined) { console.log('\nbye (stdin closed)'); break; }
      if (!line) continue;
      if (line === 'exit' || line === 'quit') break;
      if (line === '/tools') { console.log(await registry.manifest()); continue; }
      if (line === '/memory') { console.log(loadMemoryView() || `${C.d}(empty — the AI fills this with the memory.update tool; also saved at memory/memory.md)${C.x}`); continue; }
      if (line.startsWith('/file ')) {
        const p = path.resolve(line.slice(6).trim());
        if (!fs.existsSync(p)) { console.log(`${C.r}not found: ${p}${C.x}`); continue; }
        const s = await snapshotFile(p, { maxChars: 8000 });
        sessionCtx.fileSnapshots.push(`FILE ${p} (${s.kind}):\n${s.text}`);
        sessionCtx.pending.push(`ATTACHED FILE ${p} (${s.kind}) snapshot:\n${s.text}`);
        console.log(`${C.g}attached ${p}${C.x}`);
        continue;
      }
      if (line === '/clear' || line === '/compress') {
        try { await resetSession({ withSummary: line === '/compress' }); }
        catch (e) { console.log(`${C.r}${line} failed: ${e.message}${C.x}`); }
        continue;
      }
      if (sessionChars > compressAt) {
        console.log(`${C.y}session ~${Math.round(sessionChars / 1000)}k chars exceeds WH_COMPRESS_AT (${compressAt >= 1000 ? Math.round(compressAt / 1000) + 'k' : compressAt}) — auto-compressing…${C.x}`);
        try { await resetSession({ withSummary: true }); }
        catch (e) { console.log(`${C.r}auto-compress failed: ${e.message} ${C.d}(use /clear or /compress manually)${C.x}`); }
      }
      const extra = sessionCtx.pending.splice(0).join('\n\n');
      try {
        const summary = await runTurn(`USER REQUEST: ${line}${extra ? `\n\n${extra}` : ''}`);
        appendJournal('user', line);
        appendJournal('agent', summary);
        console.log(`\n${C.b}${C.B}agent:${C.x} ${summary}${C.x}`);
      } catch (e) {
        console.log(`${C.r}turn failed: ${e.message}${C.x} ${C.d}(the REPL is still alive — try again; run "doctor" if it keeps failing)${C.x}`);
      }
    }
    console.log('bye');
  } finally {
    for (const rc of remoteChats.values()) {
      try { await rc.chat.page?.close?.(); } catch { /* tab already gone */ }
      if (rc.ownConnection) { try { rc.chat.stop(); } catch { /* already disconnected */ } }
    }
    try { localSidecar?.stop(); } catch { /* model already disposed */ }
    chat.stop();
  }
}
/** Auto-detect selectors of a custom/company chat UI by watching one live exchange. */
async function runCalibrate(args, provider, providerName) {
  if (provider.local) throw new Error('calibrate watches a browser chat UI — the local provider has no DOM. Nothing to calibrate.');
  const chat = new AIChat(provider, { urlOverride: args.url, log: (m) => console.log(`${C.d}${m}${C.x}`) });
  await chat.start({ profileDir: args.profile || defaultProfile() });
  try {
    await chat.waitUntilReady();
    console.log(`\n${C.B}Calibrating ${provider.label || providerName}${C.x}`);
    console.log(`1. In the Chrome chat window, send any short message (e.g. "reply with the single word PONG").`);
    console.log(`2. Wait until the AI has fully answered.\n`);
    const before = await chat.evalAnywhere(() => document.body.innerText) || '';
    const beforeLines = new Set(before.split('\n').map((s) => s.trim()));
    let marker = null;
    for (let i = 0; i < 180 && !process.exitCode; i++) { // up to 3 min
      await new Promise((r) => setTimeout(r, 1000));
      const now = await chat.evalAnywhere(() => document.body.innerText) || '';
      const newLines = now.split('\n').map((s) => s.trim()).filter((l) => l.length > 8 && !beforeLines.has(l));
      if (newLines.length) {
        const longest = newLines.sort((a, b) => b.length - a.length)[0];
        if (longest === marker) break; // stable
        marker = longest;
      }
    }
    if (!marker) throw new Error('no new chat text detected — did you send a message in the chat window?');
    console.log(`detected reply text: "${marker.slice(0, 80)}"`);
    const found = await chat.evalAnywhere((needle) => {
      const matches = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const t = (el.innerText || '').trim();
        if (t.includes(needle) && t.length < needle.length + 2000) {
          let node = el;
          for (let up = 0; up < 7 && node; up++, node = node.parentElement) {
            const cands = [];
            if (node.id && /^[a-zA-Z][\w-]*$/.test(node.id)) cands.push(`#${node.id}`);
            const da = node.getAttributeNames ? node.getAttributeNames().find((a) => a.startsWith('data-') && node.getAttribute(a) && node.getAttribute(a).length < 60) : null;
            if (da) cands.push(`[${da}="${node.getAttribute(da)}"]`);
            if (node.getAttribute && node.getAttribute('role')) cands.push(`[role="${node.getAttribute('role')}"]`);
            const cls = (typeof node.className === 'string' ? node.className : '').split(/\s+/).filter((c) => /^[\w-]+$/.test(c));
            if (cls.length) cands.push(`${node.tagName.toLowerCase()}.${cls[0]}`);
            for (const c of cands) {
              try {
                const hits = document.querySelectorAll(c);
                if (hits.length >= 1 && hits.length <= 60 && [...hits].includes(node)) matches.push({ selector: c, count: hits.length });
              } catch {}
            }
          }
        }
      }
      return matches;
    }, marker).catch(() => null);
    if (!found || !found.length) throw new Error('could not derive a selector — set "assistant" manually in providers.json');
    const rank = (s) => (s.startsWith('[data-') ? 0 : s.startsWith('[role') ? 1 : /^[a-z]+\./i.test(s) ? 2 : 3); // data-attr > role > class > id (ids are often big containers)
    found.sort((a, b) => rank(a.selector) - rank(b.selector) || a.count - b.count);
    const best = found[0];
    console.log(`${C.g}assistant selector: ${best.selector} (matches ${best.count} element(s))${C.x}`);
    const file = path.resolve('providers.json');
    const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    cfg[providerName] = { ...(cfg[providerName] || provider), assistant: [best.selector] };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`${C.g}saved to ${file} — provider "${providerName}" is ready. Test with: node src/app.js doctor --provider ${providerName}${C.x}`);
  } finally {
    chat.stop();
  }
}
/** Rename a saved provider (providers.json). "rename <old> <new>" or bare
 *  "rename" for a guided pick. */
async function renameProvider(args) {
  const { DEFAULT_PROVIDERS } = await import('./providers.js');
  const file = path.resolve('providers.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let [oldName, rawNew] = args._;
  if (!oldName) {
    const saved = Object.keys(cfg);
    if (!saved.length) {
      console.log('no custom providers saved yet — create one with the Custom… entry in the provider menu');
      return;
    }
    const { promptLine } = await import('./picker.js');
    console.log('\nSaved providers:');
    saved.forEach((n, i) => console.log(`  ${i + 1}) ${n}  ${C.d}${cfg[n].label || ''}${C.x}`));
    const pick = (await promptLine(`rename which (1-${saved.length})> `)).trim();
    oldName = saved[+pick - 1];
    if (!oldName) { console.log('nothing selected'); return; }
  }
  if (!rawNew) {
    const { promptLine } = await import('./picker.js');
    rawNew = (await promptLine(`new name for "${oldName}"> `)).trim();
  }
  const newName = String(rawNew).toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^-+|-+$/g, '');
  if (!newName) throw new Error('invalid new name');
  if (!cfg[oldName]) {
    const saved = Object.keys(cfg).join(', ') || 'none';
    if (DEFAULT_PROVIDERS[oldName]) throw new Error(`"${oldName}" is a built-in provider — create a custom copy instead (Custom… in the menu)`);
    throw new Error(`no saved provider "${oldName}" in providers.json (saved: ${saved})`);
  }
  if (cfg[newName] || DEFAULT_PROVIDERS[newName]) throw new Error(`name "${newName}" is already taken`);
  cfg[newName] = cfg[oldName];
  const p = cfg[newName];
  p.label = p.label && p.label.startsWith(oldName) ? newName + p.label.slice(oldName.length) : (p.label || newName);
  delete cfg[oldName];
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\x1b[32mrenamed "${oldName}" -> "${newName}"${p.label ? ` (${p.label})` : ''} in ${file}\x1b[0m`);
  console.log(`use it with: --provider ${newName}`);
}

/** Adjust behavior settings (plain/simple/delay) of a saved provider.
 *  "config [name]" — bare "config" lists saved providers to pick from. */
async function configProvider(args) {
  const file = path.resolve('providers.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const saved = Object.keys(cfg);
  if (!saved.length) {
    console.log('no custom providers saved yet — create one with the Custom… entry in the provider menu');
    return;
  }
  const { promptLine } = await import('./picker.js');
  let [name] = args._;
  if (!name) {
    console.log('\nSaved providers:');
    saved.forEach((n, i) => console.log(`  ${i + 1}) ${n}  ${C.d}${cfg[n].label || ''}${C.x}`));
    const pick = (await promptLine(`configure which (1-${saved.length})> `)).trim();
    name = saved[+pick - 1];
    if (!name) { console.log('nothing selected'); return; }
  }
  const p = cfg[name];
  if (!p) throw new Error(`no saved provider "${name}" in providers.json (saved: ${saved.join(', ') || 'none'})`);
  const ask = async (label, cur) => {
    const a = (await promptLine(`${label} [${cur}]> `)).trim();
    return a === '' ? cur : a;
  };
  p.plain = /^y/i.test(await ask('plain framing — preset AI refuses agent roles (y/n)', p.plain ? 'y' : 'n'));
  p.simple = /^y/i.test(await ask('simple protocol — one tool per reply, for weaker models (y/n)', p.simple ? 'y' : 'n'));
  const delay = +(await ask('startup delay seconds (time to adjust chat settings)', String(p.delay || 0)));
  if (delay > 0) p.delay = delay; else delete p.delay;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`${C.g}saved "${name}": plain=${!!p.plain} simple=${!!p.simple} delay=${p.delay || 0}s${C.x}`);
  console.log(`${C.d}takes effect on the next run — no restart of this command needed${C.x}`);
}

/** Manage local GGUF models: `models` list, `models pull <ref>`,
 *  `models use <ref>` (persist default), `models rm <name>`. */
async function cmdModels(args) {
  const { listLocalModels, ensureLocalModel, MODELS_DIR } = await import('./local_chat.js');
  const sub = args._[0] || 'list';
  if (sub === 'list') {
    const local = listLocalModels();
    if (!local.length) console.log(`no models in ${MODELS_DIR} yet — download one, e.g.:\n  run.bat models pull hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:q4_k_m   (small test)\n  run.bat models pull hf:LiquidAI/LFM2.5-8B-GGUF:Q4_K_M              (full agent)`);
    for (const m of local) console.log(`  ${m.name}  (${m.sizeMB} MB)`);
    console.log(`active model: ${loadProviders().local?.model || process.env.WH_LOCAL_MODEL || '(pick at start, or --model <ref>)'}`);
    return;
  }
  if (sub === 'pull') {
    const ref = args._[1];
    if (!ref) throw new Error('usage: models pull <hf:owner/repo:QUANT>');
    const p = await ensureLocalModel(ref, { log: (m) => console.log(`${C.d}${m}${C.x}`) });
    console.log(`${C.g}ready: ${p}${C.x}`);
    return;
  }
  if (sub === 'use') {
    const ref = args._[1];
    if (!ref) throw new Error('usage: models use <hf:owner/repo:QUANT | path/to/file.gguf>');
    const file = path.resolve('providers.json');
    const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    cfg.local = { ...(cfg.local || {}), model: fs.existsSync(ref) ? path.resolve(ref) : ref };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`${C.g}default local model set to "${cfg.local.model}" in ${file}${C.x}`);
    return;
  }
  if (sub === 'rm') {
    const name = args._[1];
    const hit = listLocalModels().find((m) => m.name === name || m.file === path.resolve(name || ''));
    if (!hit) throw new Error(`no local model "${name}" (run "models list")`);
    fs.unlinkSync(hit.file);
    console.log(`${C.g}deleted ${hit.name}${C.x}`);
    return;
  }
  if (sub === 'recommend') {
    const { systemSpecs, recommendModel } = await import('./local_chat.js');
    const gb = (b) => (b / 1024 ** 3).toFixed(1);
    console.log(`${C.d}probing hardware (GPU check takes a few seconds)…${C.x}`);
    const specs = await systemSpecs();
    const rec = recommendModel(specs);
    console.log(`cpu:  ${specs.cpuModel} (${specs.cpuCores} cores)`);
    console.log(`ram:  ${gb(specs.totalRAM)} GB total, ${gb(specs.freeRAM)} GB free`);
    console.log(specs.gpu
      ? `gpu:  ${specs.gpu}${specs.vram ? ` — ${gb(specs.vram.total)} GB VRAM total, ${gb(specs.vram.free)} GB free` : ' (VRAM unknown)'}`
      : 'gpu:  none usable — CPU inference (slow for >3B models)');
    console.log(`safe budget: ${C.B}${gb(rec.budgetBytes)} GB${C.x} model file size  ${C.d}(${rec.basis}, +15% runtime overhead reserved)${C.x}`);
    console.log(`recommended: ${C.g}${rec.tier.label}${C.x}${rec.capped ? ` ${C.d}(capped: bigger fits your RAM but runs too slowly on CPU)${C.x}` : ''}${rec.tier.tight ? ` ${C.y}— even this is tight; close other apps or use a remote provider${C.x}` : ''}`);
    if (rec.tier.pull) console.log(`  run.bat models pull ${rec.tier.pull}`);
    for (const m of listLocalModels()) {
      const bytes = m.sizeMB * 1048576;
      const fit = bytes > rec.budgetBytes ? `${C.r}TOO BIG for this machine${C.x}` : bytes > rec.budgetBytes * 0.8 ? `${C.y}tight — expect slowdowns${C.x}` : `${C.g}fits${C.x}`;
      console.log(`  ${fit}  ${m.name} (${gb(bytes)} GB)`);
    }
    return;
  }
  throw new Error(`unknown models subcommand "${sub}" (list|pull|use|rm|recommend)`);
}

/** One-shot Q&A with a cloud AI chat window: no tools, no protocol — the cloud
 *  model is a smart colleague, not an agent. Everything sent passes through
 *  scrub.js so secrets/PII never leave the machine. Question comes from --ask
 *  or stdin; the reply is printed to stdout. Intended for harnesses (e.g. a
 *  local agent) that offload hard reasoning to a big model. */
async function runAsk(args, provider, providerName) {
  const { scrub, redactionSummary } = await import('./scrub.js');
  let question = args.ask;
  if (question == null && !process.stdin.isTTY) {
    question = fs.readFileSync(0, 'utf8');
  }
  if (!question || !String(question).trim()) throw new Error('ask needs a question: --ask "..." or piped stdin');
  const { text, redactions } = scrub(question, { log: (m) => console.error(`${C.y}${m}${C.x}`) });
  const summary = redactionSummary(redactions);
  if (summary) console.error(`${C.y}${summary}${C.x}`);

  const chat = await makeChat(provider, args, {});
  try {
    await chat.waitUntilReady();
    await preSendPause(args, provider);
    await sendReliable(chat, "Hi! Quick heads-up: I work with a small local AI that handles tasks on my computer. When it gets stuck, I'll paste its question here — please answer the way you'd answer a colleague: natural, concise, plain text. No JSON, no special formatting, no protocol — just a helpful human-style reply. Note: anything that looks like <TOKEN>, <EMAIL>, <USER> etc. was redacted locally for privacy — work around the placeholders.");
    const reply = await sendReliable(chat, text);
    process.stdout.write(String(reply).trim() + '\n');
  } finally {
    chat.stop?.();
  }
}

async function main() {


  const args = parseArgs(process.argv.slice(2));
  const command = args._.shift();
  if (command === 'help' || command === '--help') {
    console.log(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8').split('\n# Usage')[1]?.split('\n## ')[0] || 'see README.md');
    process.exit(0);
  }
  const cmd = !command || command === 'chat' ? 'agent' : command; // default: conversational agent
  if (cmd === 'gui') { const { startGui } = await import('./gui.js'); return startGui(); }
  if (cmd === 'models') return cmdModels(args);
  if (cmd === 'rename') return renameProvider(args);
  if (cmd === 'config') return configProvider(args);
  let providers = loadProviders();
  let providerName = args.provider;
  if (!providerName && (process.stdin.isTTY || process.env.WH_PROVIDER_MENU)) {
    const { promptLine } = await import('./picker.js');
    const names = Object.keys(providers);
    console.log(`\n${C.B}Which AI chat window should chat-window-agent drive?${C.x}`);
    names.forEach((n, i) => console.log(`  ${i + 1}) ${providers[n].label || n}  ${C.d}${providers[n].newChat || providers[n].model || 'pick a GGUF model at start'}${C.x}`));
    console.log(`  ${names.length + 1}) ${C.B}Custom…${C.x} ${C.d}use any AI chat URL (openrouter, poe, copilot, a local UI… )${C.x}`);
    const pick = await promptLine(`choice (1-${names.length + 1})> `);
    if (+pick === names.length + 1) {
      providerName = await createCustomProvider(promptLine);
    } else {
      const idx = +pick - 1;
      providerName = names[idx] || names[0];
    }
    console.log(`${C.g}using ${providerName}${C.x}`);
    providers = loadProviders(); // pick up a just-created custom provider
  }
  providerName = providerName || 'chatgpt';
  const provider = providers[providerName];
  if (!provider) throw new Error(`unknown provider "${providerName}" (have: ${Object.keys(providers).join(', ')})`);

  if (command === 'doctor') {
    if (provider.local) throw new Error('doctor diagnoses browser chat selectors — the local provider needs none. Test it with: run.bat agent --provider local --ask "hello"');
    await ensureChrome({ startUrl: args.url || provider.newChat, profileDir: args.profile || defaultProfile() });
    const chat = new AIChat(provider, { urlOverride: args.url });
    await chat.start({ profileDir: args.profile || defaultProfile() });
    const info = await chat.diagnose();
    console.log(`page: ${info.url || info.error}`);
    for (const [group, sels] of Object.entries(info)) {
      if (group === 'url' || !Array.isArray(sels)) continue;
      for (const s of sels) console.log(`  ${s.count > 0 ? C.g : C.r}${group.padEnd(10)} ${s.selector} -> ${s.count}${C.x}`);
    }
    chat.stop();
    return;
  }

  if (cmd === 'ask') {
    if (provider.local) throw new Error('ask consults a cloud AI chat window — the local provider makes no sense here. Use a browser provider (chatgpt|claude|gemini|<custom>).');
    return runAsk(args, provider, providerName);
  }
  if (cmd === 'agent') return runAgent(args, providers, providerName);
  if (cmd === 'calibrate') return runCalibrate(args, provider, providerName);
  if (cmd !== 'edit' && cmd !== 'fill') throw new Error(`unknown command "${cmd}" (ask|agent|edit|fill|calibrate|doctor|models|config|rename)`);
  const { pickFile, pickFiles, expandEvidence, promptLine } = await import('./picker.js');

  let file = args._[0];
  if (!file) {
    console.log(`${C.d}no file given — opening file picker...${C.x}`);
    file = await pickFile(command === 'fill' ? ['docx'] : ['docx', 'xlsx', 'xlsm'], {
      title: command === 'fill' ? 'Select the compliance checklist (.docx)' : 'Select the file to edit',
    });
    if (!file) process.exit(1);
    console.log(`${C.g}selected: ${file}${C.x}`);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const kind = kindOf(abs);
  if (command === 'fill' && kind !== 'docx') throw new Error('fill expects a .docx checklist');

  let against = args.against;
  if (command === 'fill' && !against.length) {
    console.log(`${C.d}no evidence given — select the documents to review (or "all")...${C.x}`);
    const picks = await pickFiles(['docx', 'xlsx', 'xlsm', 'pdf', 'csv', 'txt', 'md'], {
      title: 'Select evidence documents for the compliance review', multi: true,
    });
    if (!picks?.length) { console.log('fill needs at least one evidence document (or pass --against).'); process.exit(1); }
    against = picks;
  }
  const sources = [];
  for (const s of expandEvidence(against, abs)) {
    const sub = await snapshotFile(s, { maxChars: 12000 });
    sources.push({ name: path.basename(s), kind: sub.kind, text: sub.text });
  }
  const snap = await snapshotFile(abs);

  const preamble = buildPreamble({
    mode: command, file: path.basename(abs), kind, snapshot: snap.text, sources,
    plain: args.plain || provider.plain,
  });

  console.log(`${C.d}provider ${providerName} | file ${abs} | kind ${kind}${sources.length ? ` | sources: ${sources.map((s) => s.name).join(', ')}` : ''}${C.x}`);
  if (args.watch && provider.local) throw new Error('--watch drives a browser chat window; the local provider has none. Type requests in this terminal instead.');
  const chat = await makeChat(provider, args, { promptLine });
  const session = new Session({ chat, file: abs, kind, maxRetries: args.maxRetries ?? 3, makeBackup: !args.noBackup });

  try {
    await chat.waitUntilReady();
    await preSendPause(args, provider);
    if (args.watch) {
      console.log(`${C.d}seeding context into the chat...${C.x}`);
      let first = null;
      for (let attempt = 1; attempt <= 3 && first === null; attempt++) {
        try {
          first = await chat.send(preamble);
        } catch (e) {
          console.log(`${C.y}seed attempt ${attempt}: ${e.message}${C.x}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (first !== null) {
        console.log(`${C.d}context seeded. AI:${C.x} ${first.split('\n').find((l) => l.trim())?.slice(0, 160) || ''}`);
        await session.handleReply(first);
      }
      console.log(`\n${C.B}watch mode${C.x} — type your instructions directly in the chat window in Chrome. Ctrl+C here to stop.`);
      for (;;) {
        let reply;
        try {
          reply = await chat.waitForNewMessage();
        } catch (e) {
          console.log(`${C.y}${e.message}${C.x}`);
          console.log(`${C.d}still watching — type in the Chrome chat window; Ctrl+C here to stop.${C.x}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        console.log(`\n${C.b}${C.B}AI reply detected:${C.x}`);
        await session.handleReply(reply);
      }
    }
    console.log(`${C.d}seeding context into the chat...${C.x}`);
    const first = await chat.send(preamble);
    console.log(`${C.d}context seeded. AI:${C.x} ${first.split('\n').find((l) => l.trim())?.slice(0, 160) || ''}`);
    await session.handleReply(first);

    if (args.ask) {
      const reply = await chat.send(`USER INSTRUCTION: ${args.ask}`);
      await session.handleReply(reply);
      return;
    }


    console.log(`\nType instructions (they are relayed to ${providerName}); "exit" or Ctrl+C to quit.`);
    process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
    for (;;) {
      const line = await promptLine(`${C.g}you>${C.x} `);
      const t = line.trim();
      if (!t) continue;
      if (t === 'exit' || t === 'quit') break;
      try {
        const reply = await sendReliable(chat, `USER INSTRUCTION: ${t}`);
        await session.handleReply(reply);
      } catch (e) {
        console.log(`${C.r}error: ${e.message}${C.x}`);
      }
    }
    console.log('bye');
  } finally {
    chat.stop();
  }
}

/** Interactive creation of a provider for any chat URL; persisted to
 *  providers.json so it appears in the menu and --provider from now on. */
async function createCustomProvider(promptLine) {
  const url = (await promptLine('chat URL (e.g. https://poe.com)> ')).trim();
  if (!url) throw new Error('custom provider needs a URL');
  const name = (await promptLine('short name (blank = derived from the URL)> ')).trim();
  const yesNo = async (q) => /^y/i.test((await promptLine(q)).trim());
  const plain = await yesNo('preset/corporate AI that refuses agent roles? enable neutral framing [y/N]> ');
  const simple = await yesNo('weaker model? enable simplified one-tool-per-reply protocol [y/N]> ');
  const delay = +((await promptLine('startup delay in seconds (time to adjust chat settings) [0]> ')).trim()) || 0;
  const { saveCustomProvider } = await import('./providers.js');
  const saved = saveCustomProvider({ url, name, plain, simple, delay });
  console.log(`${C.g}saved provider "${saved.name}" -> ${saved.file}${C.x} ${C.d}(run "doctor --provider ${saved.name}" to check its selectors; edit providers.json to tweak)${C.x}`);
  return saved.name;
}

// --- error capture: nothing dies silently, and the agent can read these ---
globalThis.__whErrors = [];
function recordError(scope, msg) {
  const entry = `[${new Date().toISOString().slice(11, 19)}] ${scope}: ${String(msg).slice(0, 500)}`;
  globalThis.__whErrors.push(entry);
  if (globalThis.__whErrors.length > 50) globalThis.__whErrors.shift();
  return entry;
}
process.on('unhandledRejection', (e) => {
  console.error(`\x1b[33m[unhandled] ${e?.message || e}\x1b[0m`);
  recordError('unhandledRejection', e?.stack || e?.message || String(e));
});
process.on('uncaughtException', (e) => {
  console.error(`\x1b[33m[uncaught] ${e?.message}\x1b[0m`);
  recordError('uncaughtException', e?.stack || e?.message || String(e));
});

function defaultProfile() {
  return path.resolve('.chrome-profile');
}

main().catch((e) => {
  console.error(`\x1b[31m${e.message}\x1b[0m`);
  recordError('fatal', e?.stack || e?.message);
  process.exit(1);
});
