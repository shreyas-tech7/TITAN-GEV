// Check a live TITAN-GEV host from the outside.
//
//   npm run verify:live -- https://titan-gev.onrender.com
//
// The script asks for GEV_SHARED_SECRET with hidden input, so the value never
// appears in shell history, process arguments, or output. Set GEV_SHARED_SECRET
// in the environment instead for a non-interactive run. Set GEV_DASHBOARD_ORIGIN
// when the dashboard is not https://shreyas-tech7.github.io.
//
// It prints pass or fail lines only. It never prints a token, a cookie, or the secret.
import { signAccessToken } from '../server/token.mjs';

const base = (process.argv[2] || process.env.GEV_URL || '').replace(/\/+$/, '');
const dashboard = process.env.GEV_DASHBOARD_ORIGIN || 'https://shreyas-tech7.github.io';

if (!/^https?:\/\//.test(base)) {
  console.error('Usage: npm run verify:live -- <host URL>');
  process.exit(2);
}

function readSecret() {
  const fromEnv = (process.env.GEV_SHARED_SECRET || '').trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  if (!process.stdin.isTTY) {
    console.error('Set GEV_SHARED_SECRET, or run this in a terminal to type it with hidden input.');
    process.exit(2);
  }
  process.stdout.write('Paste GEV_SHARED_SECRET (input is hidden), then press Enter: ');
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') process.exit(130);
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

async function get(pathname, headers = {}) {
  const response = await fetch(`${base}${pathname}`, { headers, redirect: 'manual' });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const secret = await readSecret();
if (secret.length < 32) {
  console.error('The secret is shorter than 32 characters. The gate refuses to run with a weak secret.');
  process.exit(2);
}

const seen = [];
const record = (response) => {
  seen.push(JSON.stringify([response.status, [...response.headers], response.text.length > 400_000 ? '' : response.text]));
  return response;
};

// A sleeping host needs a minute. Wake it and wait.
let health = null;
for (let attempt = 0; attempt < 40 && !health; attempt += 1) {
  try {
    const response = record(await get('/healthz', { origin: dashboard }));
    if (response.status === 200) health = response;
  } catch {
    // not awake yet
  }
  if (!health) await new Promise((resolve) => setTimeout(resolve, 5000));
}
check('the host answers /healthz', health !== null, 'no answer after about 3 minutes');
if (!health) process.exit(1);

check('healthz identifies the gateway', /"service":"titan-gev"/.test(health.text));
check('healthz allows the dashboard origin for CORS', health.headers.get('access-control-allow-origin') === dashboard, String(health.headers.get('access-control-allow-origin')));

const noToken = record(await get('/', { 'sec-fetch-dest': 'iframe' }));
check('no token returns 401', noToken.status === 401, String(noToken.status));

const expired = signAccessToken(secret, { nowMs: Date.now() - 400_000 });
check('an expired token is rejected', record(await get(`/?gev_token=${expired}`)).status === 401);

const wrong = signAccessToken(`${secret}-wrong`, {});
check('a token signed with another secret is rejected', record(await get(`/?gev_token=${wrong}`)).status === 401);

const valid = signAccessToken(secret, {});
const redeemed = record(await get(`/?gev_token=${valid}`, { 'sec-fetch-dest': 'iframe' }));
check('a valid token returns 200', redeemed.status === 200, String(redeemed.status));
const setCookie = redeemed.headers.get('set-cookie') || '';
check('the cookie is Secure, HttpOnly, SameSite=None, and Partitioned', ['Secure', 'HttpOnly', 'SameSite=None', 'Partitioned'].every((part) => setCookie.includes(part)));
check('the token cannot be used twice', record(await get(`/?gev_token=${valid}`)).status === 401);

const cookie = setCookie.split(';')[0];
const home = record(await get('/', { cookie }));
check('the session cookie loads the app', home.status === 200 && /God's Eye View/.test(home.text), String(home.status));
const csp = home.headers.get('content-security-policy') || '';
check('frame-ancestors allows the dashboard and not everyone', csp.includes(`frame-ancestors ${dashboard}`) && !csp.includes("'none'") && !csp.includes('frame-ancestors *'), csp.slice(0, 120));
check('X-Frame-Options is absent', home.headers.get('x-frame-options') === null);
check('Provider Settings is off', record(await get('/api/setup/status', { cookie })).status === 404);
check('the paid voice route is off', record(await get('/api/realtime/token', { cookie })).status === 404);
check('the secret appears in no response', !seen.some((entry) => entry.includes(secret)));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll live checks passed. Open the dashboard tab to confirm the globe.');
