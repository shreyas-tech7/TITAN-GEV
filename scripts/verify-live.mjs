// Check a live TITAN-GEV host from the outside. It needs no secret.
//
//   GEV_TOKEN=<fresh token> npm run verify:live -- https://titan-gev.onrender.com
//
// GEV_TOKEN is a freshly minted access token. Mint one from the TITAN Worker with
// GET /gev/token (the live check workflow in TITAN-Runner does this). A token works
// once, so mint a new one for every run. Set GEV_DASHBOARD_ORIGIN when the dashboard
// is not https://shreyas-tech7.github.io.
//
// It prints PASS and FAIL lines only. It never prints a token or a cookie.
import { generateKeyPairSync } from 'node:crypto';
import { signAccessToken } from '../server/token.mjs';

const base = (process.argv[2] || process.env.GEV_URL || '').replace(/\/+$/, '');
const dashboard = process.env.GEV_DASHBOARD_ORIGIN || 'https://shreyas-tech7.github.io';
const minted = (process.env.GEV_TOKEN || '').trim();

if (!/^https?:\/\//.test(base) || !minted) {
  console.error('Usage: GEV_TOKEN=<fresh token> npm run verify:live -- <host URL>');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
}

async function get(pathname, headers = {}) {
  const response = await fetch(`${base}${pathname}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const seen = [];
const record = (response) => {
  seen.push(JSON.stringify([response.status, [...response.headers], response.text.length > 400_000 ? '' : response.text]));
  return response;
};

// A sleeping free host needs a minute or two. Wake it and wait.
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

// A token that is well formed and signed by a key the host does not trust.
const attacker = generateKeyPairSync('ed25519');
const forged = signAccessToken(attacker.privateKey, {});
check('a token signed by a throwaway attacker key returns 401', record(await get(`/?gev_token=${forged}`)).status === 401);

const redeemed = record(await get(`/?gev_token=${minted}`, { 'sec-fetch-dest': 'iframe' }));
check('the minted token returns 200', redeemed.status === 200, String(redeemed.status));
const setCookie = redeemed.headers.get('set-cookie') || '';
check('the cookie is Secure, HttpOnly, SameSite=None, and Partitioned', ['Secure', 'HttpOnly', 'SameSite=None', 'Partitioned'].every((part) => setCookie.includes(part)));
check('the same token fails a second time', record(await get(`/?gev_token=${minted}`)).status === 401);

const cookie = setCookie.split(';')[0];
const cookieValue = cookie.split('=').slice(1).join('=');
const home = record(await get('/', { cookie }));
check('the session cookie loads the app', home.status === 200 && /God's Eye View/.test(home.text), String(home.status));
const csp = home.headers.get('content-security-policy') || '';
const ancestors = /(?:^|;\s*)frame-ancestors\s+([^;]*)/i.exec(csp)?.[1].trim().split(/\s+/) ?? [];
check('frame-ancestors names only the dashboard origin', ancestors.length === 1 && ancestors[0] === dashboard, csp.slice(0, 120));
check('X-Frame-Options is absent', home.headers.get('x-frame-options') === null);
check('/api/setup/status returns 404', record(await get('/api/setup/status', { cookie })).status === 404);
check('/api/realtime/token returns 404', record(await get('/api/realtime/token', { cookie })).status === 404);

// Bodies only. The redemption response legitimately carries the cookie in its Set-Cookie header.
const bodies = seen.map((entry) => JSON.parse(entry)[2]);
check('the token and the cookie appear in no response body', !bodies.some((body) => body.includes(minted) || (cookieValue && body.includes(cookieValue))));

process.exit(failures > 0 ? 1 : 0);
