// Security checks for the HTTP tool URL guard. Run: node test/security.mjs
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { assertFetchable, registry } from '../src/tools/registry.js';
import { makeSelfSigned } from './fixtures/selfsigned.mjs';

assert.throws(() => assertFetchable('file:///C:/Windows/win.ini'), /scheme/);
assert.throws(() => assertFetchable('http://metadata.google.internal./'), /metadata/);
assert.throws(() => assertFetchable('http://[::ffff:169.254.169.254]/'), /link-local/);
assert.throws(() => assertFetchable('http://[fe80::1]/'), /link-local/);
assert.throws(() => assertFetchable('http://0.0.0.0/'), /link-local/, 'unspecified IPv4 (loopback alias on some stacks) blocked');
assert.throws(() => assertFetchable('http://0.1.2.3/'), /link-local/, 'whole 0.0.0.0/8 "this host" block rejected, not just 0.0.0.0');
assert.throws(() => assertFetchable('http://[::]/'), /link-local/, 'unspecified IPv6 blocked');
assert.throws(() => assertFetchable('http://user:pass@example.com/'), /credentials/, 'URL userinfo rejected instead of silently dropped');
assert.equal(assertFetchable('https://example.com/').protocol, 'https:');

// Ephemeral self-signed key/cert generated per run — no private key is committed.
const { key: TLS_KEY, cert: TLS_CERT } = makeSelfSigned();

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

