# chat-window-agent

Edit **Word (.docx)** and **Excel (.xlsx)** files using an AI chat **that has no API** — the tool drives the real chat window in Chrome (ChatGPT / Claude / Gemini, your logged-in session), reads the AI's replies, and applies structured edit operations to your files. It can also **read Word/Excel/PDF/CSV documents as evidence and fill out a Word compliance checklist** from them.

## How it works

```
 you (terminal, or the browser chat itself in --watch mode)
   │
   ▼
 Chrome chat window  ←── typed into by chat-window-agent via CDP (no API keys)
   │  AI replies with {"ops":[...]} JSON
   ▼
 chat-window-agent parses + validates the ops
   │
   ▼
 .docx / .xlsx edited in place (timestamped backups in backups/)
```

**No file path needed** — if you omit the file argument, a picker opens: the native
Windows/macOS/Linux file dialog, or a numbered list of recent files in the terminal.
In `fill` mode you're also asked to select the evidence documents (multi-select;
type `all` in the list to review everything found). `--against <folder>` adds every
supported document in a directory.

- Chrome is launched once with a dedicated debugging profile (`.chrome-profile/`); **log into your AI chat in that window once** and the session persists.
- The first message of the chat is seeded with a snapshot of your file (paragraph indices, table grids, sheet/cell coordinates) plus the exact ops contract. The AI must reference only those coordinates.
- Every AI reply is parsed for one ```json block; invalid or failing ops trigger an automatic `TOOL FEEDBACK` message so the AI corrects itself (up to `--max-retries`).
- Sources (`--against`) are attached read-only: .docx, .xlsx, .pdf (text-based; no OCR), .csv, .txt, .md.

# Usage

```
run.bat                # agent chat (default) — general-purpose AI agent REPL
run.bat agent [files] [--ask "goal"] [--yes] [--max-steps N]
run.bat edit  [file]   # focused document editing (file picker if omitted)
run.bat fill  [docx]   # compliance checklist review against evidence docs
run.bat calibrate      # teach it your company's custom chat UI
run.bat rename <old> <new>   # rename a saved custom provider

Input hardening: decoy fields (footer newsletter/search/email boxes) are skipped
when picking the chat input; the real input is scrolled into view and focused
before typing, so fixed footers never swallow the click. DeepSeek ships with the
correct chat URL (chat.deepseek.com — the landing page composer is a trap).
```

The default is a **conversational agent** (like pi agent): `run.bat` drops you into
`agent>` where every message triggers an autonomous tool loop — explore files, run
commands, fetch URLs, edit documents, and **write new tools** when a capability is
missing. Documents are just one skill among many:

```
agent> find every xlsx bigger than 50KB and summarize their sheets
agent> /file budget.xlsx
agent> fix the totals and flag anomalies in a note
```

In the REPL: `/tools` lists tools, `/file <path>` attaches a document snapshot,
`/compress` summarizes the session and restarts the chat with that summary (for
long sessions nearing the AI's context limit), `/clear` starts a fresh chat with
no handoff, `exit` quits. Sessions also auto-compress once they grow past
`WH_COMPRESS_AT` chars (default 100000). `--ask "..."` runs one goal
non-interactively; `--yes` skips the [y/N] gate on `shell.run`/`fs.write`.

Flags:

| flag | meaning |
|---|---|
| `--provider chatgpt\|claude\|gemini\|mock` | which chat site to drive (omitted + interactive terminal → a chooser menu, incl. **Custom…** for any chat URL — it asks for URL + name, uses generic selectors, and saves to  for next time) |
| `--url <url>` | use/override the chat URL (also picks the tab; host must match) |
| `--ask "..."` | run one instruction non-interactively |
| `--watch` | you type in the **browser chat**; the tool applies every AI reply |
| `--against <file>` | read-only evidence document (repeatable) |
| `--no-backup` | skip backups |
| `--max-retries N` | self-correction rounds (default 3) |
| `--timeout ms` | AI reply wait timeout |
| `--delay N` | wait N seconds after the chat opens before the first message — time to adjust model/settings in the chat window |
| `--pause` | same, but waits for you to press Enter instead of a fixed time |
| `--plain` | neutral "planning component" framing for preset/corporate AIs that refuse the agent role (or `"plain": true` in providers.json) |
| `--simple` | simplified protocol for weaker models: one tool per reply, short rules, a worked example (or `"simple": true` in providers.json) |

Startup UX:

- No `--provider` and an interactive terminal → **menu asking which AI chat window to drive** (ChatGPT / Claude / Gemini / …).
- If the chat shows a login wall, the tool prints *"please log in inside the Chrome window…"* and waits (up to 10 min), then continues automatically.
- After each send it prints `message sent — waiting for the AI reply…` plus a 15 s heartbeat, so a slow reply never looks like a hang. A message stuck in the composer retries with Enter before failing loudly.

```
node src/app.js edit report.docx
you> replace "DRAFT" with "FINAL" everywhere and add a closing paragraph

