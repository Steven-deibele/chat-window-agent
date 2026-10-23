import { scrub, redactionSummary } from '../src/scrub.js';
const dirty = [
  'My openai key is sk-abc123def456ghi789jkl0 and token ghp_abcdefghijklmnopqrstuvwxyz123456.',
  'Email steve@example.com from C:\\Users\\steve\\secret\\plan.txt, server 10.1.2.3 (not 127.0.0.1).',
  'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlZg and aws AKIAIOSFODNN7EXAMPLE.',
  'config: api_key = "supersecretvalue123", password: hunter2password',
].join('\n');
const { text, redactions } = scrub(dirty);
console.log('--- scrubbed ---');
console.log(text);
console.log('--- summary ---');
console.log(redactionSummary(redactions));
const leaked = ['sk-abc123', 'ghp_abc', 'steve@example.com', '10.1.2.3', 'AKIAIOS', 'supersecretvalue123', 'hunter2', 'steve\\secret']
  .filter((s) => text.includes(s));
console.log(leaked.length ? `LEAKED: ${leaked.join(', ')}` : 'no leaks');
if (leaked.length || !text.includes('127.0.0.1')) process.exit(1);
