// Provider selector configs. Selector lists are tried in order; first match wins.
// Override or add providers via providers.json in the working directory:
//   { "chatgpt": { "input": ["#my-selector"] } }  (arrays replace, scalars override)
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROVIDERS = {
  chatgpt: {
    label: 'ChatGPT',
    newChat: 'https://chatgpt.com/',
    match: 'chatgpt.com',
    input: [
      '#prompt-textarea',
      'textarea#prompt-textarea',
      '#mobile-composer-prompt',
      "div.ProseMirror[contenteditable='true']",
    ],
    send: [
      "button[data-testid='send-button']",
      "button[aria-label='Send message']",
    ],
    assistant: ["[data-message-author-role='assistant']"],
    user: ["[data-message-author-role='user']"],
    user: ["[data-message-author-role='user']"],
    loggedOut: ["button[data-testid='login-button']", "a[href*='/auth/login']"],
    replyTimeoutMs: 300000,
  },
  claude: {
    label: 'Claude',
    newChat: 'https://claude.ai/new',
    match: 'claude.ai',
    input: ["div.ProseMirror[contenteditable='true']", "div[contenteditable='true']"],
    send: ["button[aria-label='Send message']", "button[aria-label*='Send' i]"],
    user: ['.font-user-message', "[data-testid='user-message']"],
    assistant: ['div.font-claude-message', "[data-testid='assistant-message']"],
    loggedOut: ["a[data-testid='login-button']", "div[data-testid='login-card']"],
    replyTimeoutMs: 300000,
  },
  gemini: {
    label: 'Gemini',
    newChat: 'https://gemini.google.com/app',
    match: 'gemini.google.com',
    input: ['rich-textarea .ql-editor', "div.ql-editor[contenteditable='true']", "textarea[aria-label*='prompt' i]"],
    user: ['.user-query', 'user-query'],
    send: ['button.send-button', "button[aria-label='Send message']", "button[mattooltip*='Send' i]"],
    assistant: ['message-content', '.response-container .markdown', '.markdown'],
    loggedOut: [],
    replyTimeoutMs: 300000,
  },
  deepseek: {
    label: 'DeepSeek',
    newChat: 'https://chat.deepseek.com/',
    match: 'chat.deepseek.com',
    user: ['div[class*=message--user]', '[class*=ds-message-user]'],
    input: ['textarea#chat-input', 'textarea[placeholder*="Ask" i]', 'div[contenteditable=true]', 'textarea'],
    send: ["button[aria-label='Send']", "button[aria-label*='Send' i]", 'button[type=submit]'],
    assistant: ['.ds-markdown', '.markdown', '[class*=message--assistant]'],
    busy: ["button[aria-label*='Stop' i]"],
    loggedOut: [],
    replyTimeoutMs: 300000,
  },
  local: {
    label: 'Local model (GGUF on this machine, offline)',
    local: true, // no browser; runs via node-llama-cpp — see src/local_chat.js
    model: null, // set with --model <ref>, providers.json, or `run.bat models use <ref>`
    simple: true, // local models are weaker: one tool call per reply
    offload: 'normal', // how eagerly hard thinking goes to remote.ask: off|low|normal|aggressive
    replyTimeoutMs: 600000,
  },
  mock: {
    label: 'Mock (local test chat)',
    newChat: 'http://127.0.0.1:8123/',
    match: '127.0.0.1:8123',
    user: ["[data-message-author-role='user']"],
    input: ['#prompt-textarea'],
    send: ["button[data-testid='send-button']"],
    assistant: ["[data-message-author-role='assistant']"],
    busy: ["button[data-testid='stop-button']"],
    loggedOut: ["button[data-testid='login-button']"],
    replyTimeoutMs: 60000,
  },
};

export function loadProviders() {
  const providers = structuredClone(DEFAULT_PROVIDERS);
  for (const cand of [path.resolve('providers.json'), path.resolve(os_home(), '.chat-window-agent', 'providers.json')]) {
    if (!fs.existsSync(cand)) continue;
    try {
      const user = JSON.parse(fs.readFileSync(cand, 'utf8'));
      for (const [name, over] of Object.entries(user)) {
        providers[name] = { ...(providers[name] || { label: name }), ...over };
      }
    } catch (e) {
      throw new Error(`Bad providers.json at ${cand}: ${e.message}`);
    }
  }
  return providers;
}

/** Create and persist a custom provider for any chat URL (company/self-hosted
 *  chat UIs). Writes providers.json in the cwd so it appears in the chooser,
 *  --provider, and the GUI from now on. Returns { name, entry }. */
export function saveCustomProvider({ url, name, plain = false, simple = false, delay = 0 } = {}) {
  if (!url) throw new Error('custom provider needs a URL');
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  const parsed = new URL(url);
  const defName = parsed.hostname.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'custom';
  name = (name || defName).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || defName;
  const providers = loadProviders();
  while (providers[name]) name = name.replace(/-\d+$/, '') + '-' + Math.floor(Math.random() * 90 + 10);
  const entry = {
    label: `${name} (${parsed.hostname})`,
    newChat: url,
    match: parsed.host,
    // generic best-effort selectors — tweak in providers.json if needed
    input: ["div[contenteditable='true']", 'textarea'],
    send: ["button[data-testid='send-button']", "button[aria-label='Send message']", "button[aria-label*='Send' i]", "button[type='submit']"],
    assistant: ["[data-message-author-role='assistant']", "[class*='assistant' i]", '.markdown', "[class*='response' i]"],
    busy: ["button[data-testid='stop-button']", "button[aria-label*='Stop' i]"],
    replyTimeoutMs: 300000,
    ...(plain ? { plain: true } : {}),
    ...(simple ? { simple: true } : {}),
    ...(delay > 0 ? { delay } : {}),
  };
  const file = path.resolve('providers.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  existing[name] = entry;
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
  return { name, entry, file };
}

function os_home() {
  return process.env.USERPROFILE || process.env.HOME || '.';
}
