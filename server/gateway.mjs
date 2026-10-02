// The TITAN-GEV gateway. It sits in front of the God's Eye View preview server.
//
// Every request except /healthz needs a valid session cookie. The cookie comes from
// redeeming a short lived access token that the TITAN Worker mints. The gateway
// never reflects why a request failed, never logs a query string, and never logs
// a key or a cookie.
import http from 'node:http';
import net from 'node:net';
import {
  SESSION_COOKIE_NAME,
  issueSession,
  shouldRenewSession,
  verifyAccessToken,
  verifySession,
} from './token.mjs';
import { classifyPath, normalizeRequestTarget } from './paths.mjs';
import { TokenBucketLimiter } from './ratelimit.mjs';
import { buildResponseHeaders, buildUpstreamHeaders, cspWithFrameAncestors, jsonForScript } from './headers.mjs';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const TOKEN_PARAM = 'gev_token';

export function createGateway({ config, upstreamReady = () => true, now = Date.now, log = console }) {
  const unauthLimiter = new TokenBucketLimiter({ perMinute: config.rateUnauthPerMinute, now });
  const healthLimiter = new TokenBucketLimiter({ perMinute: config.rateHealthPerMinute, now });
  const apiLimiter = new TokenBucketLimiter({ perMinute: config.rateApiPerMinute, now });
  const usedTokenIds = new Map();
  const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  const frameAncestorsPolicy = cspWithFrameAncestors('', config.frameAncestors);
  const baseHeaders = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': frameAncestorsPolicy,
  };

  function send(res, status, headers, body) {
    res.writeHead(status, { ...baseHeaders, ...headers });
    res.end(body);
  }

  function sendJson(res, status, payload, headers = {}) {
    send(res, status, { 'content-type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(payload));
  }

  function sendText(res, status, text, headers = {}) {
    send(res, status, { 'content-type': 'text/plain; charset=utf-8', ...headers }, `${text}\n`);
  }

  function clientIp(req) {
    const socketAddress = req.socket.remoteAddress || 'unknown';
    // A host edge that sets a trusted header (cf-connecting-ip on Render) wins. When that header
    // is configured but missing or malformed, fall back to the socket address and never to
    // X-Forwarded-For, whose first entries a client can write.
    if (config.clientIpHeader) {
      const raw = req.headers[config.clientIpHeader];
      const value = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0].trim();
      return value && net.isIP(value) ? value : socketAddress;
    }
    const forwarded = req.headers['x-forwarded-for'];
    if (config.trustProxyHops > 0 && typeof forwarded === 'string' && forwarded) {
      const hops = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
      if (hops.length > 0) return hops[Math.max(0, hops.length - config.trustProxyHops)];
    }
    return socketAddress;
  }

  function readCookie(header, name) {
    if (!header) return null;
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
    }
    return null;
  }

  function sessionCookie(issued) {
    return `${SESSION_COOKIE_NAME}=${issued.value}; Max-Age=${issued.maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`;
  }

  function authenticate(req) {
    if (!config.verifyKeyOk) return null;
    const value = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    if (!value) return null;
    const result = verifySession(config.sessionKey, value, {
      nowMs: now(),
      maxSeconds: config.sessionMaxSeconds,
      skewSeconds: config.clockSkewSeconds,
    });
    return result.ok ? result : null;
  }

  function renewedCookie(session) {
    const policy = { nowMs: now(), idleSeconds: config.sessionIdleSeconds, maxSeconds: config.sessionMaxSeconds };
    if (!shouldRenewSession(session, policy)) return null;
    return sessionCookie(issueSession(config.sessionKey, { ...policy, sid: session.sid, start: session.start }));
  }

  function wantsDocument(req) {
    const dest = req.headers['sec-fetch-dest'];
    if (dest) return dest === 'document' || dest === 'iframe';
    return String(req.headers.accept || '').includes('text/html');
  }

  function notifyParentScript(type) {
    return `<script>(function(){var t=${jsonForScript(type)};var o=${jsonForScript(config.frameAncestors)};` +
      'for(var i=0;i<o.length;i++){try{parent.postMessage({type:t},o[i])}catch(e){}}})()</script>';
  }

  const pageStyle =
    '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#c9d1d9;' +
    'font:14px/1.5 ui-monospace,Menlo,monospace}main{max-width:32rem;padding:1.5rem;text-align:center}' +
    'h1{font-size:1rem;letter-spacing:.08em;margin:0 0 .5rem}p{margin:.25rem 0;color:#8b949e}</style>';

  function unauthorized(req, res) {
    if (wantsDocument(req)) {
      const page =
        `<!doctype html><meta charset="utf-8"><title>401 Unauthorized</title>${pageStyle}` +
        '<main><h1>401 UNAUTHORIZED</h1><p>A valid access link is required to view this page.</p></main>' +
        notifyParentScript('gev-unauthorized');
      send(res, 401, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' }, page);
    } else {
      sendText(res, 401, '401 Unauthorized');
    }
  }

  function tooManyRequests(res, retryAfterSeconds) {
    sendText(res, 429, '429 Too Many Requests', { 'retry-after': String(retryAfterSeconds) });
  }

  function pruneUsedTokenIds(nowSeconds) {
    for (const [id, exp] of usedTokenIds) {
      if (exp + config.clockSkewSeconds < nowSeconds) usedTokenIds.delete(id);
    }
  }

  // The landing page for a redeemed token. It checks that the browser kept the
  // cookie, then swaps the URL for a clean one so the token never stays in history.
  function sendBootstrap(res, cleanTarget, cookie) {
    const page =
      `<!doctype html><meta charset="utf-8"><title>TITAN GEV</title>${pageStyle}` +
      '<main><h1>GOD\'S EYE VIEW</h1><p id="m">Starting session</p></main>' +
      `<script>(async function(){var target=${jsonForScript(cleanTarget)};var origins=${jsonForScript(config.frameAncestors)};` +
      "try{var r=await fetch('/__gev/session',{cache:'no-store',credentials:'same-origin'});" +
      'if(r.ok){location.replace(target);return}}catch(e){}' +
      "document.getElementById('m').textContent='Your browser blocked the session cookie for this embedded view. Use Open full screen in TITAN.';" +
      "for(var i=0;i<origins.length;i++){try{parent.postMessage({type:'gev-session-blocked'},origins[i])}catch(e){}}})()</script>";
    send(res, 200, {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'set-cookie': cookie,
    }, page);
  }

  function handleHealth(req, res, ip) {
    const limited = healthLimiter.take(`health:${ip}`);
    if (!limited.ok) return tooManyRequests(res, limited.retryAfterSeconds);
    const headers = { vary: 'Origin' };
    const origin = req.headers.origin;
    if (origin && config.frameAncestors.includes(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-methods'] = 'GET, OPTIONS';
      headers['access-control-max-age'] = '600';
    }
    if (req.method === 'OPTIONS') return send(res, 204, headers);
    const ready = upstreamReady();
    return sendJson(res, ready ? 200 : 503, { ok: ready, service: 'titan-gev', status: ready ? 'ready' : 'starting' }, headers);
  }

  function proxy(req, res, { path, setCookie }) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      return sendJson(res, 413, { error: 'Request too large' });
    }
    const upstreamRequest = http.request(
      {
        host: config.upstream.host,
        port: config.upstream.port,
        method: req.method,
        path,
        headers: buildUpstreamHeaders(req.headers, config.upstream),
        agent: upstreamAgent,
      },
      (upstreamResponse) => {
        const headers = buildResponseHeaders(upstreamResponse.headers, config.frameAncestors);
        if (setCookie) headers['set-cookie'] = setCookie;
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
        upstreamResponse.pipe(res);
      },
    );
    upstreamRequest.setTimeout(config.upstreamTimeoutMs, () => {
      upstreamRequest.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
    });
    upstreamRequest.on('error', (error) => {
      if (res.headersSent) return res.destroy();
      return sendJson(res, error.code === 'ETIMEDOUT' ? 504 : 502, { error: 'Upstream unavailable' });
    });
    res.on('close', () => {
      if (!res.writableEnded) upstreamRequest.destroy();
    });
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > config.maxBodyBytes) {
        upstreamRequest.destroy();
        if (!res.headersSent) sendJson(res, 413, { error: 'Request too large' });
        req.destroy();
      }
    });
    req.pipe(upstreamRequest);
  }

  async function route(req, res) {
    if (!ALLOWED_METHODS.has(req.method)) {
      return sendText(res, 405, '405 Method Not Allowed', { allow: 'GET, HEAD, POST, OPTIONS' });
    }
    const target = normalizeRequestTarget(req.url);
    if (!target.ok) return sendText(res, 400, '400 Bad Request');
    const ip = clientIp(req);

    if (target.matchPath === '/healthz') return handleHealth(req, res, ip);
    if (req.method === 'OPTIONS') return sendText(res, 405, '405 Method Not Allowed', { allow: 'GET, HEAD, POST' });

    const session = authenticate(req);

    if (!session) {
      // Only failed attempts spend the unauthenticated budget. A valid redemption never does,
      // so one noisy visitor behind the same address cannot lock out a real session start.
      const reject = () => {
        const limited = unauthLimiter.take(`unauth:${ip}`);
        return limited.ok ? unauthorized(req, res) : tooManyRequests(res, limited.retryAfterSeconds);
      };
      const token = req.method === 'POST' ? null : target.searchParams.get(TOKEN_PARAM);
      if (!token || !config.verifyKeyOk) return reject();
      const nowMs = now();
      const verdict = verifyAccessToken(config.verifyKey, token, {
        nowMs,
        maxLifetimeSeconds: config.tokenMaxLifetimeSeconds,
        skewSeconds: config.clockSkewSeconds,
      });
      pruneUsedTokenIds(Math.floor(nowMs / 1000));
      if (!verdict.ok || usedTokenIds.has(verdict.jti)) return reject();
      usedTokenIds.set(verdict.jti, verdict.exp);
      const issued = issueSession(config.sessionKey, {
        nowMs,
        idleSeconds: config.sessionIdleSeconds,
        maxSeconds: config.sessionMaxSeconds,
      });
      const rest = new URLSearchParams(target.searchParams);
      rest.delete(TOKEN_PARAM);
      const query = rest.toString();
      return sendBootstrap(res, `${target.pathname}${query ? `?${query}` : ''}`, sessionCookie(issued));
    }

    const setCookie = renewedCookie(session);

    if (target.matchPath === '/__gev/session') {
      return send(res, 204, setCookie ? { 'set-cookie': setCookie } : {});
    }

    const kind = classifyPath(target.matchPath, { allowPaidRoutes: config.allowPaidRoutes });
    if (kind === 'reserved' || kind === 'blocked') {
      return sendJson(res, 404, { error: kind === 'blocked' ? 'Unknown API route' : 'Not found' });
    }
    if (!upstreamReady()) {
      return sendJson(res, 503, { error: 'Starting up' }, { 'retry-after': '5' });
    }
    if (kind === 'api') {
      const limited = apiLimiter.take(`api:${session.sid}`);
      if (!limited.ok) return tooManyRequests(res, limited.retryAfterSeconds);
    }

    const rest = new URLSearchParams(target.searchParams);
    rest.delete(TOKEN_PARAM);
    const query = rest.toString();
    return proxy(req, res, { path: `${target.pathname}${query ? `?${query}` : ''}`, setCookie });
  }

  function handler(req, res) {
    route(req, res).catch((error) => {
      log.error(`[gev] request failed: ${error?.code || error?.name || 'error'}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.destroy();
    });
  }

  const server = http.createServer(handler);
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  // The app needs no WebSocket through the gate, so refuse every upgrade.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  return {
    server,
    handler,
    close() {
      upstreamAgent.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
