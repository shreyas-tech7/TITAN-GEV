// Access token and session cookie format for the TITAN-GEV gate.
//
// Access token (signed by the TITAN Worker, redeemed once by this wrapper):
//   gev2.<iat>.<exp>.<jti>.<sig>
//   sig = base64url(Ed25519 signature over "gev2.<iat>.<exp>.<jti>")
//
// The Worker holds the private key. This wrapper holds only the public key
// (GEV_VERIFY_KEY, the 32 raw bytes as base64url), so it can check tokens but
// can never make one. The public key is not a secret.
//
// Session cookie (minted here, never by the Worker):
//   gevs1.<sid>.<start>.<exp>.<sig>
//   sig = base64url(HMAC-SHA256(sessionKey, payload))
//
// The session key is 32 random bytes made when the process starts. A restart
// ends every session. The two formats use different prefixes and different
// algorithms, so a session cookie can never pass as an access token and the
// reverse.
import { createHmac, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';

export const ACCESS_PREFIX = 'gev2';
export const SESSION_PREFIX = 'gevs1';
export const SESSION_COOKIE_NAME = '__Host-gev_session';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const INT_RE = /^[0-9]{1,12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const ED25519_PUBLIC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

function fail(reason) {
  return { ok: false, reason };
}

/**
 * Decode strict base64url. It rejects padding, the standard alphabet, whitespace,
 * and any text that is not the canonical encoding of its bytes. Returns a Buffer
 * of exactly `bytes` length, or null.
 */
export function decodeStrictBase64Url(text, bytes) {
  if (typeof text !== 'string' || text.length === 0 || !B64URL_RE.test(text)) return null;
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.length !== bytes) return null;
  return decoded.toString('base64url') === text ? decoded : null;
}

/** Turn GEV_VERIFY_KEY into a public key object, or null when it is not 32 raw bytes of base64url. */
export function importVerifyKey(x) {
  if (decodeStrictBase64Url(typeof x === 'string' ? x.trim() : x, ED25519_PUBLIC_BYTES) === null) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x.trim() }, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * Sign an access token. The wrapper never calls this. It exists for the tests and the
 * live check, which hold their own throwaway private keys. The TITAN Worker has its own
 * WebCrypto twin of this format.
 */
export function signAccessToken(
  privateKey,
  { nowMs = Date.now(), ttlSeconds = 300, jti = randomBytes(12).toString('base64url') } = {},
) {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const payload = `${ACCESS_PREFIX}.${iat}.${exp}.${jti}`;
  return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`;
}

/**
 * Check an access token against the public key. The reason string is for tests and
 * counters only. Callers must never send it to a client.
 */
export function verifyAccessToken(
  publicKey,
  token,
  { nowMs = Date.now(), maxLifetimeSeconds = 600, skewSeconds = 30 } = {},
) {
  if (!publicKey || typeof publicKey !== 'object') return fail('no-key');
  if (typeof token !== 'string' || token.length > 256) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== ACCESS_PREFIX) return fail('malformed');
  const [, iatText, expText, jti, sigText] = parts;
  if (!INT_RE.test(iatText) || !INT_RE.test(expText) || !ID_RE.test(jti)) return fail('malformed');
  const signature = decodeStrictBase64Url(sigText, ED25519_SIGNATURE_BYTES);
  if (!signature) return fail('malformed');
  let signatureOk = false;
  try {
    signatureOk = verify(null, Buffer.from(`${ACCESS_PREFIX}.${iatText}.${expText}.${jti}`), publicKey, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return fail('bad-signature');
  const iat = Number(iatText);
  const exp = Number(expText);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (exp <= iat) return fail('bad-lifetime');
  if (exp - iat > maxLifetimeSeconds) return fail('too-long');
  if (iat > nowSeconds + skewSeconds) return fail('from-future');
  if (exp <= nowSeconds) return fail('expired');
  return { ok: true, jti, iat, exp };
}

function hmacBase64Url(key, text) {
  return createHmac('sha256', key).update(text).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validSessionKey(key) {
  return Buffer.isBuffer(key) && key.length >= 32;
}

/** Mint a session cookie value. Pass `start` and `sid` again to slide an existing session. */
export function issueSession(
  sessionKey,
  { nowMs = Date.now(), idleSeconds, maxSeconds, sid = randomBytes(12).toString('base64url'), start } = {},
) {
  const nowSeconds = Math.floor(nowMs / 1000);
  const startSeconds = start ?? nowSeconds;
  const exp = Math.min(nowSeconds + idleSeconds, startSeconds + maxSeconds);
  const payload = `${SESSION_PREFIX}.${sid}.${startSeconds}.${exp}`;
  return {
    value: `${payload}.${hmacBase64Url(sessionKey, payload)}`,
    sid,
    start: startSeconds,
    exp,
    maxAgeSeconds: Math.max(0, exp - nowSeconds),
  };
}

export function verifySession(sessionKey, value, { nowMs = Date.now(), maxSeconds, skewSeconds = 30 } = {}) {
  if (!validSessionKey(sessionKey)) return fail('no-key');
  if (typeof value !== 'string' || value.length > 256) return fail('malformed');
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== SESSION_PREFIX) return fail('malformed');
  const [, sid, startText, expText, sig] = parts;
  if (!ID_RE.test(sid) || !INT_RE.test(startText) || !INT_RE.test(expText) || !sig) {
    return fail('malformed');
  }
  const expected = hmacBase64Url(sessionKey, `${SESSION_PREFIX}.${sid}.${startText}.${expText}`);
  if (!safeEqual(sig, expected)) return fail('bad-signature');
  const start = Number(startText);
  const exp = Number(expText);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (start > nowSeconds + skewSeconds) return fail('from-future');
  if (exp <= nowSeconds) return fail('expired');
  if (exp > start + maxSeconds) return fail('too-long');
  return { ok: true, sid, start, exp };
}

/** A session renews when under half its idle window remains and the absolute cap has room. */
export function shouldRenewSession(session, { nowMs = Date.now(), idleSeconds, maxSeconds }) {
  const nowSeconds = Math.floor(nowMs / 1000);
  return session.exp - nowSeconds < idleSeconds / 2 && session.exp < session.start + maxSeconds;
}
