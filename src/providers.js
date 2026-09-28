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

function os_home() {
  return process.env.USERPROFILE || process.env.HOME || '.';
}
