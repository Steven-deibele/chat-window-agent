// Drives a real Chrome chat window over CDP (no AI API needed).
// Launches Chrome with a dedicated debugging profile on first use.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEBUG_PORT = process.env.WH_DEBUG_PORT || 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeCandidates() {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
}

async function probeDebugPort(port, timeoutMs = 900) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Ensure a Chrome instance with remote debugging is running. */
export async function ensureChrome({ launch = true, startUrl, profileDir, log = () => {} } = {}) {
  if (await probeDebugPort(DEBUG_PORT)) return { started: false, port: DEBUG_PORT };
  if (!launch) throw new Error(`No browser with remote debugging on port ${DEBUG_PORT}. Run with launch enabled first.`);
  const exe = chromeCandidates().find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) throw new Error('Chrome/Edge executable not found. Set CHROME_PATH to your browser.');
  // absolute path required: Chrome >=136+ silently ignores --remote-debugging-port with relative user-data-dir
  const absProfile = path.resolve(profileDir || '.chrome-profile');
  const launchArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${absProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session=false',
  ];
  // NOTE: the start URL is NOT passed to Chrome — a CLI URL makes Chrome open
  // its own tab, and the app would add a second one (race). Launch bare; the
  // app adopts the initial tab and navigates it itself.
  const spawnChrome = () => { const c = spawn(exe, launchArgs, { detached: true, stdio: 'ignore' }); c.unref(); };

  for (let attempt = 0; attempt < 2; attempt++) {
    spawnChrome();
    for (let i = 0; i < 50; i++) {
      if (await probeDebugPort(DEBUG_PORT)) return { started: true, port: DEBUG_PORT, exe };
      await sleep(500);
    }
    if (attempt === 0) {
      // likely a zombie Chrome holding the profile but with no debug port — kill and retry
      log('Chrome did not expose its debug port; killing stale Chrome for this profile and retrying…');
      await killProfileChrome(absProfile);
      await sleep(1500);
    }
  }
  throw new Error(`Chrome did not expose remote debugging on port ${DEBUG_PORT} (started from ${exe}).`);
}

/** Kill Chrome/Edge processes that are using the given profile dir (zombie recovery). */
async function killProfileChrome(absProfile) {
  const esc = absProfile.replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*user-data-dir=${esc}*' -and ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await new Promise((res) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    c.on('close', res); c.on('error', res);
    setTimeout(res, 15000);
  });
}

/**
 * Drives one provider chat tab over CDP.
 * @param {{urlOverride?: string, timeoutMs?: number, log?: Function}} opts
 */
export class AIChat {
  constructor(provider, opts = {}) {
    this.p = provider;
    this.urlOverride = opts.urlOverride;
    this.timeoutMs = opts.timeoutMs || provider.replyTimeoutMs || 300000;
    this.log = opts.log || (() => {});
    this.page = null;
    this.browser = null;
  }

  get newChatUrl() { return this.urlOverride || this.p.newChat; }
  get match() {
    if (this.urlOverride) { try { return new URL(this.urlOverride).host; } catch {} }
    return this.p.match;
  }

