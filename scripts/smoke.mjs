// End to end check. Starts the real wrapper in front of the real built app,
// exercises the gate over HTTP, then stops everything it started.
// Run after `npm run upstream:fetch` and `npm run upstream:build`.
// The shared secret is random per run. Nothing here is a real credential.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signAccessToken } from '../server/token.mjs';
import { CESIUM_PLACEHOLDER } from '../server/prepare-dist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.resolve(process.env.GEV_APP_DIR || path.join(root, '.upstream'));
const PARENT = 'https://smoke.example';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

async function get(base, pathname, headers = {}) {
  const response = await fetch(`${base}${pathname}`, { headers, redirect: 'manual' });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function waitForReady(base, child) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('wrapper exited before it became ready');
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('wrapper did not become ready in 180 seconds');
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const secret = randomBytes(24).toString('hex');
const cesiumDummy = `smoke.${randomBytes(18).toString('hex')}`;
const port = await freePort();
const upstreamPort = await freePort();
const runtimeDist = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-smoke-'));
const base = `http://127.0.0.1:${port}`;
const output = [];

const child = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GEV_APP_DIR: appDir,
    GEV_LISTEN_HOST: '127.0.0.1',
    GEV_LISTEN_PORT: String(port),
    GEV_UPSTREAM_PORT: String(upstreamPort),
    GEV_RUNTIME_DIST: runtimeDist,
    GEV_SHARED_SECRET: secret,
    GEV_FRAME_ANCESTORS: PARENT,
    CESIUM_ION_TOKEN: cesiumDummy,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));

let dump = '';
try {
  await waitForReady(base, child);
  const seen = [];

  const health = await get(base, '/healthz', { origin: PARENT });
  seen.push(health);
  check('healthz is public and ready', health.status === 200 && JSON.parse(health.text).status === 'ready');
  check('healthz allows only the dashboard origin', health.headers.get('access-control-allow-origin') === PARENT);

  const noToken = await get(base, '/', { 'sec-fetch-dest': 'iframe' });
  seen.push(noToken);
  check('no token returns 401', noToken.status === 401);

  const expired = signAccessToken(secret, { nowMs: Date.now() - 400_000 });
  const expiredResponse = await get(base, `/?gev_token=${expired}`);
  seen.push(expiredResponse);
  check('expired token is rejected', expiredResponse.status === 401);

  const wrongKey = signAccessToken(randomBytes(24).toString('hex'), {});
  const wrongResponse = await get(base, `/?gev_token=${wrongKey}`);
  seen.push(wrongResponse);
  check('token signed with another secret is rejected', wrongResponse.status === 401);

  const valid = signAccessToken(secret, {});
  const redeemed = await get(base, `/?gev_token=${valid}`, { 'sec-fetch-dest': 'iframe' });
  seen.push(redeemed);
  check('valid token returns 200', redeemed.status === 200);
  const setCookie = redeemed.headers.get('set-cookie') || '';
  check('cookie is Secure, HttpOnly, SameSite=None, Partitioned', ['Secure', 'HttpOnly', 'SameSite=None', 'Partitioned'].every((part) => setCookie.includes(part)));
  const cookie = setCookie.split(';')[0];

  const replay = await get(base, `/?gev_token=${valid}`);
  seen.push(replay);
  check('replaying a token is rejected', replay.status === 401);

  const home = await get(base, '/', { cookie });
  seen.push(home);
  check('the session cookie loads the app', home.status === 200 && /God's Eye View/.test(home.text));
  const csp = home.headers.get('content-security-policy') || '';
  check('frame-ancestors names only the dashboard', csp.includes(`frame-ancestors ${PARENT}`) && !csp.includes("'none'"));
  check('X-Frame-Options is gone', home.headers.get('x-frame-options') === null);

  const bundle = /\/assets\/index-[^"']+\.js/.exec(home.text)?.[0];
  const bundleResponse = bundle ? await get(base, bundle, { cookie }) : { text: '' };
  check('the app bundle loads through the gate', Boolean(bundle) && bundleResponse.status === 200);
  check('the Cesium token was applied at start', bundleResponse.text.includes(cesiumDummy));
  check('no placeholder is left in the served bundle', !bundleResponse.text.includes(CESIUM_PLACEHOLDER));

  const setup = await get(base, '/api/setup/status', { cookie });
  seen.push(setup);
  check('Provider Settings is off for a valid session', setup.status === 404);
  const voice = await get(base, '/api/realtime/token', { cookie });
  seen.push(voice);
  check('paid voice route is off', voice.status === 404);
  const unknown = await get(base, '/api/not-a-route', { cookie });
  seen.push(unknown);
  check('an API path reaches the app and gets its 404', unknown.status === 404 && /Unknown API route/.test(unknown.text));
  const probe = await get(base, '/__gev/session', { cookie });
  check('session probe answers 204', probe.status === 204);

  dump = JSON.stringify(seen.map((entry) => [entry.status, [...entry.headers], entry.text.length > 200000 ? '' : entry.text]));
  check('the shared secret appears in no response', !dump.includes(secret));
} catch (error) {
  check('smoke run completed', false, error.message);
} finally {
  await stop(child);
  fs.rmSync(runtimeDist, { recursive: true, force: true });
}

const logs = output.join('');
check('the shared secret appears in no log line', !logs.includes(secret));
check('the Cesium token appears in no log line', !logs.includes(cesiumDummy));
const stillListening = await fetch(`${base}/healthz`).then(() => true, () => false);
check('everything the test started is stopped', !stillListening);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed. Last log lines:\n${logs.split('\n').slice(-25).join('\n')}`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