const server = http.createServer((req, res) => {
  if (req.url === '/redirect-blocked-v4') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
    return res.end();
  }
  if (req.url === '/redirect-blocked-v6') {
    res.writeHead(302, { location: 'http://[::ffff:169.254.169.254]/' });
    return res.end();
  }
  if (req.url === '/redirect-ok') {
    res.writeHead(302, { location: '/ok' });
    return res.end();
  }
  if (req.url === '/redirect-self') {
    // same-origin path redirect: loopback-judged env headers still resolve to
    // loopback on the second hop and must survive
    res.writeHead(302, { location: '/echo-headers' });
    return res.end();
  }
  if (req.url === '/303-a') {
    res.writeHead(303, { location: '/303-b' });
    return res.end();
  }
  if (req.url === '/303-b') {
    res.writeHead(303, { location: '/echo-headers' });
    return res.end();
  }
  if (req.url === '/echo-headers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(req.headers));
  }
  if (req.url === '/redirect-cross-origin') {
    // same server, different origin (different port) — credential headers
    // must be stripped when following this redirect
    res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/echo-headers` });
    return res.end();
  }
  if (req.url === '/zipbomb') {
    // 30MB of zeroes compresses to ~30KB on the wire; zlib's maxOutputLength
    // must reject while decoding, before the 30MB expansion is materialized.
    const big = Buffer.alloc(30 * 1024 * 1024, 0);
    const gz = zlib.gzipSync(big);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' });
    return res.end(gz);
  }
  if (req.url === '/zipbomb-deflate') {
    // the deflate fallback to inflateRawSync must not swallow the size guard
    const big = Buffer.alloc(30 * 1024 * 1024, 0);
    const df = zlib.deflateSync(big);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'deflate' });
    return res.end(df);
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
let otherPort = 0;
const other = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.headers));
});
await new Promise((r) => other.listen(0, '127.0.0.1', r));
otherPort = other.address().port;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// POST retry regression: make the first resolved localhost family consume the
// body and drop the connection; the second family must remain untouched.
const localhostAddrs = await dns.promises.lookup('localhost', { all: true, verbatim: true });
const hasV4 = localhostAddrs.some((a) => a.family === 4);
const hasV6 = localhostAddrs.some((a) => a.family === 6);
let firstHits = 0, secondHits = 0;
let retryV4 = null, retryV6 = null;
if (hasV4 && hasV6) {
  const firstFamily = localhostAddrs[0].family;
  const firstHandler = (req) => {
    req.resume();
    req.on('end', () => { firstHits++; req.socket.destroy(); });
  };
  const secondHandler = (req, res) => {
    req.resume();
    req.on('end', () => { secondHits++; res.end('duplicate'); });
  };
  retryV4 = http.createServer(firstFamily === 4 ? firstHandler : secondHandler);
  retryV6 = http.createServer(firstFamily === 6 ? firstHandler : secondHandler);
  const retryPort = await freePort();
  await new Promise((r, rej) => { retryV6.once('error', rej); retryV6.listen(retryPort, '::1', r); });
  await new Promise((r, rej) => { retryV4.once('error', rej); retryV4.listen(retryPort, '127.0.0.1', r); });
  retryV4.testUrl = `http://localhost:${retryPort}/submit`;
}

const fetchTool = await registry.get('http.fetch');
try {
  const ok = await fetchTool.run({ url: base + '/ok' });
  assert.match(ok, /HTTP 200/, 'validated local fetch works');
  const redirected = await fetchTool.run({ url: base + '/redirect-ok' });
  assert.match(redirected, /HTTP 200/, 'validated redirects still work');
  await assert.rejects(fetchTool.run({ url: base + '/redirect-blocked-v4' }), /link-local/, 'redirects to IPv4 metadata are blocked');
  await assert.rejects(fetchTool.run({ url: base + '/redirect-blocked-v6' }), /link-local/, 'redirects to mapped IPv6 metadata are blocked');
  await assert.rejects(fetchTool.run({ url: base + '/zipbomb' }), /after decoding/, 'gzip bombs are rejected by the decoded-size limit');
  await assert.rejects(fetchTool.run({ url: base + '/zipbomb-deflate' }), /after decoding/, 'deflate bombs are rejected by the decoded-size limit');

  // credential headers must not follow a redirect to another origin
  const requestTool = await registry.get('http.request');
  process.env.WH_TEST_SECRET = 'secret-value';
  let redirectPrompts = 0;
  const leaked = await requestTool.run(
    {
      url: base + '/redirect-cross-origin',
      headers: {
        authorization: 'Bearer secret',
        'x-acme-token': 'env:WH_TEST_SECRET',
        'x-keep': 'yes',
      },
    },
    { confirm: async () => { redirectPrompts++; return true; } },
  );
  const seen = JSON.parse(leaked.slice(leaked.indexOf('\n') + 1));
  assert.equal(seen.authorization, undefined, 'authorization stripped on cross-origin redirect');
  assert.equal(seen['x-acme-token'], undefined, 'custom env-backed headers stripped on cross-origin redirect');
  assert.equal(seen['x-keep'], 'yes', 'non-credential headers preserved');
  assert.equal(redirectPrompts, 1, 'cross-origin env redirect requires a decision');

  // denying a redirect must say so, not return the server's 3xx body
  const deniedRedirect = await requestTool.run(
    { url: base + '/redirect-cross-origin', headers: { 'x-acme-token': 'env:WH_TEST_SECRET' } },
    { confirm: async () => false },
  );
  assert.match(deniedRedirect, /DENIED by user/, 'a denied redirect is reported as a denial');

  // env: headers to a target that RESOLVES to loopback need no approval —
  // judged by resolved addresses, not the hostname string
  let loopbackPrompts = 0;
  const local = await requestTool.run(
    { url: base + '/echo-headers', headers: { 'x-acme-token': 'env:WH_TEST_SECRET' } },
    { confirm: async () => { loopbackPrompts++; return true; } },
  );
  assert.equal(loopbackPrompts, 0, 'loopback env-header GET skips approval');
  assert.equal(JSON.parse(local.slice(local.indexOf('\n') + 1))['x-acme-token'], 'secret-value', 'env header reaches the loopback target');
  const byName = await requestTool.run(
    { url: `http://localhost:${server.address().port}/echo-headers`, headers: { 'x-acme-token': 'env:WH_TEST_SECRET' } },
    { confirm: async () => { loopbackPrompts++; return true; } },
  );
  assert.equal(loopbackPrompts, 0, 'localhost (resolving to loopback) env-header GET skips approval');
  assert.match(byName, /HTTP 200/, 'localhost fetch succeeds');

  // a missing env var must fail loudly — silently sending an empty
  // credential header would change server semantics and hide the typo
  await assert.rejects(
    requestTool.run(
      { url: base + '/echo-headers', headers: { 'x-acme-token': 'env:WH_TEST_MISSING_VAR' } },
      { confirm: async () => true },
    ),
    /env var "WH_TEST_MISSING_VAR" is not set/,
    'missing env vars are rejected instead of sending an empty header',
  );

  // a caller-supplied Host header must never reach the wire
  const hostSpoof = await requestTool.run(
    { url: base + '/echo-headers', headers: { host: 'evil.example.com' } },
    { confirm: async () => true },
  );
  assert.equal(JSON.parse(hostSpoof.slice(hostSpoof.indexOf('\n') + 1)).host, `127.0.0.1:${server.address().port}`, 'spoofed Host header is replaced by the target-derived one');

  // same-origin path redirect: the second hop re-resolves (still loopback), so
  // an approval-skipped env header must survive — no prompt, header intact
  const selfRedirect = await requestTool.run(
    { url: base + '/redirect-self', headers: { 'x-acme-token': 'env:WH_TEST_SECRET' } },
    { confirm: async () => { loopbackPrompts++; return true; } },
  );
  assert.equal(loopbackPrompts, 0, 'same-origin loopback redirect needs no approval');
  assert.equal(JSON.parse(selfRedirect.slice(selfRedirect.indexOf('\n') + 1))['x-acme-token'], 'secret-value', 'env header survives a same-origin loopback redirect');

  // a 303 converts POST to GET after the first hop: the mutating-method
  // redirect prompt must fire only for the hop that is still a POST
  let chainPrompts = 0;
  const chain = await requestTool.run(
    { url: base + '/303-a', method: 'POST', body: 'x' },
    { confirm: async () => { chainPrompts++; return true; } },
  );
  assert.match(chain, /HTTP 200/, '303 chain completes');
  assert.equal(chainPrompts, 2, 'POST approval + one mutating redirect prompt (the GET hop does not prompt)');

  // A server may consume a mutating request before dropping the connection;
  // trying the next DNS address would apply it twice.
  if (retryV4) {
    await assert.rejects(
      requestTool.run(
        { url: retryV4.testUrl, method: 'POST', body: 'charge' },
        { confirm: async () => true },
      ),
      'POST must fail instead of retrying after the first address consumed it',
    );
    assert.equal(firstHits, 1, 'first address consumed the POST');
    assert.equal(secondHits, 0, 'second address must not receive the POST');
  }

  // HTTPS must never silently downgrade to HTTP, even for the same host.
  const oldTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // test-only self-signed fixture
  const tls = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    res.writeHead(302, { location: `${base}/echo-headers` });
    res.end();
  });
  await new Promise((r) => tls.listen(0, '127.0.0.1', r));
  try {
    let downgradePrompts = 0;
    await assert.rejects(
      requestTool.run(
        { url: `https://127.0.0.1:${tls.address().port}/start`, headers: { 'x-acme-token': 'env:WH_TEST_SECRET' } },
        { confirm: async () => { downgradePrompts++; return true; } },
      ),
      /insecure redirect/,
      'HTTPS to HTTP redirects are rejected before credentials can move',
    );
    assert.equal(downgradePrompts, 0, 'downgrade is rejected without an approval bypass');
  } finally {
    tls.close();
    if (oldTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = oldTlsReject;
  }
} finally {
  server.close();
  other.close();
  retryV4?.close();
  retryV6?.close();
}
console.log('HTTP security checks: ok');
