import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPath, normalizeRequestTarget } from '../server/paths.mjs';
import { DEFAULT_FRAME_ANCESTORS, childEnv, loadConfig, parseOrigins } from '../server/config.mjs';
import { CESIUM_PLACEHOLDER, prepareRuntimeDist } from '../server/prepare-dist.mjs';
import { TokenBucketLimiter } from '../server/ratelimit.mjs';
import { buildResponseHeaders, buildUpstreamHeaders, cspWithFrameAncestors } from '../server/headers.mjs';

test('normalizes plain paths and keeps the query', () => {
  const target = normalizeRequestTarget('/api/aircraft?lat=1&lon=2');
  assert.equal(target.ok, true);
  assert.equal(target.pathname, '/api/aircraft');
  assert.equal(target.search, '?lat=1&lon=2');
  assert.equal(target.matchPath, '/api/aircraft');
});

test('rejects targets that could smuggle a different path', () => {
  const bad = [
    '//evil.example/x',
    '/\\evil',
    '/a%2fb',
    '/a%5cb',
    '/%2e%2e/etc/passwd',
    '/a/../b',
    '/a/%00',
    '/%zz',
    'http://evil.example/',
    '',
    `/${'a'.repeat(5000)}`,
  ];
  for (const raw of bad) assert.equal(normalizeRequestTarget(raw).ok, false, raw);
});

test('classifies provider settings and paid routes as blocked in every spelling', () => {
  const variants = [
    '/api/setup/status',
    '/api/setup/keys',
    '/API/SETUP/keys',
    '/api/%73etup/status',
    '/api//setup/status',
    '/api/setup',
  ];
  for (const raw of variants) {
    const target = normalizeRequestTarget(raw);
    assert.equal(target.ok, true, raw);
    assert.equal(classifyPath(target.matchPath), 'blocked', raw);
    assert.equal(classifyPath(target.matchPath, { allowPaidRoutes: true }), 'blocked', raw);
  }
  assert.equal(classifyPath('/api/realtime/token'), 'blocked');
  assert.equal(classifyPath('/api/openai/hud-summary'), 'blocked');
  assert.equal(classifyPath('/api/realtime/token', { allowPaidRoutes: true }), 'api');
});

test('classifies the wrapper namespace, dotfiles, api, and static paths', () => {
  assert.equal(classifyPath('/__gev/session'), 'reserved');
  assert.equal(classifyPath('/__gev'), 'reserved');
  assert.equal(classifyPath('/.env'), 'blocked');
  assert.equal(classifyPath('/assets/.hidden'), 'blocked');
  assert.equal(classifyPath('/.well-known/security.txt'), 'static');
  assert.equal(classifyPath('/api/aircraft'), 'api');
  assert.equal(classifyPath('/apix'), 'static');
  assert.equal(classifyPath('/'), 'static');
  assert.equal(classifyPath('/assets/index-abc.js'), 'static');
});

test('parseOrigins keeps clean origins and drops wildcards, paths, and junk', () => {
  assert.deepEqual(
    parseOrigins('https://a.example, http://localhost:3000 https://a.example/ https://*.example https://b.example/path ftp://x.example nope'),
    ['https://a.example', 'http://localhost:3000'],
  );
  assert.deepEqual(parseOrigins(undefined), []);
});

test('loadConfig defaults to the dashboard origin and rejects a weak secret', () => {
  const weak = loadConfig({ GEV_SHARED_SECRET: 'short' });
  assert.equal(weak.secretOk, false);
  assert.deepEqual(weak.frameAncestors, DEFAULT_FRAME_ANCESTORS);
  const strong = loadConfig({ GEV_SHARED_SECRET: 's'.repeat(32), GEV_FRAME_ANCESTORS: 'https://dash.example' });
  assert.equal(strong.secretOk, true);
  assert.deepEqual(strong.frameAncestors, ['https://dash.example']);
  assert.equal(strong.listenPort, 7860);
  assert.equal(strong.sessionMaxSeconds, 21_600);
});

test('loadConfig falls back on out-of-range numbers and a malformed Cesium token', () => {
  const config = loadConfig({ GEV_SESSION_IDLE_SECONDS: '999999', GEV_TOKEN_MAX_LIFETIME_SECONDS: 'abc', CESIUM_ION_TOKEN: 'has spaces and "quotes"' });
  assert.equal(config.sessionIdleSeconds, 1800);
  assert.equal(config.tokenMaxLifetimeSeconds, 600);
  assert.equal(config.cesiumIonToken, '');
  assert.equal(config.cesiumIonTokenRejected, true);
});

test('the app process never sees the gate secret, the HF token, Cesium, or paid keys', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/node',
    GEV_SHARED_SECRET: 'x',
    HF_TOKEN: 'x',
    CESIUM_ION_TOKEN: 'x',
    OPENAI_API_KEY: 'x',
    GOOGLE_MAPS_API_KEY: 'x',
    OPENSKY_CLIENT_ID: 'id',
    TOMTOM_API_KEY: 'k',
    PORT: '1234',
    HOST: '0.0.0.0',
  };
  const child = childEnv(env, { upstreamPort: 4173 });
  for (const name of ['GEV_SHARED_SECRET', 'HF_TOKEN', 'CESIUM_ION_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_MAPS_API_KEY']) {
    assert.equal(name in child, false, name);
  }
  assert.equal(child.OPENSKY_CLIENT_ID, 'id');
  assert.equal(child.TOMTOM_API_KEY, 'k');
  assert.equal(child.HOST, '127.0.0.1');
  assert.equal(child.PORT, '4173');
  assert.equal(child.NODE_OPTIONS, '--max-old-space-size=256');
});

