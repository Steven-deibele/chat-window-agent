// Computer-use tools: let the agent operate a real browser tab (click, type,
// read pages) and native Windows app windows (UI Automation element trees,
// clicks, keystrokes). Registered as built-ins by registry.js.
//
// Browser tools reuse the same Chrome the chat window runs in (CDP debug
// port), but drive a SEPARATE agent tab — the AI chat tab is never touched.
// Desktop tools shell out to PowerShell + UIAutomationClient (Windows only).
import fs from 'node:fs';
import path from 'node:path';

const clip = (s, n = 4000) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
  return t.length > n ? t.slice(0, n) + `\n<TRUNCATED ${t.length - n} chars>` : t;
};

// --- shared browser state ----------------------------------------------------
let _browser = null;   // puppeteer connection (independent of the AIChat one)
let _page = null;      // the agent's working tab
let _refs = new Map(); // ref number -> css selector (rebuilt by every browser.read)

async function conn() {
  if (_browser && _browser.connected !== false) {
    try { if (_browser.isConnected && !_browser.isConnected()) throw new Error('lost'); return _browser; }
    catch { /* reconnect below */ }
  }
  const { ensureChrome } = await import('../ai_browser.js');
  const { port } = await ensureChrome({ log: () => {} });
  const puppeteer = (await import('puppeteer-core')).default;
  _browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  _page = null;
  return _browser;
}

async function agentPage() {
  const browser = await conn();
  if (_page) {
    try { await _page.evaluate(() => true); return _page; } catch { /* tab died */ }
  }
  _page = await browser.newPage();
  return _page;
}

/** In-page collector: visible interactive elements + a unique css path each.
 *  Runs inside the browser; returns plain data. */
function collectPage() {
  const cssPath = (el) => {
    if (el.id) {
      const byId = `#${CSS.escape(el.id)}`;
      if (document.querySelectorAll(byId).length === 1) return byId;
    }
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { p = `#${CSS.escape(cur.id)}`; parts.unshift(p); break; }
      const sibs = [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName);
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const els = [...document.querySelectorAll(
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"], [onclick]'
  )].filter(visible).slice(0, 120);
  const items = els.map((el) => {
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || el.type || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return {
      sel: cssPath(el),
      kind: el.tagName.toLowerCase() + (el.type && el.tagName === 'INPUT' ? `[${el.type}]` : ''),
      label,
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 120) : undefined,
    };
  });
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 2500);
  return { title: document.title, url: location.href, items, text };
}

async function readPage(page, { includeText = true } = {}) {
  const data = await page.evaluate(collectPage);
  _refs = new Map();
  const lines = [`PAGE: ${data.title}`, `URL: ${data.url}`, 'INTERACTIVE ELEMENTS (use ref numbers with browser.click / browser.type):'];
  data.items.forEach((it, i) => {
    _refs.set(i + 1, it.sel);
    lines.push(`[${i + 1}] ${it.kind} "${it.label}"${it.href ? ` -> ${it.href}` : ''}`);
  });
  if (includeText && data.text.trim()) lines.push('', 'PAGE TEXT (excerpt):', data.text);
  return lines.join('\n');
}

function resolveRef(args) {
  if (args.selector) return String(args.selector);
  const sel = _refs.get(Number(args.ref));
  if (!sel) throw new Error(`unknown ref "${args.ref}" — call browser.read first (refs are rebuilt on every read)`);
  return sel;
}

// --- desktop (Windows UI Automation via PowerShell) ---------------------------
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function ps(script, timeoutMs = 45000) {
  if (process.platform !== 'win32') return { code: -1, out: '', err: 'desktop.* tools are Windows-only' };
  const enc = Buffer.from('[Console]::OutputEncoding=[Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { c.kill(); } catch {} resolve({ code: -1, out, err: err + '\n(powerShell timed out)' }); }, timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
  });
}