  async start({ profileDir } = {}) {
    const { started } = await ensureChrome({ profileDir, log: this.log });
    if (started) this.log(`launched Chrome (debug port ${DEBUG_PORT}). Log into your AI chat once; the profile persists.`);
    this.browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null });
    if (started) await sleep(1200); // let Chrome finish creating its initial tab
    this.page = await this.findOrCreateTab();
    this.sessionHost = this.hostOf(this.page.url());
    try { await this.page.bringToFront(); } catch { /* focus is best-effort */ }
    return this;
  }

  hostOf(url) { try { return new URL(url).host; } catch { return null; } }

  async pageAlive() {
    if (!this.page) return false;
    try { await this.page.evaluate(() => true); return true; } catch { return false; }
  }

  /** Re-acquire the session tab: keep the pinned page if alive, else prefer a
   *  tab on the same host (chat apps rewrite their URLs after each message, so
   *  exact-URL matching would hop tabs / open new windows and lose context). */
  async reattach() {
    if (await this.pageAlive()) {
      const h = this.hostOf(this.page.url());
      if (h) this.sessionHost = h;
      return this.page;
    }
    const pages = await this.browser.pages();
    const hosts = [...new Set([this.sessionHost, this.hostOf(this.newChatUrl), this.match].filter(Boolean))];
    let page = pages.find((pg) => hosts.includes(this.hostOf(pg.url())));
    if (!page) page = pages.find((pg) => (pg.url() || '').includes(this.match));
    if (!page) {
      this.log('chat tab is gone — opening a new one (previous conversation context is lost)');
      page = await this.browser.newPage();
      await page.goto(this.newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(1500);
    } else {
      this.log('re-attached to the existing chat tab (context preserved)');
    }
    this.page = page;
    this.sessionHost = this.hostOf(page.url()) || this.sessionHost;
    return page;
  }

  stop() { try { this.browser?.disconnect(); } catch {} }

  async findOrCreateTab() {
    const pages = await this.browser.pages();
    const norm = (u) => String(u || '').replace(/\/$/, '');
    let page = pages.find((pg) => norm(pg.url()) === norm(this.newChatUrl));
    if (!page) page = pages.find((pg) => (pg.url() || '').includes(this.match));
    if (page && !this.urlOverride) return page; // existing conversation — keep context
    if (!page) {
      // adopt Chrome's launch tab instead of creating a second one
      page = pages.find((pg) => /^(about:blank|chrome:\/\/newtab|edge:\/\/newtab)/.test(pg.url() || ''));
      if (!page) page = await this.browser.newPage();
    }
    await page.goto(this.newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    return page;
  }

  /** Start a FRESH conversation in the pinned tab (drops the old DOM/context).
   *  Used by /clear and /compress to escape the chat's context limit and to
   *  shrink the DOM that reply-detection has to probe. */
  async newChat() {
    await this.page.goto(this.newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    this.sessionHost = this.hostOf(this.page.url()) || this.sessionHost;
    this.__snapLast = undefined; // watch-mode dedup refers to the old conversation
    await this.waitForInput(); // composer ready before the next send
  }

  /** Open a sibling chat in a NEW tab sharing this browser connection
   *  (sub-agents). The caller owns the returned AIChat's page — close
   *  sub.page when done; never call sub.stop() (it would disconnect the
   *  SHARED browser connection and kill the parent too). */
  async openInNewTab() {
    const sub = new AIChat(this.p, { urlOverride: this.urlOverride, timeoutMs: this.timeoutMs, log: this.log });
    sub.browser = this.browser;
    sub.page = await this.browser.newPage();
    await sub.page.goto(sub.newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    sub.sessionHost = sub.hostOf(sub.page.url());
    return sub;
  }

  /** Race a promise against a deadline so a stalled CDP call fails loudly
   *  instead of freezing the session forever. */
  bounded(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || 'operation'} stalled (${ms / 1000}s)`)), ms)),
    ]);
  }

  async findOne(selectors, { visible = true, chatInput = false } = {}) {
    for (const frame of this.page.frames()) {
      for (const sel of selectors) {
        try {
          const handles = await this.bounded(frame.$$(sel), 10000, 'querySelectorAll');
          for (const h of handles) {
            if (!visible) return { handle: h, selector: sel };
            if (chatInput) {
              // reject decoy inputs: footer/nav widgets, email/search fields
              const decoy = await h.evaluate((el) => {
                if (el.closest('footer, nav, [class*=footer i]')) return true;
                const type = (el.getAttribute('type') || '').toLowerCase();
                if (['email', 'search', 'tel', 'password', 'url'].includes(type)) return true;
                const ph = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
                return /email|search|subscribe|newsletter|password|phone/.test(ph);
              }).catch(() => false);
              if (decoy) continue;
            }
            const box = await h.boundingBox().catch(() => null);
            if (box) return { handle: h, selector: sel };
          }
        } catch { /* invalid selector or stalled frame */ }
      }
    }
    return null;
  }

  async evaluate(fn, ...args) {
    return this.bounded(this.page.evaluate(fn, ...args), 20000, 'evaluate');
  }

  /** Bounded keyboard helpers — a stalled CDP input dispatch must never
   *  freeze the session. */
  kbd(action, key, opts) {
    return this.bounded(action === 'type' ? this.page.keyboard.type(key, opts) : this.page.keyboard[action](key), 30000, `keyboard.${action}`).catch((e) => this.log(`${e.message} (continuing)`));
  }

  /** Evaluate in the main frame, else in any sub-frame that can answer —
   *  corporate chat UIs often live inside an iframe. */
  async evalAnywhere(fn, ...args) {
    const timed = (p) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timeout (page busy or context destroyed)')), 15000)),
    ]);
    for (const frame of this.page.frames()) {
      try {
        const v = await timed(frame.evaluate(fn, ...args));
        if (v !== undefined && v !== null) return v;
      } catch (e) { if (/timeout/.test(e.message)) this.log(`frame evaluate stalled: ${e.message}`); /* frame not accessible */ }
    }
    return undefined;
  }

  async typeIntoInput(text) {
    let found = await this.waitForInput();
    if (this.p.clickEvery !== true) {
      // synthetic focus first (on a NON-decoy input); the gate then passes only if focus stuck
      await this.evaluate((sels) => {
        const isDecoy = (el) => {
          if (el.closest('footer, nav, [class*=footer i]')) return true;
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (['email', 'search', 'tel', 'password', 'url'].includes(type)) return true;
          const ph = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
          return /email|search|subscribe|newsletter|password|phone/.test(ph);
        };
        for (const s of sels) for (const el of document.querySelectorAll(s)) { if (!isDecoy(el)) { el.focus(); return; } }
      }, this.p.input).catch(() => {});
    }
    await this.waitForUserClick();
    const landed = () => this.evaluate((t) => {
      const el = document.activeElement;
      const cur = el ? (el.value !== undefined ? el.value : (el.innerText || '')) : '';
      return cur.includes(t.slice(-40));
    }, text).catch(() => false);

    for (let attempt = 0; attempt < 2; attempt++) {
      await found.handle.scrollIntoViewIfNeeded().catch(() => {}); // avoid clicks landing on fixed footers/overlays
      await sleep(200);
      await found.handle.click({ clickCount: 3 }).catch(() => found.handle.click());
      await found.handle.evaluate((el) => el.focus()).catch(() => {}); // guarantee activeElement even if the click hit an overlay
      await this.kbd('down','Control'); await this.kbd('press','KeyA');
      await this.kbd('up','Control'); await this.kbd('press','Backspace');
      await sleep(150);
      // typing methods; order overridable per provider via "typing" (auto|clipboard|keystrokes)
      const methods = {
        insertText: async () => this.evaluate((t) => {
          const el = document.activeElement;
          if (!el) return false;
          try { if (!document.execCommand('insertText', false, t)) return false; } catch { return false; }
          const cur = el.value !== undefined ? el.value : (el.innerText || '');
          return cur.length >= Math.floor(t.length * 0.9);
        }, text).catch(() => false),
        clipboard: async () => {
          try {
            const origin = new URL(this.page.url()).origin;
            const bctx = this.page.browserContext?.();
            if (bctx?.overridePermissions) await bctx.overridePermissions(origin, ['clipboard-read', 'clipboard-write']).catch(() => {});
          } catch { /* older puppeteer: continue anyway */ }
          const ok = await this.evaluate(async (t) => {
            try { await navigator.clipboard.writeText(t); } catch { return false; }
            return true;
          }, text).catch(() => false);
          if (!ok) return false;
          await this.kbd('down','Control'); await this.kbd('press','KeyV');
          await this.kbd('up','Control'); await sleep(400);
          return landed();
        },
        keystrokes: async () => {
          const parts = text.split('\n');
          for (let i = 0; i < parts.length; i++) {
            if (parts[i]) await this.kbd('type', parts[i], { delay: 2 });
            if (i < parts.length - 1) {
              await this.kbd('down','Shift'); await this.kbd('press','Enter');
              await this.kbd('up','Shift');
            }
          }
          return landed();
        },
      };
      const pref = this.p.typing;
      const order = pref === 'clipboard' ? ['clipboard', 'insertText', 'keystrokes']
        : pref === 'keystrokes' ? ['keystrokes', 'insertText', 'clipboard']
        : ['insertText', 'clipboard', 'keystrokes'];
      let ok = false;
      for (const name of order) {
        ok = await methods[name]();
        if (ok) break;
      }

      if (ok) return;
      // retry once with a freshly-focused input (page may still be hydrating)
      await sleep(800);
      found = await this.findOne(this.p.input, { chatInput: true });
      if (!found) found = await this.waitForInput();
    }
    throw new Error('typing did not land in the chat input (page still loading or wrong element) — will retry');
  }

  /** Wait until the chat INPUT is genuinely interactive before typing:
   *  either it is already the active element, or the user clicks it.
   *  Page-level focus lies after bringToFront(), so we anchor on the input.
   *  "waitForClick": false disables; "clickEvery": true demands a real click
   *  before every message (for inputs that ignore synthetic focus). */
  async waitForUserClick(maxMs = 600000) {
    if (this.p.waitForClick === false || process.env.WH_NO_CLICK_WAIT) return;
    const inputSel = this.p.input || [];
    let armed = false;
    try {
      await this.evalAnywhere((sels, every) => {
        if (document.__whClickArmed) return;
        let el = null;
        const isDecoy = (n) => {
          if (n.closest('footer, nav, [class*=footer i]')) return true;
          const ty = (n.getAttribute('type') || '').toLowerCase();
          if (['email', 'search', 'tel', 'password', 'url'].includes(ty)) return true;
          const ph = `${n.getAttribute('placeholder') || ''} ${n.getAttribute('aria-label') || ''}`.toLowerCase();
          return /email|search|subscribe|newsletter|password|phone/.test(ph);
        };
        for (const s of sels) { for (const n of document.querySelectorAll(s)) { if (!isDecoy(n)) { el = n; break; } } if (el) break; }
        if (!el) return;
        document.__whClickArmed = true;
        const ready = () => { document.__whInputReady = true; };
        el.addEventListener('click', ready, { once: true, capture: true });
        el.addEventListener('focus', ready, { once: true, capture: true });
        if (!every && document.activeElement === el) document.__whInputReady = true;
      }, inputSel, !!this.p.clickEvery);
      armed = !!(await this.evalAnywhere(() => document.__whClickArmed).catch(() => false));
    } catch { /* page not ready — skip the gate */ }
    if (!armed) return;
    const t0 = Date.now();
    let told = false;
    for (;;) {
      const ready = await this.evalAnywhere(() => !!document.__whInputReady).catch(() => true);
      if (ready) return;
      if (!told) { this.log('click once inside the chat input box — I will type right after…'); told = true; }
      if (Date.now() - t0 > maxMs) throw new Error('timed out waiting for you to click the chat input.');
      await sleep(500);
    }
  }

  /** Wait for the chat input; if missing, prompt the user to open/prepare the
   *  chat window and retry (also scans other tabs in case the user opened the
   *  chat elsewhere). Never crashes on a missing input. */
  async waitForInput() {
    for (let round = 0; round < 6; round++) {
      for (let t = 0; t < 15; t++) { // up to 15s: fresh Chrome pages load slowly
        const f = await this.findOne(this.p.input, { chatInput: true });
        if (f) return f;
        await sleep(1000);
      }
      // maybe the chat input lives in another tab the user opened
      const pages = await this.browser.pages().catch(() => []);
      for (const pg of pages) {
        if (pg === this.page) continue;
        let has = false;
        for (const sel of this.p.input) {
          try { has = await pg.$$(sel).then((hs) => hs.length > 0); } catch { has = false; }
          if (has) break;
        }
        if (has) {
          this.log(`chat input found in another tab (${pg.url().slice(0, 60)}) — switching to it`);
          this.page = pg;
          this.sessionHost = this.hostOf(pg.url()) || this.sessionHost;
          const f = await this.findOne(this.p.input, { chatInput: true });
          if (f) return f;
        }
      }
      this.log('no chat input found on the current page');
      const { promptLine } = await import('./picker.js');
      const a = (await promptLine('Open the chat in the Chrome window (log in / start a chat if needed), then press Enter to retry — or type q to quit> ')).trim();
      if (a.toLowerCase().startsWith('q')) {
        throw new Error('no chat input found — aborted. Check the Chrome window; "doctor" and "calibrate" can diagnose this chat.');
      }
      await this.reattach(); // page may have been closed/replaced while waiting
    }
    throw new Error('no chat input found after retries — check the Chrome window (logged in? chat page open?) and run doctor.');
  }

  /** True when it looks like the message left the composer. */
  async submittedOk(baselineCount) {
    const empty = await this.evaluate((sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) {
          const cur = el.value !== undefined ? el.value : (el.innerText || '');
          return cur.trim().length < 5;
        }
      }
      return true; // no known input on the page; assume submitted
    }, this.p.input).catch(() => true);
    return empty || (await this.isBusy()) || (await this.assistantCount()) > baselineCount;
  }

  async submit(baselineCount) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const btn = await this.findOne(this.p.send);
      if (btn) {
        // wait briefly for the button to enable after typing
        for (let i = 0; i < 8; i++) {
          const dis = await this.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true', btn.handle).catch(() => false);
          if (!dis) break;
          await sleep(400);
        }
        // in-page JS click: fires the app's own handler, immune to window focus / coordinates
        await this.evaluate((sel) => { const b = document.querySelector(sel); if (b) b.click(); }, btn.selector).catch(() => {});
      } else {
        // dispatch Enter on the input element itself (what React editors listen to)
        await this.evaluate((sels) => {
          for (const s of sels) {
            const el = document.querySelector(s);
            if (!el) continue;
            el.focus();
            for (const type of ['keydown', 'keypress', 'keyup']) {
              el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }
            return;
          }
        }, this.p.input).catch(() => {});
      }
      await sleep(800);
      if (await this.submittedOk(baselineCount)) return;
      this.log(`message still in the composer (attempt ${attempt + 1}), trying Enter key…`);
      // focus the input, then OS-level Enter via CDP
      await this.evaluate((sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) { el.focus(); return; } } }, this.p.input).catch(() => {});
      await this.kbd('press','Enter');
      await sleep(800);
      if (await this.submittedOk(baselineCount)) return;
    }
    throw new Error('could not submit the message (send button missing/disabled and Enter did not send). Check the chat window and run "doctor".');
  }

  /** Send a message and wait for the reply. Returns assistant text. */
  async send(text) {
    const pre = await this.replyBaseline();
    await this.typeIntoInput(text);
    await sleep(250);
    await this.submit(pre.count);
    this.log('message sent — waiting for the AI reply…');
    return this.waitReply(pre);
  }

  /** Cheap probe: assistant-node count + text of the LAST node only.
   *  assistantTexts() serializes every node's innerText (O(conversation));
   *  waitReply only needs the count and the tail, so probe just the last one. */
  async lastAssistant() {
    const r = await this.evalAnywhere((selectors) => {
      for (const s of selectors) {
        const nodes = document.querySelectorAll(s);
        if (nodes.length) {
          const n = nodes[nodes.length - 1];
          return { count: nodes.length, last: n.innerText || n.textContent || '' };
        }
      }
      return { count: 0, last: '' };
    }, this.p.assistant).catch(() => null);
    return r || { count: 0, last: '' };
  }

  async assistantCount() {
    return (await this.lastAssistant()).count;
  }

  async assistantTexts() {
    return this.evalAnywhere((selectors) => {
      for (const s of selectors) {
        const nodes = document.querySelectorAll(s);
        if (nodes.length) return [...nodes].map((n) => n.innerText || n.textContent || '');
      }
      return [];
    }, this.p.assistant).catch(() => []);
  }

  /** User-side messages (for agent watch mode). Requires "user" selectors on
   *  the provider; returns [] when unconfigured. */
  async userTexts() {
    if (!this.p.user?.length) return [];
    return this.evalAnywhere((selectors) => {
      for (const s of selectors) {
        const nodes = document.querySelectorAll(s);
        if (nodes.length) return [...nodes].map((n) => n.innerText || n.textContent || '');
      }
      return [];
    }, this.p.user).catch(() => []);
  }

  async userCount() {
    return (await this.userTexts()).length;
  }

  /** Agent watch mode: block until the HUMAN sends a message that isn't ours.
   *  ownSends = messages the harness itself sent since baseline. */
  async waitForHumanMessage(baselineUserCount, ownSends, maxMs = 3600000) {
    if (!this.p.user?.length) {
      throw new Error('this provider has no "user" selectors — add them in providers.json (e.g. the class of user chat bubbles) to use agent watch mode');
    }
    const t0 = Date.now();
    let told = false;
    for (;;) {
      const texts = await this.userTexts();
      const own = typeof ownSends === 'function' ? ownSends() : ownSends;
      if (texts.length > baselineUserCount + own) {
        const fresh = texts.slice(baselineUserCount + own).filter((t) => !/^(TOOL_RESULT|TOOL FEEDBACK|USER REQUEST)/.test(t.trim()));
        if (fresh.length) return fresh[fresh.length - 1];
      }
      if (!told) { this.log('watching the chat window — type your request there…'); told = true; }
      if (Date.now() - t0 > maxMs) throw new Error('timed out waiting for a new chat message.');
      await sleep(1000);
    }
  }

  async bodyText() {
    return this.evalAnywhere(() => document.body.innerText).catch(() => '') || '';
  }

  /** Snapshot used to detect the next AI reply by any of: new assistant node,
   *  changed last node (container selectors), or whole-page text diff. */
  async replyBaseline() {
    const { count, last } = await this.lastAssistant();
    return { count, lastTail: last.slice(-400), body: await this.bodyText() };
  }

  async isBusy() {
    return this.evalAnywhere((selectors) => selectors.some((s) => {
      try { return [...document.querySelectorAll(s)].some((n) => {
        const st = getComputedStyle(n); const r = n.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width + r.height > 0;
      }); } catch { return false; }
    }), this.p.busy).catch(() => false);
  }

  /** Universal reply wait: works even when the provider's assistant selectors
   *  don't match the chat UI (falls back to page-text diffing). */
  async waitReply(baseline) {
    const t0 = Date.now();
    // baseline body is constant — build the diff line-set ONCE, not per tick
    const beforeLines = new Set((baseline.body || '').split('\n').map((l) => l.trim()));
    // page-diff fallback only makes sense when assistant selectors match NOTHING;
    // otherwise node tracking covers new + streaming replies and a full-body
    // innerText (forced layout over the whole page) per tick is pure waste.
    const usePageDiff = baseline.count === 0;
    let candidate = '';
    let lastChange = 0; // timestamp the candidate text last changed
    let lastBeat = 0;
    let via = '';
    while (Date.now() - t0 < this.timeoutMs) {
      const probe = await this.lastAssistant();
      const { count, last } = probe;
      let next = '';
      if (count > baseline.count) { next = last; via = 'assistant node'; }
      else if (count === baseline.count && count > 0) {
        const tail = last.slice(-400);
        if (tail !== baseline.lastTail && tail.trim()) { next = last; via = 'assistant node (updated)'; }
      }
      if (!next && usePageDiff) {
        // fallback: whole-page text diff (custom UIs with unknown selectors)
        const body = await this.bodyText();
        if (body && body !== baseline.body) {
          const added = body.split('\n').map((l) => l.trim()).filter((l) => l && !beforeLines.has(l));
          if (added.length) { next = added.join('\n'); via = 'page diff'; }
        }
      }
      if (next) {
        if (next !== candidate) { candidate = next; lastChange = Date.now(); }
        if (Date.now() - lastBeat > 15000) { lastBeat = Date.now(); this.log(`waiting for the AI reply… ${Math.round((Date.now() - t0) / 1000)}s${via ? ` (via ${via})` : ''}`); }
        // isBusy() is an extra cross-frame eval — only pay for it once the text
        // has been stable long enough to be a finish candidate
        if (candidate.trim() && Date.now() - lastChange >= 2200 && !(await this.isBusy())) {
          this.log(`reply detected via ${via}`);
          return candidate;
        }
      } else if (Date.now() - lastBeat > 15000) {
        lastBeat = Date.now();
        this.log(`waiting for the AI reply… ${Math.round((Date.now() - t0) / 1000)}s (no reply text yet)`);
      }
      await sleep(250);
    }
    throw new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s without detecting an AI reply. If the reply is visible in the browser, run "calibrate" so the tool learns this chat's selectors.`);
  }

  /** Watch mode: block until the next AI reply finishes. Handles the race
   *  where the AI already answered before we started waiting: accepts the
   *  last assistant node when it sits AFTER the last user node in the DOM
   *  and differs from the last reply we consumed. */
  async waitForNewMessage() {
    const pos = await this.evalAnywhere((asSels, uSels) => {
      const lastOf = (sels) => { for (const s of sels) { const n = document.querySelectorAll(s); if (n.length) return n[n.length - 1]; } return null; };
      const a = lastOf(asSels), u = lastOf(uSels);
      if (!a) return null;
      const afterUser = !u || !!(a.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_PRECEDING);
      return { afterUser, text: a.innerText || a.textContent || '' };
    }, this.p.assistant, this.p.user || []);
    if (pos?.afterUser && pos.text.trim() && pos.text !== this.__snapLast) {
      this.__snapLast = pos.text;
      this.log('reply detected (already present, after latest user message)');
      return pos.text;
    }
    const r = await this.waitReply(await this.replyBaseline());
    this.__snapLast = r;
    return r;
  }

  /** True when the page shows a login wall instead of the chat. */
  async needsLogin() {
    const url = this.page.url();
    if (/accounts\.google\.com|myaccount\.google\.com/.test(url)) return true;
    const sels = this.p.loggedOut || [];
    const hasLoginWall = await this.evalAnywhere((selectors) => selectors.some((s) => {
      try { return [...document.querySelectorAll(s)].some((n) => {
        const r = n.getBoundingClientRect(); const st = getComputedStyle(n);
        return r.width + r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
      }); } catch { return false; }
    }), sels).catch(() => false);
    if (hasLoginWall) return true;
    // heuristic: no usable chat input anywhere -> likely a login wall (self-healing:
    // once the input appears, e.g. after login or slow load, this becomes false)
    const hasInput = !!(await this.findOne(this.p.input, { chatInput: true }));
    return !hasInput;
  }

  /** True when the page shows a CAPTCHA / "confirm you are human" interstitial. */
  async needsHumanCheck() {
    const url = this.page.url();
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch {}
    if (/\/challenge|captcha|hcaptcha/i.test(pathname)) return true;
    return this.evalAnywhere(() => {
      if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="cloudflare"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], .g-recaptcha, .h-captcha, [data-sitekey], #cf-challenge-running')) return true;
      const text = (document.body?.innerText || '').slice(0, 4000);
      return /verify you are (a )?human|i'?m not a robot|confirm you('re| are) human|prove you'?re (a )?human|security check|verifying your browser|are you a robot/i.test(text);
    }).catch(() => false);
  }

  /** Wait while the user completes login AND/OR human verification in the
   *  Chrome window; continues automatically when both are done. */
  async waitUntilReady(maxMs = 600000) {
    const t0 = Date.now();
    let saidLogin = false;
    let saidHuman = false;
    for (;;) {
      if (await this.needsHumanCheck()) {
        if (!saidHuman) { this.log('the chat is asking for a human check (e.g. "I\'m not a robot") — complete it in the Chrome window; I will continue automatically…'); saidHuman = true; }
        if (Date.now() - t0 > maxMs) throw new Error('timed out waiting for the human verification to be completed.');
        await sleep(2000);
        continue;
      }
      if (await this.needsLogin()) {
        if (!saidLogin) { this.log(`you are not logged into ${this.p.label || 'the chat'} — please log in inside the Chrome window…`); saidLogin = true; }
        if (Date.now() - t0 > maxMs) throw new Error(`timed out waiting for login at ${this.p.label || 'chat'}`);
        await sleep(2000);
        continue;
      }
      if (saidLogin || saidHuman) await sleep(1500); // let the chat UI settle
      return;
    }
  }

  async diagnose() {
    const info = await this.evaluate((groups) => {
      const out = {};
      for (const [name, sels] of Object.entries(groups)) {
        out[name] = sels.map((s) => {
          try { return { selector: s, count: document.querySelectorAll(s).length }; }
          catch { return { selector: s, count: -1 }; }
        });
      }
      out.url = location.href;
      return out;
    }, { input: this.p.input, send: this.p.send, assistant: this.p.assistant, busy: this.p.busy })
      .catch((e) => ({ error: e.message }));
    return info;
  }
}
