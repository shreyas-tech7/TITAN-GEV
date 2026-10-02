// Runs scripts/verify-live.mjs against a real gateway in front of a stub app, the way the
// live check workflow runs it against the real host. It proves the script passes on a
// correct host, fails on a wrong one, and never prints the token or the cookie.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { createGateway } from '../server/gateway.mjs';
import { signAccessToken } from '../server/token.mjs';

const script = fileURLToPath(new URL('../scripts/verify-live.mjs', import.meta.url));
const DASHBOARD = 'https://shreyas-tech7.github.io';
const silent = { warn() {}, error() {}, log() {} };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function startHost({ trustedKeyX, frameAncestors = DASHBOARD } = {}) {
  const pair = generateKeyPairSync('ed25519');
  const x = trustedKeyX ?? pair.publicKey.export({ format: 'jwk' }).x;
  const app = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
    res.end("<html>God's Eye View</html>");
  });
  const appPort = await listen(app);
  const config = loadConfig({ GEV_VERIFY_KEY: x, GEV_FRAME_ANCESTORS: frameAncestors, GEV_UPSTREAM_PORT: String(appPort) });
  const gateway = createGateway({ config, upstreamReady: () => true, log: silent });
  const port = await listen(gateway.server);
  return {
    url: `http://127.0.0.1:${port}`,
    mint: () => signAccessToken(pair.privateKey),
    async stop() {
      await gateway.close();
      await new Promise((resolve) => app.close(resolve));
    },
  };
}

function runVerify(url, token) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, url], { env: { PATH: process.env.PATH, GEV_TOKEN: token } });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => resolve({ code, output }));
  });
}

test('verify-live passes every check on a correct host and prints PASS lines only', async () => {
  const host = await startHost();
  try {
    const token = host.mint();
    const { code, output } = await runVerify(host.url, token);
    assert.equal(code, 0, output);
    const lines = output.trim().split('\n');
    assert.ok(lines.length >= 14, `expected the full check list, got ${lines.length}`);
    for (const line of lines) assert.match(line, /^PASS {2}/, line);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes('__Host-gev_session'), false);
    assert.equal(output.includes('gevs1.'), false);
  } finally {
    await host.stop();
  }
});

test('verify-live fails when the host trusts a different key', async () => {
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const host = await startHost({ trustedKeyX: other });
  try {
    const { code, output } = await runVerify(host.url, host.mint());
    assert.equal(code, 1);
    assert.match(output, /^FAIL {2}the minted token returns 200/m);
  } finally {
    await host.stop();
  }
});

test('verify-live fails when the host lets another origin frame it', async () => {
  const host = await startHost({ frameAncestors: 'https://evil.example' });
  try {
    const { code, output } = await runVerify(host.url, host.mint());
    assert.equal(code, 1);
    assert.match(output, /^FAIL {2}frame-ancestors names only the dashboard origin/m);
  } finally {
    await host.stop();
  }
});

test('verify-live asks for a token instead of a secret', async () => {
  const { code, output } = await runVerify('http://127.0.0.1:9', '');
  assert.equal(code, 2);
  assert.match(output, /GEV_TOKEN/);
});
