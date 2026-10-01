import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  issueSession,
  shouldRenewSession,
  signAccessToken,
  verifyAccessToken,
  verifySession,
} from '../server/token.mjs';

const vector = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const SECRET = 'a-long-enough-test-secret-for-the-gev-gate-0000';
const NOW = 1_790_000_000_000;

test('reproduces the shared token test vector exactly', () => {
  const token = signAccessToken(vector.secret, {
    nowMs: vector.iat * 1000,
    ttlSeconds: vector.ttlSeconds,
    jti: vector.jti,
  });
  assert.equal(token, vector.token);
});

test('accepts a fresh token', () => {
  const token = signAccessToken(SECRET, { nowMs: NOW });
  const verdict = verifyAccessToken(SECRET, token, { nowMs: NOW + 1000 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.exp - verdict.iat, 300);
});

test('rejects an expired token', () => {
  const token = signAccessToken(SECRET, { nowMs: NOW });
  assert.deepEqual(verifyAccessToken(SECRET, token, { nowMs: NOW + 301_000 }), { ok: false, reason: 'expired' });
});

test('rejects a token that claims a long lifetime even when signed correctly', () => {
  const token = signAccessToken(SECRET, { nowMs: NOW, ttlSeconds: 3600 });
  assert.equal(verifyAccessToken(SECRET, token, { nowMs: NOW }).reason, 'too-long');
});

test('rejects a token issued in the future beyond the skew allowance', () => {
  const token = signAccessToken(SECRET, { nowMs: NOW + 120_000 });
  assert.equal(verifyAccessToken(SECRET, token, { nowMs: NOW }).reason, 'from-future');
});

test('rejects a tampered payload, a wrong secret, and junk', () => {
  const token = signAccessToken(SECRET, { nowMs: NOW });
  const parts = token.split('.');
  parts[2] = String(Number(parts[2]) + 60);
  assert.equal(verifyAccessToken(SECRET, parts.join('.'), { nowMs: NOW }).reason, 'bad-signature');
  assert.equal(verifyAccessToken(`${SECRET}x`, token, { nowMs: NOW }).reason, 'bad-signature');
  for (const junk of ['', 'abc', 'gev1.1.2.3', 'gev2.1.2.abcdefgh.sig', `${token}.extra`, 'x'.repeat(500)]) {
    assert.equal(verifyAccessToken(SECRET, junk, { nowMs: NOW }).ok, false);
  }
  assert.equal(verifyAccessToken('', token, { nowMs: NOW }).reason, 'no-secret');
});

test('a session cookie never passes as an access token and the reverse', () => {
  const session = issueSession(SECRET, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  assert.equal(verifyAccessToken(SECRET, session.value, { nowMs: NOW }).ok, false);
  const token = signAccessToken(SECRET, { nowMs: NOW });
  assert.equal(verifySession(SECRET, token, { nowMs: NOW, maxSeconds: 21_600 }).ok, false);
});

test('a session lasts the idle window and no longer', () => {
  const session = issueSession(SECRET, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  assert.equal(session.maxAgeSeconds, 1800);
  assert.equal(verifySession(SECRET, session.value, { nowMs: NOW + 1_799_000, maxSeconds: 21_600 }).ok, true);
  assert.equal(verifySession(SECRET, session.value, { nowMs: NOW + 1_801_000, maxSeconds: 21_600 }).reason, 'expired');
});

test('a sliding session never outlives the absolute cap', () => {
  const first = issueSession(SECRET, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 3600 });
  const later = NOW + 3_000_000;
  const renewed = issueSession(SECRET, {
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
  const session = issueSession(SECRET, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  assert.equal(shouldRenewSession(session, { nowMs: NOW + 800_000, idleSeconds: 1800, maxSeconds: 21_600 }), false);
  assert.equal(shouldRenewSession(session, { nowMs: NOW + 1_000_000, idleSeconds: 1800, maxSeconds: 21_600 }), true);
});

test('rejects a tampered or foreign session cookie', () => {
  const session = issueSession(SECRET, { nowMs: NOW, idleSeconds: 1800, maxSeconds: 21_600 });
  const parts = session.value.split('.');
  parts[3] = String(Number(parts[3]) + 9999);
  assert.equal(verifySession(SECRET, parts.join('.'), { nowMs: NOW, maxSeconds: 21_600 }).reason, 'bad-signature');
  assert.equal(verifySession(`${SECRET}x`, session.value, { nowMs: NOW, maxSeconds: 21_600 }).reason, 'bad-signature');
});
