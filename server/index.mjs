// TITAN-GEV entry point.
//   1. Copy the built app and apply the Cesium ion token from the environment.
//   2. Start the app's preview server on loopback.
//   3. Start the gateway on 0.0.0.0, the only listener the outside world can reach.
// If the app process exits, this process exits too so the host restarts the container.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { childEnv, loadConfig } from './config.mjs';
import { createGateway } from './gateway.mjs';
import { prepareRuntimeDist } from './prepare-dist.mjs';

const config = loadConfig(process.env);
const appDir = path.resolve(process.env.GEV_APP_DIR || '/app/upstream');
const runtimeDist = process.env.GEV_RUNTIME_DIST || path.join(os.tmpdir(), 'gev-dist');
const READY_TIMEOUT_MS = 180_000;

let upstreamIsReady = false;
let child = null;
let shuttingDown = false;

function log(message) {
  console.log(`[gev] ${message}`);
}

if (config.cesiumIonTokenRejected) {
  log('CESIUM_ION_TOKEN has an unexpected shape and was ignored. The globe starts on the keyless basemap.');
}
const prepared = prepareRuntimeDist({
  srcDir: path.join(appDir, 'dist'),
  destDir: runtimeDist,
  token: config.cesiumIonToken,
});
log(
  prepared.tokenApplied
    ? 'Cesium ion token applied to the runtime build.'
    : 'No Cesium ion token set. The globe starts on the keyless basemap.',
);
if (!config.secretOk) {
  log('GEV_SHARED_SECRET is missing or shorter than 32 characters. Every gated route will return 401.');
}

const gateway = createGateway({ config, upstreamReady: () => upstreamIsReady, log: console });
gateway.server.listen(config.listenPort, config.listenHost, () => {
  log(`gateway listening on ${config.listenHost}:${config.listenPort}`);
});

const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
child = spawn(
  process.execPath,
  [
    viteBin,
    'preview',
    '--host', '127.0.0.1',
    '--port', String(config.upstream.port),
    '--strictPort',
    '--outDir', runtimeDist,
    // The native loader skips the esbuild bundling step. That saves about 250 MB of memory.
    '--configLoader', config.viteConfigLoader,
  ],
  {
    cwd: appDir,
    env: childEnv(process.env, { upstreamPort: config.upstream.port, heapMb: config.appHeapMb }),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
child.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`));
child.stderr.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`));
child.on('exit', (code, signal) => {
  if (shuttingDown) return;
  log(`app process exited (code ${code}, signal ${signal}). Stopping so the host restarts the container.`);
  process.exit(1);
});

function probeUpstream() {
  return new Promise((resolve) => {
    const request = http.get(
      { host: config.upstream.host, port: config.upstream.port, path: '/', headers: { host: `${config.upstream.host}:${config.upstream.port}` }, timeout: 2000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

const startedAt = Date.now();
const readyTimer = setInterval(async () => {
  if (upstreamIsReady) return;
  if (await probeUpstream()) {
    upstreamIsReady = true;
    clearInterval(readyTimer);
    log(`app ready after ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } else if (Date.now() - startedAt > READY_TIMEOUT_MS) {
    log('app did not become ready in time. Exiting.');
    shutdown(1);
  }
}, 500);

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(readyTimer);
  if (child && !child.killed) child.kill('SIGTERM');
  gateway.close().finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