node src/app.js edit budget.xlsx --ask "add a row for 'Marketing' with Q1..Q4 values and re-total"

node src/app.js fill vendor-checklist.docx --against policy.pdf --against training-matrix.xlsx

node src/app.js fill vendor-checklist.docx --against policy.pdf --watch   # then chat in Chrome
```

## Agent mode — tools that build tools

```
run.bat agent budget.xlsx --ask "fix the totals, then produce a summary of anomalies"
```

The AI runs an autonomous step loop through the chat: each reply is one action —
`{"action":"tool","tool":"<name>","args":{...}}` or `{"action":"final",...}` —
or a batch of up to 5 independent tool calls in a single reply,
`{"action":"tools","calls":[{...}, ...]}` (one chat roundtrip instead of many).
With `--watch` you don't use the terminal at all: type your requests directly in
the chat window; the harness detects them (needs "user" selectors on the
provider — set for chatgpt/claude/gemini/mock/qwen; add yours in providers.json),
runs the tool calls, posts TOOL_RESULTs back into the chat, and prints the final
summary in the terminal. Ctrl+C to stop.

Built-in tools: `docs.snapshot` / `docs.apply_ops` / `docs.ops_spec` (Word/Excel),
`fs.read` / `fs.list` / `fs.find` / `fs.search` / `fs.write` / `fs.download`,
`shell.run`, `http.fetch`, `http.request` (any REST API — headers may read tokens
from env vars via `"env:VARNAME"`, e.g. Azure DevOps/Agile, Jira), and
`ui.pick_files` (native file-explorer dialog so the agent can ask *you* which file),
`agent.spawn` (parallel sub-agents in new tabs).

**Sub-agents** — for large tasks the agent can call `agent.spawn` with
`{"tasks":[...]}`: each subtask runs in a **new browser tab with its own fresh
chat**, in parallel (max 4), with the same tool set. Each sub-agent reports a
final summary back as the parent's tool result, and its tab closes when done.
Sub-agents cannot spawn further sub-agents.

**Self-modification** — the agent extends itself with `tools.create`: it writes a
new tool as JS, it is hot-loaded instantly and **persists in `tools/`** for every
future run (e.g. "create a tool that pulls work items from our Agile board").
That is the supported way to add capabilities. It *can* also edit its own source
in `src/` via `fs.write`/`shell.run` (approval-gated), but harness changes need a
restart — prefer `tools/`.

Dangerous actions (`shell.run`, `fs.write`, `fs.download`, non-GET `http.request`)
ask for terminal approval unless `--yes`.

## Company / custom AI chat windows

For a company-made chat UI (internal LLM gateway etc.):

```
run.bat calibrate
```

Pick **Custom…** in the chooser, enter your chat URL (and log in when prompted).
Then send any short message in the chat window — the tool watches the live DOM
(iframe-aware), finds the AI's answer, derives a stable selector for assistant
messages, and saves it to `providers.json`. Your company chat is now a fully
supported provider (`--provider <name>`). Re-run `doctor --provider <name>` any
time the UI changes.

One chat tab per session: the tool **pins the browser tab** it started with and
keeps sending there even when the chat rewrites its URL (conversation links,
redirects). If the tab is closed, it re-attaches to another tab on the same site
instead of opening a new window — your conversation context is never silently
duplicated. Rename saved providers with `run.bat rename <old> <new>`.

When you create a provider via **Custom…**, the setup also asks three behavior
questions — neutral framing for preset AIs (`plain`), simplified protocol for
weaker models (`simple`), and a startup delay so you can adjust chat settings
before the first message. Change them any time with:

```
run.bat config            # pick a saved provider, answer y/n + delay (Enter keeps current)
run.bat config <name>     # skip the picker
```

### Preset AIs that refuse ("I don't have access to that file…")

Company chat AIs often ship with a fixed persona that insists it cannot touch
local files, so it rejects the agent role before reading the task. Two
countermeasures:

- **`--plain` flag** (or `"plain": true` for that provider in `providers.json`)
  rewrites the system preamble in neutral terms: the AI is a *planning
  component* that never accesses anything itself — all content is provided in
  the chat, and the user's own authorized program executes its JSON plan
  steps. Nothing to refuse.
- If a refusal still slips through, the harness **detects it and re-primes
  automatically** (up to twice per turn) instead of abandoning the task.

If your company chat has a custom-instructions/system-prompt field, pasting
the neutral framing there makes it stick for the whole conversation.

### Fixed system prompts that override the harness

A built-in system prompt always outranks user messages, so the harness fights
drift instead of fighting priority:

- **Protocol handshake**: the first exchange asks for a one-word json ack. If
  the chat can't follow the protocol even once, you get a loud warning with
  concrete fixes *before* your real task is wasted.
- **Sticky protocol footer**: with `plain` or `simple` enabled, every
  TOOL_RESULT ends with a compact protocol reminder — the instruction is
  always the most recent thing the model reads, which beats persona drift.
- **UI-level fixes** (best when available): use `--pause`/`--delay` to switch
  to a less-restricted model, disable a custom persona, or paste the protocol
  into the chat's own instructions/project field — a system-level slot beats
  any repetition the harness can do.

## No-admin install (work computers)

Everything is user-level: dependencies install into this folder (`npm install`),
Chrome/Edge is driven through a dedicated profile in `.chrome-profile/`, no
services, no registry writes, no admin.

1. Get the code onto the work machine: `git clone https://github.com/\<you\>/chat-window-agent.git`, or copy this folder as-is.
2. If Node.js is missing/not allowed to install: download the Node.js **zip**
   ("Binary" download, not the installer) and extract it into `node-portable\`
   inside this folder.
3. Run `run.bat` — it bootstraps dependencies and starts the app, using the
   portable Node when present. Corporate proxy? set `HTTPS_PROXY` before step 3.

## Ops the AI can emit

docx: `replace_text`, `insert_paragraph`, `delete_paragraph`, `set_paragraph_style`, `format_paragraph`, `set_table_cell`, `append_table_row`, `insert_table_row`
xlsx: `set_cell` (value/formula), `insert/delete rows/cols` (formula refs are adjusted Excel-style), `set_format`, `add/rename/delete_sheet`, `set_col_width`, `set_row_height`, `merge/unmerge`, `freeze`

Checklists using `☐` glyphs are marked by `replace_text` (`☐`→`☒`); table checklists via `set_table_cell` on the Status column.

## Providers & selectors

Selectors live in `src/providers.js` and can be overridden per provider in a `providers.json` in the working directory (arrays replace, scalars override) — chat sites change their DOM now and then:

```json
{ "chatgpt": { "input": ["#prompt-textarea", "#my-new-selector"] } }
```

If a site stops working, run `node src/app.js doctor --provider chatgpt` — it reports which selectors match the open page. Verified live: ChatGPT (guest composer + send button); Claude/Gemini use best-known selectors and are config-overridable.

## Local demo / tests (no real AI needed)

```
node mock/server.js                 # fake AI chat on http://127.0.0.1:8123
node samples/make_samples.mjs       # writes test-files/ (checklist.docx, Budget.xlsx, Policy.pdf)
node src/app.js edit test-files/Budget.xlsx --provider mock --url http://127.0.0.1:8123/ --ask "BUDGET update"
node test/verify.mjs budget         # asserts the resulting file
```

Scenarios: `budget`, `hello` (docx), `fill`, `retry` (bad-JSON self-correction), `watch` (`?scenario=watch` auto-sends from the page).

## Notes & limits

- `.docx` edits touch only `word/document.xml` text runs (formatting preserved; headers/footers not searched).
- `.xlsx` round-trips via exceljs: pivot charts/images may be dropped — keep backups (automatic).
- PDF text extraction only; scanned PDFs need OCR first.
- Long chats: each session seeds one new conversation; snapshots are truncated (~20k chars/file).
- Long messages are inserted atomically (insertText → clipboard paste → Shift+Enter keystrokes) so chat UIs never split them into partial sends.
- Chrome updates sometimes leave a zombie Chrome holding the profile; the launcher detects a dead debug port, kills the stale instance, and relaunches automatically.
