// Runtime configuration for the TITAN-GEV wrapper. Every value comes from the
// environment. The wrapper holds no secret of its own. GEV_VERIFY_KEY is a public
// key, and the session key is random bytes made at start. Neither reaches a log.
import { randomBytes } from 'node:crypto';
import { importVerifyKey } from './token.mjs';

/** Only the dashboard origin may frame the app unless the operator widens this. */
export const DEFAULT_FRAME_ANCESTORS = ['https://shreyas-tech7.github.io'];

const CESIUM_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

function intFrom(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Keep only well-formed http(s) origins. Wildcards, paths, and junk are dropped. */
export function parseOrigins(value) {
  if (typeof value !== 'string') return [];
  const origins = [];
  for (const raw of value.split(/[\s,]+/)) {
    if (!raw || raw.includes('*')) continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.origin !== raw.replace(/\/+$/, '')) continue;
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

export function loadConfig(env = process.env) {
  const verifyKey = importVerifyKey((env.GEV_VERIFY_KEY ?? '').trim());
  const configuredAncestors = parseOrigins(env.GEV_FRAME_ANCESTORS);
  const cesiumRaw = (env.CESIUM_ION_TOKEN ?? '').trim();
  return {
    listenHost: env.GEV_LISTEN_HOST || '0.0.0.0',
    // GEV_LISTEN_PORT wins, then PORT (Render sets it), then the Hugging Face port.
    listenPort: intFrom(env.GEV_LISTEN_PORT, intFrom(env.PORT, 7860, { min: 1, max: 65535 }), { min: 1, max: 65535 }),
    upstream: {
      host: '127.0.0.1',
      port: intFrom(env.GEV_UPSTREAM_PORT, 4173, { min: 1, max: 65535 }),
    },
    // The public key that checks access tokens. Null when GEV_VERIFY_KEY is missing or malformed.
    verifyKey,
    verifyKeyOk: verifyKey !== null,
    // Signs session cookies. Random per process, so a restart ends every session.
    sessionKey: randomBytes(32),
    frameAncestors: configuredAncestors.length > 0 ? configuredAncestors : DEFAULT_FRAME_ANCESTORS,
    tokenMaxLifetimeSeconds: intFrom(env.GEV_TOKEN_MAX_LIFETIME_SECONDS, 600, { min: 30, max: 900 }),
    clockSkewSeconds: intFrom(env.GEV_CLOCK_SKEW_SECONDS, 30, { min: 0, max: 120 }),
    sessionIdleSeconds: intFrom(env.GEV_SESSION_IDLE_SECONDS, 1800, { min: 60, max: 7200 }),
    sessionMaxSeconds: intFrom(env.GEV_SESSION_MAX_SECONDS, 21600, { min: 300, max: 43200 }),
    rateUnauthPerMinute: intFrom(env.GEV_RATE_UNAUTH_PER_MIN, 30, { min: 1 }),
    rateHealthPerMinute: intFrom(env.GEV_RATE_HEALTH_PER_MIN, 120, { min: 1 }),
    rateApiPerMinute: intFrom(env.GEV_RATE_API_PER_MIN, 1200, { min: 1 }),
    trustProxyHops: intFrom(env.GEV_TRUST_PROXY_HOPS, 1, { min: 0, max: 5 }),
    // Name of a header that the host's edge sets to the real client address, for example
    // cf-connecting-ip on Render. When set, X-Forwarded-For is never used.
    clientIpHeader: /^[a-z0-9-]{1,64}$/.test((env.GEV_CLIENT_IP_HEADER ?? '').trim().toLowerCase())
      ? (env.GEV_CLIENT_IP_HEADER ?? '').trim().toLowerCase()
      : '',
    // The app process gets a V8 heap cap so a busy minute cannot push the container past a 512 MB limit.
    appHeapMb: intFrom(env.GEV_APP_HEAP_MB, 256, { min: 64, max: 2048 }),
    viteConfigLoader: ['native', 'bundle', 'runner'].includes(env.GEV_VITE_CONFIG_LOADER)
      ? env.GEV_VITE_CONFIG_LOADER
      : 'native',
    maxBodyBytes: intFrom(env.GEV_MAX_BODY_BYTES, 1_048_576, { min: 1024 }),
    upstreamTimeoutMs: intFrom(env.GEV_UPSTREAM_TIMEOUT_MS, 60_000, { min: 1000 }),
    allowPaidRoutes: env.GEV_ALLOW_PAID_ROUTES === '1',
    cesiumIonToken: CESIUM_TOKEN_RE.test(cesiumRaw) ? cesiumRaw : '',
    cesiumIonTokenRejected: cesiumRaw !== '' && !CESIUM_TOKEN_RE.test(cesiumRaw),
  };
}

// Environment the app process may see. Provider keys that are free to obtain pass
// through. The verify key, the Hugging Face token, the Cesium token (applied to
// the built files by the wrapper), and the paid OpenAI and Google keys stay out.
const CHILD_ENV_EXACT = new Set(['PATH', 'HOME', 'LANG', 'TZ', 'NODE_ENV', 'TMPDIR']);
const CHILD_ENV_PREFIXES = [
  'OPENSKY_',
  'TOMTOM_',
  'FIRMS_',
  'AISSTREAM_',
  'LL2_',
  'CCTV_',
  'OVERPASS_',
  'LOCAL_RECEIVER_',
  'VITE_AIS_',
];

export function childEnv(env, { upstreamPort, heapMb = 256 }) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CHILD_ENV_EXACT.has(key) || CHILD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      out[key] = value;
    }
  }
  out.HOST = '127.0.0.1';
  out.PORT = String(upstreamPort);
  out.NODE_OPTIONS = `--max-old-space-size=${heapMb}`;
  return out;
}
