// Header handling for the reverse proxy.

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Request headers the app never needs. The gate cookie and any caller-supplied
// forwarding headers stay behind the wrapper.
const DROP_REQUEST = new Set([
  'host',
  'cookie',
  'authorization',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

export function buildUpstreamHeaders(requestHeaders, upstream) {
  const out = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || DROP_REQUEST.has(key)) continue;
    out[key] = value;
  }
  // The app only accepts loopback host names, so present the one it expects.
  out.host = `${upstream.host}:${upstream.port}`;
  return out;
}

/** Replace any frame-ancestors directive with the allowed parent origins. */
export function cspWithFrameAncestors(existing, ancestors) {
  const directives = String(existing ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors(\s|$)/i.test(part));
  directives.push(`frame-ancestors ${ancestors.join(' ')}`);
  return directives.join('; ');
}

/**
 * The app sends X-Frame-Options: DENY and frame-ancestors 'none' to protect its
 * Provider Settings page. The hosted copy has no Provider Settings routes, so the
 * wrapper swaps in an allowlist of the TITAN dashboard origins. Nothing else may
 * frame it.
 */
export function buildResponseHeaders(upstreamHeaders, ancestors) {
  const out = {};
  let sawCsp = false;
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'set-cookie' || key === 'x-frame-options') continue;
    if (key === 'content-security-policy') {
      sawCsp = true;
      out[key] = cspWithFrameAncestors(Array.isArray(value) ? value.join('; ') : value, ancestors);
      continue;
    }
    out[key] = value;
  }
  if (!sawCsp) out['content-security-policy'] = cspWithFrameAncestors('', ancestors);
  if (!out['x-content-type-options']) out['x-content-type-options'] = 'nosniff';
  return out;
}

/** Escape JSON for safe inclusion inside an inline script. */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}
