// Minimal self-signed X.509 generator for tests, so no private key is ever
// committed to the repo. Builds the DER by hand (Node has no certificate-
// creation API) and signs with crypto. Intended ONLY for the ephemeral
// 127.0.0.1 TLS server in test/security.mjs — never for production.
import crypto from 'node:crypto';

function tlv(tag, content) {
  const len = content.length;
  let lenBuf;
  if (len < 0x80) lenBuf = Buffer.from([len]);
  else {
    const bytes = [];
    for (let n = len; n > 0; n >>>= 8) bytes.unshift(n & 0xff);
    lenBuf = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBuf, content]);
}
const seq = (...p) => tlv(0x30, Buffer.concat(p));
const setOf = (...p) => tlv(0x31, Buffer.concat(p));
const nullTag = () => Buffer.from([0x05, 0x00]);
const octet = (buf) => tlv(0x04, buf);
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const ctx = (n, content) => tlv(0xa0 | n, content);

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const enc = [];
    let n = part;
    do { enc.unshift(n & 0x7f); n >>>= 7; } while (n > 0);
    for (let i = 0; i < enc.length - 1; i++) enc[i] |= 0x80;
    bytes.push(...enc);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(n) {
  const bytes = [];
  let v = BigInt(n);
  do { bytes.unshift(Number(v & 0xffn)); v >>= 8n; } while (v > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0); // keep positive
  return tlv(0x02, Buffer.from(bytes));
}

function utcTime(d) {
  const p = (x) => String(x).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function toPem(label, der) {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** @returns {{key: string, cert: string}} PEM-encoded RSA key + self-signed cert. */
export function makeSelfSigned({ commonName = 'localhost', altIP = '127.0.0.1' } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const algId = seq(oid('1.2.840.113549.1.1.11'), nullTag()); // sha256WithRSAEncryption
  const name = seq(setOf(seq(oid('2.5.4.3'), utf8(commonName)))); // CN=commonName
  const now = Date.now();
  const validity = seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 24 * 3600_000)));
  const san = seq(
    oid('2.5.29.17'),
    octet(seq(tlv(0x82, Buffer.from(commonName, 'ascii')), tlv(0x87, Buffer.from(altIP.split('.').map(Number))))),
  );
  const tbs = seq(
    ctx(0, integer(2)), // version v3
    integer(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`)),
    algId,
    name,
    validity,
    name,
    spki,
    ctx(3, seq(san)), // extensions [3] EXPLICIT SEQUENCE OF Extension
  );
  const cert = seq(tbs, algId, bitString(crypto.sign('sha256', tbs, privateKey)));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: toPem('CERTIFICATE', cert) };
}
