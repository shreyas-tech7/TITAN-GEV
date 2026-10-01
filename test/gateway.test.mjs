import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.mjs';
import { createGateway } from '../server/gateway.mjs';
import { signAccessToken } from '../server/token.mjs';

const SECRET = 'gateway-test-secret-that-is-long-enough-0000';
const PARENT = 'https://dash.example';
const START = 1_790_000_000_000;
const silent = { warn() {}, error() {}, log() {} };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Start a stub app and a gateway in front of it. The clock is fake so expiry tests are exact. */
async function startStack({ env = {}, ready = true, appUp = true } = {}) {
  const seen = [];
  const app = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'set-cookie': 'app=1',
    });
    res.end('<html>GOD\'S EYE VIEW</html>');
  });
  const appPort = await listen(app);
  if (!appUp) await new Promise((resolve) => app.close(resolve));
  const clock = { t: START };
  const config = loadConfig({
    GEV_SHARED_SECRET: SECRET,
    GEV_FRAME_ANCESTORS: PARENT,
    GEV_UPSTREAM_PORT: String(appPort),
    ...env,
  });
  const gateway = createGateway({ config, upstreamReady: () => ready, now: () => clock.t, log: silent });
  const port = await listen(gateway.server);
  return {
    port,
    seen,
    clock,
    token: (overrides = {}) => signAccessToken(SECRET, { nowMs: clock.t, ...overrides }),
    async stop() {
      await gateway.close();
      if (appUp) await new Promise((resolve) => app.close(resolve));
    },
  };
}

function cookieFrom(response) {
  const header = response.headers['set-cookie'];
  assert.ok(header, 'expected a Set-Cookie header');
  return String(Array.isArray(header) ? header[0] : header).split(';')[0];
}