test('the app process never inherits NODE_OPTIONS and always gets the configured heap cap', () => {
  const child = childEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--inspect=0.0.0.0:9229' }, { upstreamPort: 4173, heapMb: 192 });
  assert.equal(child.NODE_OPTIONS, '--max-old-space-size=192');
});

test('the listen port follows GEV_LISTEN_PORT, then PORT, then 7860', () => {
  assert.equal(loadConfig({}).listenPort, 7860);
  assert.equal(loadConfig({ PORT: '10000' }).listenPort, 10000);
  assert.equal(loadConfig({ PORT: '10000', GEV_LISTEN_PORT: '8080' }).listenPort, 8080);
  assert.equal(loadConfig({ PORT: 'junk' }).listenPort, 7860);
  assert.equal(loadConfig({ PORT: '99999' }).listenPort, 7860);
});

test('the client address header, heap cap, and config loader validate their input', () => {
  assert.equal(loadConfig({ GEV_CLIENT_IP_HEADER: 'CF-Connecting-IP' }).clientIpHeader, 'cf-connecting-ip');
  for (const bad of ['', 'x y', 'a;b', 'a'.repeat(80), 'x\r\ny']) assert.equal(loadConfig({ GEV_CLIENT_IP_HEADER: bad }).clientIpHeader, '', bad);
  assert.equal(loadConfig({}).appHeapMb, 256);
  assert.equal(loadConfig({ GEV_APP_HEAP_MB: '10' }).appHeapMb, 256);
  assert.equal(loadConfig({ GEV_APP_HEAP_MB: '384' }).appHeapMb, 384);
  assert.equal(loadConfig({}).viteConfigLoader, 'native');
  assert.equal(loadConfig({ GEV_VITE_CONFIG_LOADER: 'bundle' }).viteConfigLoader, 'bundle');
  assert.equal(loadConfig({ GEV_VITE_CONFIG_LOADER: 'evil' }).viteConfigLoader, 'native');
});

test('token bucket allows the burst, then refuses, then refills', () => {
  let clock = 0;
  const limiter = new TokenBucketLimiter({ perMinute: 3, now: () => clock });
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, true);
  const refused = limiter.take('a');
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterSeconds >= 1);
  assert.equal(limiter.take('b').ok, true);
  clock += 21_000;
  assert.equal(limiter.take('a').ok, true);
});

test('token bucket stays bounded in memory', () => {
  const limiter = new TokenBucketLimiter({ perMinute: 5, maxKeys: 10 });
  for (let i = 0; i < 100; i += 1) limiter.take(`k${i}`);
  assert.ok(limiter.buckets.size <= 10);
});

test('rewrites framing headers to the allowed parent origins only', () => {
  const headers = buildResponseHeaders(
    { 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'set-cookie': 'x=1', connection: 'keep-alive', 'content-type': 'text/html' },
    ['https://dash.example'],
  );
  assert.equal('x-frame-options' in headers, false);
  assert.equal('set-cookie' in headers, false);
  assert.equal('connection' in headers, false);
  assert.equal(headers['content-security-policy'], "default-src 'self'; frame-ancestors https://dash.example");
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(cspWithFrameAncestors('', ['https://a.example', 'https://b.example']), 'frame-ancestors https://a.example https://b.example');
});

test('drops the gate cookie and forwarding headers before the app sees a request', () => {
  const headers = buildUpstreamHeaders(
    { host: 'evil.hf.space', cookie: '__Host-gev_session=secret', authorization: 'Bearer x', 'x-forwarded-for': '1.2.3.4', accept: '*/*', connection: 'keep-alive' },
    { host: '127.0.0.1', port: 4173 },
  );
  assert.deepEqual(headers, { accept: '*/*', host: '127.0.0.1:4173' });
});

test('runtime dist swaps the placeholder for the token and leaves no placeholder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-dist-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(src, 'cesium'), { recursive: true });
    fs.writeFileSync(path.join(src, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(src, 'assets', 'index-1.js'), `x({cesiumToken:"${CESIUM_PLACEHOLDER}"});y("${CESIUM_PLACEHOLDER}")`);
    fs.writeFileSync(path.join(src, 'cesium', 'big.js'), CESIUM_PLACEHOLDER);
    const token = 'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuv';
    const dest = path.join(root, 'dest');
    const result = prepareRuntimeDist({ srcDir: src, destDir: dest, token });
    assert.deepEqual(result, { filesChanged: 1, occurrences: 2, tokenApplied: true });
    const built = fs.readFileSync(path.join(dest, 'assets', 'index-1.js'), 'utf8');
    assert.equal(built.includes(CESIUM_PLACEHOLDER), false);
    assert.equal(built.split(token).length - 1, 2);
    // The source build stays untouched so the image layer never holds the token.
    assert.equal(fs.readFileSync(path.join(src, 'assets', 'index-1.js'), 'utf8').includes(CESIUM_PLACEHOLDER), true);
    const keyless = prepareRuntimeDist({ srcDir: src, destDir: dest, token: '' });
    assert.equal(keyless.tokenApplied, false);
    assert.equal(fs.readFileSync(path.join(dest, 'assets', 'index-1.js'), 'utf8'), 'x({cesiumToken:""});y("")');
    assert.throws(() => prepareRuntimeDist({ srcDir: path.join(root, 'missing'), destDir: dest }), /build output not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('encoded dot segments cannot reach a blocked route by collapsing into it', () => {
  for (const raw of ['/api/x/%2e%2e/setup/status', '/api/x/%2E%2E/setup/status', '/api/./setup/status', '/api/x/../setup/status']) {
    assert.equal(normalizeRequestTarget(raw).ok, false, raw);
  }
});
