// Browser client for the GUI server (src/gui.js). Served verbatim at
// /gui-client.js; the per-launch token is injected into the host page as
// window.__GUI_TOKEN__ (that page is only served to loopback Hosts).
// Kept as a plain .js file that Node reads but never imports, so it needs no
// template-literal escaping and can be parsed/linted as real JavaScript.
const $ = (s) => document.querySelector(s);
const f = $('#f');
const GUI_TOKEN = window.__GUI_TOKEN__;
let providers = [], running = false;

async function api(p, body) {
  const r = await fetch(p, body === undefined ? { headers: { 'x-gui-token': GUI_TOKEN } } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-gui-token': GUI_TOKEN }, body: JSON.stringify(body) });
  return r.json();
}

function state() {
  const d = new FormData(f), s = {};
  for (const [k, v] of d) s[k] = v;
  for (const c of f.querySelectorAll('input[type=checkbox]')) s[c.name] = c.checked;
  s.against = [...document.querySelectorAll('#evlist span')].map((e) => e.dataset.p);
  return s;
}

const quote = (p) => (/[\s"']/.test(p) ? '"' + p.replace(/"/g, '\\"') + '"' : p);
let previewSeq = 0;
// The server builds the argv (buildArgv is the single source of truth for the
// mode gates and folder expansion) — the page just quotes it for display.
async function preview() {
  const s = state();
  // bump the sequence even on early returns: an in-flight /api/preview from a
  // previous keystroke must lose the race against this render too
  const seq = ++previewSeq;
  if (s.mode === 'models') { $('#preview').textContent = 'run.bat models'; return; }
  let r;
  try { r = await api('/api/preview', s); }
  catch { if (seq === previewSeq) $('#preview').textContent = '(preview unavailable)'; return; }
  if (seq !== previewSeq) return; // a newer keystroke superseded this render
  $('#preview').textContent = r.ok
    ? ['run.bat', ...r.argv].map(quote).join(' ')
    : '\u26a0 ' + r.error;
}

let saveT, previewT;
// preview hits the server (buildArgv may walk folders via expandDocs), so
// debounce it like the settings save instead of POSTing per keystroke
const schedulePreview = () => { clearTimeout(previewT); previewT = setTimeout(preview, 250); };
const MODE_HELP = {
  agent: 'general assistant with tools: reads/edits files, runs commands, browses the web — chat with it in the input box on the right',
  edit: 'focused editing of one Word/Excel document, one instruction at a time',
  fill: 'reviews a Word checklist against the evidence documents and marks/fills it in',
  ask: 'sends one question to a cloud chat window and prints the answer — no tools, no files',
  calibrate: 'teaches the tool a company chat UI by watching one exchange, then saves it as a provider',
  doctor: 'checks that the saved selectors still match the chat page (run after a site redesign)',
  models: 'lists the local GGUF models downloaded in models/',
};
function changed() {
  const p = providers.find((x) => x.name === f.provider.value);
  $('#modehelp').textContent = MODE_HELP[f.mode.value] || '';
  const isLocal = !!(p && p.local);
  $('#localopts').classList.toggle('hidden', !isLocal);
  $('#sidecar').classList.toggle('hidden', isLocal || f.mode.value !== 'agent');
  $('#modelwrap').classList.toggle('hidden', !(isLocal || (f.withLocal.checked && !isLocal)));
  const fileModes = ['agent', 'edit', 'fill'];
  $('#filewrap').classList.toggle('hidden', !fileModes.includes(f.mode.value));
  f.noBackup.closest('label').classList.toggle('hidden', !['edit', 'fill'].includes(f.mode.value));
  schedulePreview();
  clearTimeout(saveT);
  saveT = setTimeout(() => api('/api/settings', state()), 400);
}

function setRunning(on) {
  running = on;
  $('#run').disabled = on; $('#stop').disabled = !on;
  $('#status').textContent = on ? 'running…' : 'idle';
  $('#stdin').disabled = !on; $('#send').disabled = !on;
  if (!on) setPhase('');
}

const out = $('#out');
function append(type, text) {
  if (!text) return;
  const span = document.createElement('span');
  span.className = type; span.textContent = text;
  out.appendChild(span);
  if ($('#autoscroll').checked) out.scrollTop = out.scrollHeight;
}

// Turn the streamed session log into a short "what is happening now" label.
// Ordered: first matching rule wins, so specific messages come before generic ones.
const PHASE_RULES = [
  [/i'?m not a robot|human check/i, 'waiting — complete the human check in Chrome'],
  [/not logged into|please log in/i, 'waiting — log in to the chat in Chrome'],
  [/click once inside the chat input/i, 'waiting — click the chat input box'],
  [/killing stale Chrome|debug port/i, 'opening Chrome…'],
  [/launched Chrome|Adjust the chat settings/i, 'Chrome open — adjust settings'],
  [/waiting \d+s before starting/i, 'starting shortly…'],
  [/seeding context/i, 'sending your file to the AI…'],
  [/message sent|waiting for the AI reply/i, 'waiting for the AI to reply…'],
  [/reply detected|context seeded/i, 'reading the AI reply…'],
  [/parse error|invalid ops|refusal|re-priming|did not contain a valid/i, 'fixing a bad AI reply…'],
  [/applied op\[|\d+ ops? applied/i, 'applying edits to your file…'],
  [/backup: \S/i, 'edit applied'],
  [/allow .*\[y\/N\]/i, 'waiting — approve a command in the input box'],
  [/agent ready|Type instructions|watch mode|agent watch mode/i, 'ready — type your request below'],
  [/process exited/i, 'finished'],
];
function setPhase(text) {
  const el = $('#phase');
  el.className = ''; // reset tone classes
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text;
  if (/fixing a bad/.test(text)) el.classList.add('err');
  else if (/waiting|starting shortly|opening/.test(text)) el.classList.add('warn');
  else if (/finished|edit applied|ready/.test(text)) el.classList.add('ok');
}
function classifyPhase(chunk) {
  if (!running) return;
  for (const [re, label] of PHASE_RULES) if (re.test(chunk)) { setPhase(label); return; }
}

const es = new EventSource('/api/stream?token=' + encodeURIComponent(GUI_TOKEN));
es.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  append(m.type, m.text);
  if (m.type === 'exit') { setRunning(false); setPhase('finished'); }
  // session output only: the user's own typed lines ('in') and 'sys' notes
  // must not flip the phase (typing "parse error" is not the AI failing)
  else if (m.type === 'out' || m.type === 'err') classifyPhase(m.text);
};

$('#run').onclick = async () => {
  out.textContent = ''; // clear before starting so the echoed command isn't wiped
  setRunning(true);
  setPhase('starting…');
  let r;
  try { r = await api('/api/run', state()); }
  catch (e) { setRunning(false); return append('err', 'cannot reach the GUI server: ' + e.message + '\n'); }
  if (!r.ok) { setRunning(false); return append('err', r.error + '\n'); }
};
$('#stop').onclick = () => api('/api/stop');
$('#quitbtn').onclick = async () => { await api('/api/quit'); document.body.innerHTML = '<p style="padding:2em">chat-window-agent has shut down — you can close this window.</p>'; };
$('#clearbtn').onclick = () => { out.textContent = ''; };
$('#copybtn').onclick = async () => {
  const txt = $('#preview').textContent || '';
  const btn = $('#copybtn');
  try { await navigator.clipboard.writeText(txt); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Select & copy'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
};
// Ctrl/Cmd+Enter anywhere runs the session (unless already running)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !running) $('#run').click();
});
function sendInput() {
  const el = $('#stdin');
  if (!el.value) return;
  api('/api/input', { line: el.value });
  el.value = '';
}
$('#send').onclick = sendInput;
$('#stdin').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendInput(); });
function addEv(p) {
  const div = document.createElement('div');
  div.innerHTML = '<span></span><a>✕</a>';
  const span = div.querySelector('span');
  span.textContent = p;
  span.dataset.p = p;
  div.querySelector('a').onclick = () => { div.remove(); changed(); };
  $('#evlist').appendChild(div);
}
const DOC_EXTS_ALL = ['docx', 'xlsx', 'xlsm', 'pdf', 'csv', 'txt', 'md'];
$('#browse').onclick = async () => {
  const mode = f.mode.value;
  const exts = mode === 'fill' ? ['docx'] : mode === 'edit' ? ['docx', 'xlsx', 'xlsm'] : DOC_EXTS_ALL;
  const r = await api('/api/pick', { multi: false, exts });
  if (r.files && r.files[0]) { f.file.value = r.files[0]; changed(); }
};
$('#addev').onclick = async () => {
  const r = await api('/api/pick', { multi: true, exts: DOC_EXTS_ALL });
  for (const p of r.files || []) addEv(p);
  changed();
};
// in-page folder browser (no native dialog — works however the GUI was launched)
let fmPath = '';
async function fmShow(p) {
  const r = await api('/api/browse' + (p ? '?path=' + encodeURIComponent(p) : ''));
  if (r.error) { append('err', r.error + String.fromCharCode(10)); return; }
  fmPath = r.path;
  $('#fmpath').textContent = r.path ? r.path + (r.docs ? ' — ' + r.docs + ' document(s) directly inside' : ' — no documents directly inside') : 'This computer — pick a drive';
  const list = $('#fmlist');
  list.innerHTML = '';
  if (!r.dirs.length) list.innerHTML = '<div class="help" style="padding:6px">(no subfolders)</div>';
  for (const d of r.dirs) {
    const div = document.createElement('div');
    div.className = 'fmdir';
    div.textContent = '📁 ' + d;
    div.onclick = () => fmShow(r.path ? r.path + '/' + d : d);
    list.appendChild(div);
  }
  $('#fmup').disabled = !r.parent;
  $('#fmup').onclick = () => fmShow(r.parent || '');
  $('#fmselect').disabled = !r.path;
}
$('#addevfolder').onclick = () => { $('#foldermodal').classList.remove('hidden'); fmShow(''); };
$('#fmcancel').onclick = () => $('#foldermodal').classList.add('hidden');
$('#fmselect').onclick = () => {
  if (fmPath) { addEv(fmPath); changed(); }
  $('#foldermodal').classList.add('hidden');
};

function setOptions(selector, items, firstLabel) {
  const sel = $(selector);
  sel.replaceChildren();
  if (firstLabel !== undefined) {
    const first = document.createElement('option');
    first.value = '';
    first.textContent = firstLabel;
    sel.appendChild(first);
  }
  for (const item of items) {
    const o = document.createElement('option');
    o.value = item.value;
    if (item.label !== undefined) o.textContent = item.label;
    sel.appendChild(o);
  }
}

function renderProviders(list) {
  setOptions('#provider', list.map((p) => ({ value: p.name, label: p.label + (p.local ? ' (offline)' : '') })));
}
$('#addprov').onclick = () => $('#provform').classList.toggle('hidden');
$('#psave').onclick = async () => {
  const r = await api('/api/provider/custom', { url: $('#purl').value.trim(), name: $('#pname').value.trim(), plain: $('#pplain').checked, simple: $('#psimple').checked, delay: +$('#pdelay').value || 0 });
  if (!r.ok) return append('err', 'custom provider: ' + r.error + String.fromCharCode(10));
  const opts = await api('/api/options');
  providers = opts.providers;
  renderProviders(providers);
  f.provider.value = r.name;
  $('#provform').classList.add('hidden');
  append('sys', 'saved provider "' + r.name + '" — select it above; run mode "doctor" on it if the chat UI is unusual\n');
  changed();
};

(async function init() {
  const [opts, saved] = await Promise.all([api('/api/options'), api('/api/settings')]);
  providers = opts.providers;
  renderProviders(providers);
  setOptions('#remotesel', opts.providers.filter((p) => !p.local).map((p) => ({ value: p.name, label: p.label })), '(default)');
  setOptions('#modelsel', opts.models.map((m) => ({ value: 'models/' + m, label: m })), '(default)');
  setOptions('#docs', opts.docs.map((d) => ({ value: d })));
  for (const [k, v] of Object.entries(saved)) {
    const el = f.elements[k];
    if (!el || k === 'against') continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  // default: local AI runs alongside whenever a model is downloaded (user can untick)
  if (!('withLocal' in saved) && opts.models.length) f.withLocal.checked = true;
  for (const p of saved.against || []) addEv(p);
  f.addEventListener('input', changed);
  changed();
})();