async function login(stack, extraHeaders = {}) {
  const response = await request(stack.port, { path: `/?gev_token=${stack.token()}`, headers: extraHeaders });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

test('refuses a request with no token and says nothing about why', async () => {
  const stack = await startStack();
  try {
    const frame = await request(stack.port, { path: '/', headers: { 'sec-fetch-dest': 'iframe' } });
    assert.equal(frame.status, 401);
    assert.match(frame.body, /401 UNAUTHORIZED/);
    assert.equal(frame.headers['set-cookie'], undefined);
    const api = await request(stack.port, { path: '/api/aircraft', headers: { 'sec-fetch-dest': 'empty' } });
    assert.equal(api.status, 401);
    assert.equal(api.body.trim(), '401 Unauthorized');
    assert.equal(stack.seen.length, 0);
  } finally {
    await stack.stop();
  }
});

test('redeems a valid token into a partitioned, secure, http-only cookie', async () => {
  const stack = await startStack();
  try {
    const response = await request(stack.port, { path: `/?gev_token=${stack.token()}`, headers: { 'sec-fetch-dest': 'iframe' } });
    assert.equal(response.status, 200);
    const setCookie = String(response.headers['set-cookie']);
    assert.match(setCookie, /^__Host-gev_session=gevs1\./);
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=None', 'Partitioned', 'Path=/', 'Max-Age=1800']) {
      assert.ok(setCookie.includes(attribute), attribute);
    }
    assert.equal(/Domain=/i.test(setCookie), false);
    assert.match(response.body, /location\.replace\(target\)/);
    assert.match(response.body, /var target="\/"/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors https:\/\/dash\.example/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(stack.seen.length, 0);
  } finally {
    await stack.stop();
  }
});

test('a token is good for one redemption only', async () => {
  const stack = await startStack();
  try {
    const token = stack.token();
    assert.equal((await request(stack.port, { path: `/?gev_token=${token}` })).status, 200);
    assert.equal((await request(stack.port, { path: `/?gev_token=${token}` })).status, 401);
  } finally {
    await stack.stop();
  }
});

test('rejects an expired token, a long-lived token, a bad signature, and a token sent by POST', async () => {
  const stack = await startStack();
  try {
    const old = stack.token();
    stack.clock.t += 400_000;
    assert.equal((await request(stack.port, { path: `/?gev_token=${old}` })).status, 401);
    assert.equal((await request(stack.port, { path: `/?gev_token=${stack.token({ ttlSeconds: 7200 })}` })).status, 401);
    const forged = signAccessToken('another-secret-that-is-also-long-enough-xx', { nowMs: stack.clock.t });
    assert.equal((await request(stack.port, { path: `/?gev_token=${forged}` })).status, 401);
    assert.equal((await request(stack.port, { method: 'POST', path: `/?gev_token=${stack.token()}`, body: '{}' })).status, 401);
    assert.equal((await request(stack.port, { path: '/?gev_token=junk' })).status, 401);
  } finally {
    await stack.stop();
  }
});

test('fails closed when the shared secret is missing or weak', async () => {
  for (const secret of ['', 'too-short']) {
    const stack = await startStack({ env: { GEV_SHARED_SECRET: secret } });
    try {
      const token = signAccessToken(secret || 'x', { nowMs: stack.clock.t });
      assert.equal((await request(stack.port, { path: `/?gev_token=${token}` })).status, 401);
      assert.equal((await request(stack.port, { path: '/' })).status, 401);
    } finally {
      await stack.stop();
    }
  }
});

test('a session cookie reaches the app, which sees a clean request', async () => {
  const stack = await startStack();
  try {
    const cookie = await login(stack);
    const response = await request(stack.port, {
      path: `/api/aircraft?lat=1&gev_token=ignored&lon=2`,
      headers: { cookie, host: 'cozmik7-titan-gev.hf.space', 'x-forwarded-for': '203.0.113.9', authorization: 'Bearer nope' },
    });
    assert.equal(response.status, 200);
    assert.equal(stack.seen.length, 1);
    const [forwarded] = stack.seen;
    assert.equal(forwarded.url, '/api/aircraft?lat=1&lon=2');
    assert.equal(forwarded.headers.host, stack.seen[0].headers.host);
    assert.match(forwarded.headers.host, /^127\.0\.0\.1:\d+$/);
    for (const name of ['cookie', 'authorization', 'x-forwarded-for']) assert.equal(name in forwarded.headers, false, name);
  } finally {
    await stack.stop();
  }
});

test('swaps framing headers so only the dashboard origin may frame the app', async () => {
  const stack = await startStack();
  try {
    const cookie = await login(stack);
    const response = await request(stack.port, { path: '/', headers: { cookie } });
    assert.equal(response.headers['x-frame-options'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['content-security-policy'], "default-src 'self'; frame-ancestors https://dash.example");
  } finally {
    await stack.stop();
  }
});

test('keeps Provider Settings and paid routes off even for a valid session', async () => {
  const stack = await startStack();
  try {
    const cookie = await login(stack);
    const paths = [
      '/api/setup/status',
      '/api/setup/keys',
      '/API/Setup/keys',
      '/api/%73etup/status',
      '/api/realtime/token',
      '/api/openai/hud-summary',
      '/.env',
      '/__gev/other',
    ];
    for (const path of paths) {
      const response = await request(stack.port, { path, headers: { cookie } });
      assert.equal(response.status, 404, path);
    }
    const post = await request(stack.port, { method: 'POST', path: '/api/setup/keys', headers: { cookie, 'content-type': 'application/json' }, body: '{"CESIUM_ION_TOKEN":"x"}' });
    assert.equal(post.status, 404);
    assert.equal(stack.seen.length, 0, 'blocked routes must never reach the app');
  } finally {
    await stack.stop();
  }
});

test('paid routes open only by explicit opt-in and Provider Settings stays shut', async () => {
  const stack = await startStack({ env: { GEV_ALLOW_PAID_ROUTES: '1' } });
  try {
    const cookie = await login(stack);
    assert.equal((await request(stack.port, { path: '/api/realtime/token', headers: { cookie } })).status, 200);
    assert.equal((await request(stack.port, { path: '/api/setup/status', headers: { cookie } })).status, 404);
  } finally {
    await stack.stop();
  }
});

test('rejects malformed targets and unsupported methods', async () => {
  const stack = await startStack();
  try {
    const cookie = await login(stack);
    for (const path of ['//evil.example/x', '/a%2fb', '/%2e%2e/etc/passwd', '/a\\b']) {
      assert.equal((await request(stack.port, { path, headers: { cookie } })).status, 400, path);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH', 'TRACE']) {
      assert.equal((await request(stack.port, { method, path: '/', headers: { cookie } })).status, 405, method);
    }
    assert.equal(stack.seen.length, 0);
  } finally {
    await stack.stop();
  }
});

test('answers the session probe only for a valid session', async () => {
  const stack = await startStack();
  try {
    assert.equal((await request(stack.port, { path: '/__gev/session' })).status, 401);
    const cookie = await login(stack);
    const probe = await request(stack.port, { path: '/__gev/session', headers: { cookie } });
    assert.equal(probe.status, 204);
    assert.equal(probe.headers['cache-control'], 'no-store');
  } finally {
    await stack.stop();
  }
});

test('rate limits API calls per session and leaves static files alone', async () => {
  const stack = await startStack({ env: { GEV_RATE_API_PER_MIN: '3' } });
  try {
    const cookie = await login(stack);
    for (let i = 0; i < 3; i += 1) assert.equal((await request(stack.port, { path: '/api/x', headers: { cookie } })).status, 200);
    const limited = await request(stack.port, { path: '/api/x', headers: { cookie } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await request(stack.port, { path: '/assets/a.js', headers: { cookie } })).status, 200);
  } finally {
    await stack.stop();
  }
});

test('rate limits unauthenticated requests per client address', async () => {
  const stack = await startStack({ env: { GEV_RATE_UNAUTH_PER_MIN: '3' } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await request(stack.port, { path: '/', headers: { 'x-forwarded-for': '198.51.100.7' } })).status, 401);
    assert.equal((await request(stack.port, { path: '/', headers: { 'x-forwarded-for': '198.51.100.7' } })).status, 429);
    assert.equal((await request(stack.port, { path: '/', headers: { 'x-forwarded-for': '198.51.100.8' } })).status, 401);
  } finally {
    await stack.stop();
  }
});

test('slides the session while in use and expires it when idle', async () => {
  const stack = await startStack();
  try {
    const cookie = await login(stack);
    stack.clock.t += 600_000;
    assert.equal((await request(stack.port, { path: '/', headers: { cookie } })).headers['set-cookie'], undefined);
    stack.clock.t += 400_000;
    const renewed = await request(stack.port, { path: '/', headers: { cookie } });
    assert.match(String(renewed.headers['set-cookie']), /^__Host-gev_session=gevs1\./);
    const fresh = cookieFrom(renewed);
    stack.clock.t += 1_700_000;
    assert.equal((await request(stack.port, { path: '/', headers: { cookie } })).status, 401, 'the old cookie expired');
    assert.equal((await request(stack.port, { path: '/', headers: { cookie: fresh } })).status, 200, 'the renewed cookie is still good');
  } finally {
    await stack.stop();
  }
});

test('healthz is public, reports readiness, and answers CORS for the dashboard only', async () => {
  const stack = await startStack();
  try {
    const allowed = await request(stack.port, { path: '/healthz', headers: { origin: PARENT } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.body), { ok: true, service: 'titan-gev', status: 'ready' });
    assert.equal(allowed.headers['access-control-allow-origin'], PARENT);
    const other = await request(stack.port, { path: '/healthz', headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    const preflight = await request(stack.port, { method: 'OPTIONS', path: '/healthz', headers: { origin: PARENT } });
    assert.equal(preflight.status, 204);
  } finally {
    await stack.stop();
  }
  const starting = await startStack({ ready: false });
  try {
    const response = await request(starting.port, { path: '/healthz', headers: { origin: PARENT } });
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).status, 'starting');
    const cookie = await login(starting);
    const gated = await request(starting.port, { path: '/', headers: { cookie } });
    assert.equal(gated.status, 503);
    assert.equal(gated.headers['retry-after'], '5');
  } finally {
    await starting.stop();
  }
});

test('returns a bare 502 when the app is down and refuses oversize bodies', async () => {
  const down = await startStack({ appUp: false });
  try {
    const cookie = await login(down);
    const response = await request(down.port, { path: '/api/x', headers: { cookie } });
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), { error: 'Upstream unavailable' });
  } finally {
    await down.stop();
  }
  const stack = await startStack({ env: { GEV_MAX_BODY_BYTES: '2048' } });
  try {
    const cookie = await login(stack);
    const big = await request(stack.port, { method: 'POST', path: '/api/x', headers: { cookie, 'content-type': 'application/json', 'content-length': '4096' }, body: 'x'.repeat(4096) });
    assert.equal(big.status, 413);
    assert.equal(stack.seen.length, 0);
  } finally {
    await stack.stop();
  }
});

