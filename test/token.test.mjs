import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  decodeStrictBase64Url,
  importVerifyKey,
  issueSession,
  shouldRenewSession,
  signAccessToken,
  verifyAccessToken,
  verifySession,
} from '../server/token.mjs';

// The public fixture is a copy of worker/test/gev-vector.json in TITAN-Runner. It holds a public
// key and a token that the Worker's minter signed once with a throwaway key. No private key.
const vector = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const NOW = 1_790_000_000_000;
const SESSION_KEY = Buffer.alloc(32, 7);

function makeKeys() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, x: pair.publicKey.export({ format: 'jwk' }).x };
}

test('accepts the token the Worker signed, from the shared public fixture', () => {
  const publicKey = importVerifyKey(vector.publicKeyX);
  assert.ok(publicKey);
  const verdict = verifyAccessToken(publicKey, vector.token, { nowMs: vector.iat * 1000 + 1000 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.jti, vector.jti);
  assert.equal(verdict.exp - verdict.iat, vector.ttlSeconds);
  // The same fixture fails under any other key and once tampered.
  assert.equal(verifyAccessToken(makeKeys().publicKey, vector.token, { nowMs: vector.iat * 1000 }).reason, 'bad-signature');
  const tampered = vector.token.replace('.1790000300.', '.1790009999.');
  assert.equal(verifyAccessToken(publicKey, tampered, { nowMs: vector.iat * 1000 }).reason, 'bad-signature');
});

test('accepts a fresh token', () => {
  const keys = makeKeys();
  const token = signAccessToken(keys.privateKey, { nowMs: NOW });
  const verdict = verifyAccessToken(keys.publicKey, token, { nowMs: NOW + 1000 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.exp - verdict.iat, 300);
});

test('rejects an expired token', () => {
  const keys = makeKeys();
  const token = signAccessToken(keys.privateKey, { nowMs: NOW });
  assert.deepEqual(verifyAccessToken(keys.publicKey, token, { nowMs: NOW + 301_000 }), { ok: false, reason: 'expired' });
});

test('rejects a token that claims a long lifetime even when signed correctly', () => {
  const keys = makeKeys();
  const token = signAccessToken(keys.privateKey, { nowMs: NOW, ttlSeconds: 3600 });
  assert.equal(verifyAccessToken(keys.publicKey, token, { nowMs: NOW }).reason, 'too-long');
});

test('rejects a token issued in the future beyond the skew allowance', () => {
  const keys = makeKeys();
  const token = signAccessToken(keys.privateKey, { nowMs: NOW + 120_000 });
  assert.equal(verifyAccessToken(keys.publicKey, token, { nowMs: NOW }).reason, 'from-future');
});

test('rejects a tampered payload, another key, and junk', () => {
  const keys = makeKeys();
  const token = signAccessToken(keys.privateKey, { nowMs: NOW });
  const parts = token.split('.');
  parts[2] = String(Number(parts[2]) + 60);
  assert.equal(verifyAccessToken(keys.publicKey, parts.join('.'), { nowMs: NOW }).reason, 'bad-signature');
  assert.equal(verifyAccessToken(makeKeys().publicKey, token, { nowMs: NOW }).reason, 'bad-signature');
  const sig = 'A'.repeat(86);
  for (const junk of ['', 'abc', 'gev2.1.2.3', `gev2.1.2.abcdefgh.${sig}.extra`, `${token}.extra`, 'x'.repeat(500)]) {
    assert.equal(verifyAccessToken(keys.publicKey, junk, { nowMs: NOW }).ok, false);
  }
  assert.equal(verifyAccessToken(null, token, { nowMs: NOW }).reason, 'no-key');
});

test('rejects any prefix other than gev2, including the old shared secret format', () => {
  const keys = makeKeys();
  const token = signAccessToken(keys.privateKey, { nowMs: NOW });
  const body = token.split('.').slice(1).join('.');
  for (const prefix of ['gev1', 'gev3', 'GEV2', 'gevs1', 'gev', '']) {
    assert.equal(verifyAccessToken(keys.publicKey, `${prefix}.${body}`, { nowMs: NOW }).reason, 'malformed', prefix);
  }
  const oldHmacToken = 'gev1.1790000000.1790000300.AAAAAAAAAAAAAAAA.07QHX4dt7w8RC9MnAyXnXvjqQmow1nbYGjwAc6uOVPE';
  assert.equal(verifyAccessToken(keys.publicKey, oldHmacToken, { nowMs: NOW }).ok, false);
});

test('rejects a signature that is not exactly 64 decoded bytes or not strict base64url', () => {
  const keys = makeKeys();
  const token = signAccessToken(keys.privateKey, { nowMs: NOW });
  const parts = token.split('.');
  const sigText = parts[4];
  const sigBytes = Buffer.from(sigText, 'base64url');
  assert.equal(sigBytes.length, 64);
  const withSig = (value) => [...parts.slice(0, 4), value].join('.');

  const bad = {
    'too short (63 bytes)': sigBytes.subarray(0, 63).toString('base64url'),
    'too long (65 bytes)': Buffer.concat([sigBytes, Buffer.from([1])]).toString('base64url'),
    empty: '',
    padded: `${sigText}==`,
    'standard alphabet': sigBytes.toString('base64').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/'),
    whitespace: `${sigText.slice(0, 10)} ${sigText.slice(10)}`,
    'not base64 at all': '!'.repeat(86),
  };
  // A last character that changes only the unused trailing bits decodes to the same 64 bytes.
  // Node accepts it, so the gateway has to refuse it on purpose.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const variant = [...alphabet].map((c) => sigText.slice(0, -1) + c).find((v) => v !== sigText && Buffer.from(v, 'base64url').equals(sigBytes));
  assert.ok(variant, 'expected a non canonical twin of the signature');
  bad['non canonical trailing bits'] = variant;

  for (const [name, value] of Object.entries(bad)) {
    assert.equal(verifyAccessToken(keys.publicKey, withSig(value), { nowMs: NOW }).ok, false, name);
  }
  // Sanity check that the untouched token still passes.
  assert.equal(verifyAccessToken(keys.publicKey, token, { nowMs: NOW }).ok, true);
});

test('decodeStrictBase64Url only returns the exact byte length of canonical base64url', () => {
  const bytes = Buffer.from('0123456789abcdef0123456789abcdef');
  const text = bytes.toString('base64url');
  assert.deepEqual(decodeStrictBase64Url(text, 32), bytes);
  assert.equal(decodeStrictBase64Url(text, 31), null);
  assert.equal(decodeStrictBase64Url(`${text}=`, 32), null);
  assert.equal(decodeStrictBase64Url(bytes.toString('base64'), 32), null);
  assert.equal(decodeStrictBase64Url('', 32), null);
  assert.equal(decodeStrictBase64Url(undefined, 32), null);
  assert.equal(decodeStrictBase64Url(42, 32), null);
});

test('importVerifyKey accepts the public x value and nothing malformed', () => {
  const keys = makeKeys();
  assert.ok(importVerifyKey(keys.x));
  assert.ok(importVerifyKey(`  ${keys.x}\n`), 'surrounding whitespace is trimmed');
  const raw = Buffer.from(keys.x, 'base64url');
  const malformed = [
    undefined,
    '',
    'short',
    `${keys.x}=`,
    keys.x.slice(0, -1),
    Buffer.concat([raw, Buffer.from([0])]).toString('base64url'),
    raw.toString('base64').replace(/-/g, '+'),
    `${keys.x}\n${keys.x}`,
    JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: keys.x }),
  ];
  for (const value of malformed) assert.equal(importVerifyKey(value), null, String(value).slice(0, 30));
});