const UIA_PRELUDE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WhU32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$ae = [System.Windows.Automation.AutomationElement]
`;

/** PS snippet: resolve $win from -like title match or numeric hwnd in $Target. */
const UIA_FIND_WINDOW = `
$Target = TARGET_EXPR
$win = $null
if ($Target -match '^\\d+$') {
  $win = $ae::FromHandle([IntPtr][int64]$Target)
} else {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  foreach ($w in $ae::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    if ($w.Current.Name -like ('*' + $Target + '*')) { $win = $w; break }
  }
}
if (-not $win) { Write-Output ('ERROR no window matching "' + $Target + '" — call desktop.windows for the exact titles'); exit 1 }
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
`;

const winOnly = () => 'ERROR desktop.* tools are Windows-only';

export const COMPUTER_TOOLS = [
  // --- browser ---------------------------------------------------------------
  {
    meta: {
      name: 'browser.open',
      description: 'Open a URL in the agent\'s own Chrome tab (the AI chat tab is untouched) and return the page with numbered interactive elements. The browser is the user\'s logged-in session — use it for web apps, portals, dashboards, anything needing JS or login. Follow with browser.read/browser.click/browser.type.',
      params: { url: 'http(s) URL' },
    },
    async run(args) {
      if (!args?.url) throw new Error('need "url"');
      const page = await agentPage();
      await page.goto(String(args.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise((r) => setTimeout(r, 1200));
      return clip(await readPage(page), 6000);
    },
  },
  {
    meta: {
      name: 'browser.read',
      description: 'Re-read the agent browser tab: numbered interactive elements ([1] button "Save" …) plus visible text. Refs are rebuilt on every read — always read again after navigation or DOM changes before clicking.',
      params: { text: 'false to skip the page-text excerpt' },
    },
    async run(args) {
      const page = await agentPage();
      return clip(await readPage(page, { includeText: args?.text !== false }), 6000);
    },
  },
  {
    meta: {
      name: 'browser.click',
      description: 'Click an element in the agent tab, by ref number from browser.read (preferred) or a CSS selector. Returns the updated page state.',
      params: { ref: 'element number from browser.read', selector: 'CSS selector (if no ref)' },
    },
    async run(args) {
      const page = await agentPage();
      const sel = resolveRef(args);
      await page.evaluate((s) => { document.querySelector(s)?.scrollIntoView({ block: 'center' }); }, sel);
      await page.click(sel);
      await new Promise((r) => setTimeout(r, 1000));
      return clip(`clicked ${sel}\n\n` + await readPage(page), 6000);
    },
  },
  {
    meta: {
      name: 'browser.type',
      description: 'Type text into a field in the agent tab, by ref number or CSS selector. Clears existing content unless clear:false. Set enter:true to press Enter afterwards (submits forms/search boxes).',
      params: { ref: 'element number from browser.read', selector: 'CSS selector (if no ref)', text: 'text to type', clear: 'false to append instead of replacing', enter: 'true to press Enter at the end' },
    },
    async run(args) {
      if (args?.text == null) throw new Error('need "text"');
      const page = await agentPage();
      const sel = resolveRef(args);
      await page.evaluate((s) => { document.querySelector(s)?.scrollIntoView({ block: 'center' }); }, sel);
      await page.focus(sel);
      if (args.clear !== false) {
        await page.evaluate((s) => { const el = document.querySelector(s); if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } }, sel);
        await page.click(sel, { clickCount: 3 }).catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
      }
      await page.type(sel, String(args.text), { delay: 15 });
      if (args.enter) await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 800));
      return `typed ${String(args.text).length} chars into ${sel}${args.enter ? ' + Enter' : ''}\nURL now: ${page.url()}`;
    },
  },
  {
    meta: {
      name: 'browser.scroll',
      description: 'Scroll the agent tab (direction + amount) or scroll a CSS selector into view.',
      params: { dir: 'down|up|top|bottom (default down)', amount: 'pixels (default 800)', selector: 'CSS selector to scroll into view instead' },
    },
    async run(args) {
      const page = await agentPage();
      if (args?.selector) {
        await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), String(args.selector));
        return `scrolled to ${args.selector}`;
      }
      const dir = args?.dir || 'down';
      const amount = Number(args?.amount) || 800;
      await page.evaluate((d, a) => {
        if (d === 'top') window.scrollTo(0, 0);
        else if (d === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else window.scrollBy(0, d === 'up' ? -a : a);
      }, dir, amount);
      return `scrolled ${dir}`;
    },
  },
  {
    meta: {
      name: 'browser.eval',
      description: 'Run JavaScript inside the agent tab and return the result (JSON). Full DOM access — use for scraping tables, clicking stubborn elements, reading hidden state.',
      params: { js: 'JS body; may use await; return a value' },
    },
    async run(args) {
      if (!args?.js) throw new Error('need "js"');
      const page = await agentPage();
      const res = await page.evaluate((code) => {
        const fn = new Function(`return (async () => { ${code} })()`);
        return fn().then(
          (v) => ({ ok: true, value: v === undefined ? null : v }),
          (e) => ({ ok: false, error: String(e && e.message || e) })
        );
      }, String(args.js));
      if (!res.ok) return `PAGE ERROR: ${res.error}`;
      return clip(typeof res.value === 'string' ? res.value : JSON.stringify(res.value, null, 2), 5000);
    },
  },
  {
    meta: {
      name: 'browser.tabs',
      description: 'List all open Chrome tabs (index, title, url). The agent tab is marked; the AI chat tab must not be driven.',
      params: {},
    },
    async run() {
      const browser = await conn();
      const pages = await browser.pages();
      const lines = await Promise.all(pages.map(async (p, i) => {
        let title = ''; try { title = await p.title(); } catch {}
        return `[${i}]${p === _page ? ' (agent tab)' : ''} ${title} — ${p.url()}`;
      }));
      return lines.join('\n');
    },
  },
  {
    meta: {
      name: 'browser.screenshot',
      description: 'Save a screenshot of the agent tab to a .png (default: scratchDir) and return the path. Note: you cannot SEE the image — use browser.read for content; screenshots are evidence for the user.',
      params: { path: 'output .png path (optional)', fullPage: 'true for full scroll height' },
    },
    async run(args) {
      const page = await agentPage();
      const dest = path.resolve(args?.path || path.join('.wh-work', `shot-${Date.now()}.png`));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await page.screenshot({ path: dest, fullPage: !!args?.fullPage });
      return `screenshot saved: ${dest}`;
    },
  },
  {
    meta: {
      name: 'browser.close',
      description: 'Close the agent browser tab (keeps Chrome and the AI chat tab running).',
      params: {},
    },
    async run() {
      if (_page) { try { await _page.close(); } catch {} _page = null; }
      return 'agent tab closed';
    },
  },
  // --- desktop (Windows) -------------------------------------------------------
  {
    meta: {
      name: 'desktop.windows',
      description: 'List visible application windows on this Windows machine: handle, pid, process name, title. Use the title (or handle) with desktop.tree/desktop.click/desktop.type to drive a native app.',
      params: {},
    },
    async run() {
      if (process.platform !== 'win32') return winOnly();
      const r = await ps(`Get-Process | Where-Object { $_.MainWindowTitle } | Sort-Object ProcessName | ForEach-Object { '{0}  pid={1}  {2}  "{3}"' -f $_.MainWindowHandle, $_.Id, $_.ProcessName, $_.MainWindowTitle }`);
      return clip(r.out.trim() || r.err.trim() || '(no visible windows)', 4000);
    },
  },
  {
    meta: {
      name: 'desktop.tree',
      description: 'Dump the UI element tree of an app window (Windows UI Automation): control type, name, bounding box — buttons, edits, menu items. Call this BEFORE desktop.click to find the exact element name.',
      params: { window: 'window title substring (from desktop.windows) or handle', depth: 'tree depth, default 4', max: 'max lines, default 200' },
    },
    async run(args) {
      if (process.platform !== 'win32') return winOnly();
      if (!args?.window) throw new Error('need "window" (title substring or handle)');
      const depth = Math.min(Number(args.depth) || 4, 8);
      const max = Math.min(Number(args.max) || 200, 600);
      const script = UIA_PRELUDE + UIA_FIND_WINDOW.replace('TARGET_EXPR', psq(args.window)) + `
