// Access token and session cookie format for the TITAN-GEV gate.
//
// Access token (minted by the TITAN Worker, redeemed once by this wrapper):
//   gev1.<iat>.<exp>.<jti>.<sig>
//   sig = base64url(HMAC-SHA256(GEV_SHARED_SECRET, "gev1.<iat>.<exp>.<jti>"))
//
// Session cookie (minted here, never by the Worker):
//   gevs1.<sid>.<start>.<exp>.<sig>
//   sig = base64url(HMAC-SHA256(HMAC-SHA256(secret, "gev-session-v1"), payload))
//
// The two formats use different prefixes and different keys, so a session
// cookie can never pass as an access token and the reverse.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_PREFIX = 'gev1';
export const SESSION_PREFIX = 'gevs1';
export const SESSION_COOKIE_NAME = '__Host-gev_session';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const INT_RE = /^[0-9]{1,12}$/;

function hmacBase64Url(key, text) {
  return createHmac('sha256', key).update(text).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fail(reason) {
  return { ok: false, reason };
}

/** Mint an access token. The TITAN Worker has its own WebCrypto twin of this. */
export function signAccessToken(
  secret,
  { nowMs = Date.now(), ttlSeconds = 300, jti = randomBytes(12).toString('base64url') } = {},
) {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const payload = `${ACCESS_PREFIX}.${iat}.${exp}.${jti}`;
  return `${payload}.${hmacBase64Url(secret, payload)}`;
}

/**
 * Check an access token. The reason string is for tests and counters only.
 * Callers must never send it to a client.
 */
export function verifyAccessToken(
  secret,
  token,
  { nowMs = Date.now(), maxLifetimeSeconds = 600, skewSeconds = 30 } = {},
) {
  if (typeof secret !== 'string' || secret.length === 0) return fail('no-secret');
  if (typeof token !== 'string' || token.length > 256) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== ACCESS_PREFIX) return fail('malformed');
  const [, iatText, expText, jti, sig] = parts;
  if (!INT_RE.test(iatText) || !INT_RE.test(expText) || !ID_RE.test(jti) || !sig) {
    return fail('malformed');
  }
  const expected = hmacBase64Url(secret, `${ACCESS_PREFIX}.${iatText}.${expText}.${jti}`);
  if (!safeEqual(sig, expected)) return fail('bad-signature');
  const iat = Number(iatText);
  const exp = Number(expText);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (exp <= iat) return fail('bad-lifetime');
  if (exp - iat > maxLifetimeSeconds) return fail('too-long');
  if (iat > nowSeconds + skewSeconds) return fail('from-future');
  if (exp <= nowSeconds) return fail('expired');
  return { ok: true, jti, iat, exp };
}

function sessionKey(secret) {
  return createHmac('sha256', secret).update('gev-session-v1').digest();
}

/** Mint a session cookie value. Pass `start` and `sid` again to slide an existing session. */
export function issueSession(
  secret,
  { nowMs = Date.now(), idleSeconds, maxSeconds, sid = randomBytes(12).toString('base64url'), start } = {},
) {
  const nowSeconds = Math.floor(nowMs / 1000);
  const startSeconds = start ?? nowSeconds;
  const exp = Math.min(nowSeconds + idleSeconds, startSeconds + maxSeconds);
  const payload = `${SESSION_PREFIX}.${sid}.${startSeconds}.${exp}`;
  return {
    value: `${payload}.${hmacBase64Url(sessionKey(secret), payload)}`,
    sid,
    start: startSeconds,
    exp,
    maxAgeSeconds: Math.max(0, exp - nowSeconds),
  };
}

export function verifySession(secret, value, { nowMs = Date.now(), maxSeconds, skewSeconds = 30 } = {}) {
  if (typeof secret !== 'string' || secret.length === 0) return fail('no-secret');
  if (typeof value !== 'string' || value.length > 256) return fail('malformed');
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== SESSION_PREFIX) return fail('malformed');
  const [, sid, startText, expText, sig] = parts;
  if (!ID_RE.test(sid) || !INT_RE.test(startText) || !INT_RE.test(expText) || !sig) {
    return fail('malformed');
  }
  const expected = hmacBase64Url(sessionKey(secret), `${SESSION_PREFIX}.${sid}.${startText}.${expText}`);
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