test('a session cookie never passes as an access token and the reverse', () => {
  const keys = makeKeys();
  const session = issueSession(SESSION_KEY, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  assert.equal(verifyAccessToken(keys.publicKey, session.value, { nowMs: NOW }).ok, false);
  const token = signAccessToken(keys.privateKey, { nowMs: NOW });
  assert.equal(verifySession(SESSION_KEY, token, { nowMs: NOW, maxSeconds: 21_600 }).ok, false);
});

test('a session lasts the idle window and no longer', () => {
  const session = issueSession(SESSION_KEY, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  assert.equal(session.maxAgeSeconds, 1800);
  assert.equal(verifySession(SESSION_KEY, session.value, { nowMs: NOW + 1_799_000, maxSeconds: 21_600 }).ok, true);
  assert.equal(verifySession(SESSION_KEY, session.value, { nowMs: NOW + 1_801_000, maxSeconds: 21_600 }).reason, 'expired');
});

test('a sliding session never outlives the absolute cap', () => {
  const first = issueSession(SESSION_KEY, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 3600 });
  const later = NOW + 3_000_000;
  const renewed = issueSession(SESSION_KEY, {
    nowMs: later,
    idleSeconds: 1800,
    maxSeconds: 3600,
    sid: first.sid,
    start: first.start,
  });
  assert.equal(renewed.exp, first.start + 3600);
  assert.equal(shouldRenewSession(renewed, { nowMs: later, idleSeconds: 1800, maxSeconds: 3600 }), false);
});

test('renewal starts once under half the idle window remains', () => {
  const session = issueSession(SESSION_KEY, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  assert.equal(shouldRenewSession(session, { nowMs: NOW + 800_000, idleSeconds: 1800, maxSeconds: 21_600 }), false);
  assert.equal(shouldRenewSession(session, { nowMs: NOW + 1_000_000, idleSeconds: 1800, maxSeconds: 21_600 }), true);
});

test('rejects a tampered session cookie, one from another key, and a missing or short key', () => {
  const session = issueSession(SESSION_KEY, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  const parts = session.value.split('.');
  parts[3] = String(Number(parts[3]) + 9999);
  assert.equal(verifySession(SESSION_KEY, parts.join('.'), { nowMs: NOW, maxSeconds: 21_600 }).reason, 'bad-signature');
  assert.equal(verifySession(Buffer.alloc(32, 8), session.value, { nowMs: NOW, maxSeconds: 21_600 }).reason, 'bad-signature');
  for (const key of [undefined, null, 'a-string-is-not-a-key', Buffer.alloc(8)]) {
    assert.equal(verifySession(key, session.value, { nowMs: NOW, maxSeconds: 21_600 }).reason, 'no-key');
  }
});