Write-Output ('WINDOW: ' + $win.Current.Name + '  (handle ' + $hwnd + ')')
$script:count = 0
function Walk($el, $indent, $d) {
  if ($script:count -ge ${max} -or $d -lt 0) { return }
  try {
    $c = $el.Current
    $r = $c.BoundingRectangle
    $pos = if ($r.Width -gt 0) { (' @({0},{1} {2}x{3})' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height) } else { '' }
    $aid = if ($c.AutomationId) { ' [' + $c.AutomationId + ']' } else { '' }
    Write-Output (('  ' * $indent) + $c.ControlType.ProgrammaticName.Replace('ControlType.','') + ' "' + $c.Name + '"' + $aid + $pos)
    $script:count++
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($el)
    while ($child -and $script:count -lt ${max}) {
      Walk $child ($indent + 1) ($d - 1)
      $child = $walker.GetNextSibling($child)
    }
  } catch {}
}
Walk $win 0 ${depth}
`;
      const r = await ps(script, 60000);
      return clip(r.out.trim() || r.err.trim() || '(empty tree)', 8000);
    },
  },
  {
    meta: {
      name: 'desktop.click',
      description: 'Click a UI element in an app window by its Name or AutomationId (from desktop.tree). Tries the element\'s Invoke pattern first, falls back to a real mouse click at the element\'s center. WARNING: acts on the real app — double-check the element name via desktop.tree.',
      params: { window: 'window title substring or handle', name: 'element Name (exact or substring)', automationId: 'element AutomationId (if name is empty/ambiguous)' },
    },
    async run(args) {
      if (process.platform !== 'win32') return winOnly();
      if (!args?.window || (!args.name && !args.automationId)) throw new Error('need "window" and "name" (or "automationId")');
      const findCond = args.automationId
        ? `New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, ${psq(args.automationId)})`
        : `New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, ${psq(args.name)}, [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)`;
      const script = UIA_PRELUDE + UIA_FIND_WINDOW.replace('TARGET_EXPR', psq(args.window)) + `
