// scrub.js — redact sensitive data from text BEFORE it leaves the machine.
// Single choke point for anything sent to a cloud AI chat: API keys, tokens,
// emails, IPs, user paths, private keys. Users add their own literal/regex
// rules in scrub-rules.json (cwd or app root):
//   [ { "pattern": "AcmeCorp", "replacement": "<COMPANY>" },
//     { "regex": "PROJ-\\d+", "replacement": "<TICKET>" } ]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Built-in rules, applied in order. Each: label, regex (global), replacement. */
const BUILTIN = [
  ['PRIVATE-KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<PRIVATE-KEY>'],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<JWT>'],
  ['OPENAI-KEY', /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, '<API-KEY>'],
  ['GITHUB-TOKEN', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, '<GITHUB-TOKEN>'],
  ['AWS-KEY', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<AWS-KEY>'],
  ['SLACK-TOKEN', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<SLACK-TOKEN>'],
  ['GOOGLE-KEY', /\bAIza[A-Za-z0-9_-]{30,}/g, '<GOOGLE-KEY>'],
  ['BEARER', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer <TOKEN>'],
  ['GENERIC-SECRET', /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["']?[^\s"'}{,]{8,}/gi, (m) => m.replace(/[:=]\s*["']?[^\s"'}{,]{8,}/, '= <SECRET>')],
  ['EMAIL', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<EMAIL>'],
  ['IPV4', /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>'],
  ['USER-PATH', /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+/g, '$1<USER>'],
  ['HOME-PATH', /\/home\/[^/\s]+/g, '/home/<USER>'],
];

function loadUserRules(log) {
  const file = [path.join(process.cwd(), 'scrub-rules.json'), path.join(APP_ROOT, 'scrub-rules.json')]
    .find((p) => fs.existsSync(p));
  if (!file) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('expected an array');
    return raw.map((r, i) => {
      const replacement = String(r.replacement ?? '<REDACTED>');
      if (r.regex) return { label: `custom-${i}`, re: new RegExp(r.regex, r.flags || 'g'), replacement };
      if (r.pattern) {
        const lit = String(r.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { label: `custom-${i}`, re: new RegExp(lit, 'gi'), replacement };
      }
      throw new Error(`rule ${i} needs "pattern" or "regex"`);
    });
  } catch (e) {
    log?.(`scrub-rules.json ignored: ${e.message}`);
    return [];
  }
}

/** Redact sensitive content. Returns { text, redactions: {label: count} }. */
export function scrub(input, { log } = {}) {
  let text = String(input);
  const redactions = {};
  const apply = (label, re, replacement) => {
    text = text.replace(re, (...a) => {
      redactions[label] = (redactions[label] || 0) + 1;
      if (typeof replacement === 'function') return replacement(...a);
      // String replacements arrive via this counting wrapper, so expand
      // $1..$9 group references ourselves.
      return replacement.replace(/\$(\d)/g, (_, n) => a[+n] ?? '');
    });
  };
  for (const [label, re, replacement] of BUILTIN) apply(label, re, replacement);
  for (const { label, re, replacement } of loadUserRules(log)) apply(label, re, replacement);
  return { text, redactions };
}

/** One-line stderr summary of what was redacted (empty string if nothing). */
export function redactionSummary(redactions) {
  const parts = Object.entries(redactions).map(([k, n]) => `${k}×${n}`);
  return parts.length ? `scrubbed: ${parts.join(', ')}` : '';
}