test('no response ever contains the shared secret', async () => {
  const stack = await startStack();
  try {
    const responses = [];
    responses.push(await request(stack.port, { path: '/' }));
    responses.push(await request(stack.port, { path: '/healthz', headers: { origin: PARENT } }));
    responses.push(await request(stack.port, { path: '/?gev_token=bad' }));
    const redeemed = await request(stack.port, { path: `/?gev_token=${stack.token()}`, headers: { 'sec-fetch-dest': 'iframe' } });
    responses.push(redeemed);
    const cookie = cookieFrom(redeemed);
    responses.push(await request(stack.port, { path: '/', headers: { cookie } }));
    responses.push(await request(stack.port, { path: '/api/setup/status', headers: { cookie } }));
    for (const response of responses) {
      const dump = JSON.stringify(response);
      assert.equal(dump.includes(SECRET), false);
      assert.equal(dump.toLowerCase().includes('stack'), false);
    }
  } finally {
    await stack.stop();
  }
});

test('a trusted client address header decides the rate limit key and X-Forwarded-For is ignored', async () => {
  const stack = await startStack({ env: { GEV_RATE_UNAUTH_PER_MIN: '2', GEV_CLIENT_IP_HEADER: 'cf-connecting-ip' } });
  try {
    const from = (ip, spoof) => request(stack.port, { path: '/', headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': spoof } });
    assert.equal((await from('198.51.100.1', '1.1.1.1')).status, 401);
    assert.equal((await from('198.51.100.1', '2.2.2.2')).status, 401);
    assert.equal((await from('198.51.100.1', '3.3.3.3')).status, 429, 'rotating X-Forwarded-For does not dodge the limit');
    assert.equal((await from('198.51.100.2', '1.1.1.1')).status, 401, 'another real client has its own budget');
    // A missing or malformed header falls back to the socket address, never to X-Forwarded-For.
    const noHeader = () => request(stack.port, { path: '/', headers: { 'x-forwarded-for': `9.9.9.${Math.floor(Math.random() * 200)}` } });
    assert.equal((await noHeader()).status, 401);
    assert.equal((await noHeader()).status, 401);
    assert.equal((await noHeader()).status, 429);
    const junk = () => request(stack.port, { path: '/', headers: { 'cf-connecting-ip': 'not an ip' } });
    assert.equal((await junk()).status, 429, 'a junk header shares the socket address bucket');
  } finally {
    await stack.stop();
  }
});

test('a valid redemption works even when that address already used up its failed attempts', async () => {
  const stack = await startStack({ env: { GEV_RATE_UNAUTH_PER_MIN: '2' } });
  try {
    const sameClient = { 'x-forwarded-for': '203.0.113.50' };
    assert.equal((await request(stack.port, { path: '/', headers: sameClient })).status, 401);
    assert.equal((await request(stack.port, { path: '/', headers: sameClient })).status, 401);
    assert.equal((await request(stack.port, { path: '/', headers: sameClient })).status, 429);
    const redeemed = await request(stack.port, { path: `/?gev_token=${stack.token()}`, headers: sameClient });
    assert.equal(redeemed.status, 200, 'a real session start is never blocked by someone else\'s noise');
  } finally {
    await stack.stop();
  }
});