$cond = ${findCond}
$el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
NAME_FALLBACK
if (-not $el) { Write-Output 'ERROR element not found — call desktop.tree to see the exact names'; exit 1 }
$c = $el.Current
$desc = $c.ControlType.ProgrammaticName.Replace('ControlType.','') + ' "' + $c.Name + '"'
[WhU32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300
$pat = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
  try { $el.SetFocus(); $pat.Invoke(); Write-Output ('invoked ' + $desc); exit 0 } catch {}
}
try { $el.SetFocus() } catch {}
$r = $c.BoundingRectangle
if ($r.Width -le 0) { Write-Output ('ERROR element has no clickable area: ' + $desc); exit 1 }
$x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
[WhU32]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 150
[WhU32]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[WhU32]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
Write-Output ('clicked ' + $desc + (' at ({0},{1})' -f $x, $y))
`;
      // Name searches allow substring fallback when the exact match fails.
      const fallback = args.automationId ? '' : `
if (-not $el) {
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($cand in $all) { if ($cand.Current.Name -like ('*' + ${psq(args.name)} + '*')) { $el = $cand; break } }
}`;
      const r = await ps(script.replace('NAME_FALLBACK', fallback), 60000);
      return clip(r.out.trim() || r.err.trim() || '(no output)');
    },
  },
  {
    meta: {
      name: 'desktop.type',
      description: 'Type text into the currently focused field of an app window (brings the window to front, pastes via clipboard + Ctrl+V — reliable for long text and special characters). Click/focus the target field with desktop.click first when needed.',
      params: { window: 'window title substring or handle', text: 'text to type', enter: 'true to press Enter after' },
    },
    async run(args) {
      if (process.platform !== 'win32') return winOnly();
      if (!args?.window || args.text == null) throw new Error('need "window" and "text"');
      const script = UIA_PRELUDE + UIA_FIND_WINDOW.replace('TARGET_EXPR', psq(args.window)) + `
Add-Type -AssemblyName System.Windows.Forms
Set-Clipboard -Value ${psq(args.text)}
[WhU32]::ShowWindow($hwnd, 9) | Out-Null
[WhU32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('^v')
${args.enter ? "Start-Sleep -Milliseconds 150\n[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')" : ''}
Write-Output ('typed ' + (${psq(args.text)}).Length + ' chars into "' + $win.Current.Name + '"')
`;
      const r = await ps(script, 60000);
      return clip(r.out.trim() || r.err.trim() || '(no output)');
    },
  },
  {
    meta: {
      name: 'desktop.keys',
      description: 'Send keystrokes to an app window (brings it to front first). Uses SendKeys syntax: {ENTER} {TAB} {ESC} {F5} ^a (Ctrl+A) ^c ^v %+ (Alt+Space) {DOWN 3}. Use for shortcuts and navigation; prefer desktop.type for plain text.',
      params: { window: 'window title substring or handle', keys: 'SendKeys sequence' },
    },
    async run(args) {
      if (process.platform !== 'win32') return winOnly();
      if (!args?.window || !args.keys) throw new Error('need "window" and "keys"');
      const script = UIA_PRELUDE + UIA_FIND_WINDOW.replace('TARGET_EXPR', psq(args.window)) + `
Add-Type -AssemblyName System.Windows.Forms
[WhU32]::ShowWindow($hwnd, 9) | Out-Null
[WhU32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait(${psq(args.keys)})
Write-Output ('sent keys ' + ${psq(JSON.stringify(String(args.keys)))} + ' to "' + $win.Current.Name + '"')
`;
      const r = await ps(script, 60000);
      return clip(r.out.trim() || r.err.trim() || '(no output)');
    },
  },
];
