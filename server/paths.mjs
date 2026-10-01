// Request path normalization and the route policy for the wrapper.
// The wrapper checks the same normalized path that it forwards, so a path cannot
// pass the policy in one form and reach the app in another.

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Parse a raw request target. Rejects anything that is not a plain origin-form
 * path: protocol-relative URLs, backslashes, encoded slashes, dot segments,
 * control characters, and bad percent-encoding.
 */
export function normalizeRequestTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096) return { ok: false };
  if (rawUrl[0] !== '/' || rawUrl[1] === '/' || rawUrl.includes('\\')) return { ok: false };
  // The URL parser resolves dot segments, even encoded ones, before any later check
  // could see them. Refuse them up front instead.
  for (const rawSegment of rawUrl.split(/[?#]/, 1)[0].split('/')) {
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return { ok: false };
    }
    if (segment === '.' || segment === '..') return { ok: false };
  }
  let url;
  try {
    url = new URL(rawUrl, 'http://gev.invalid');
  } catch {
    return { ok: false };
  }
  if (url.host !== 'gev.invalid') return { ok: false };
  const segments = url.pathname.split('/').slice(1);
  let decoded;
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return { ok: false };
  }
  for (const segment of decoded) {
    if (segment === '.' || segment === '..') return { ok: false };
    if (segment.includes('/') || segment.includes('\\') || CONTROL_RE.test(segment)) {
      return { ok: false };
    }
  }
  return {
    ok: true,
    pathname: url.pathname,
    search: url.search,
    searchParams: url.searchParams,
    // Lowercase with empty segments removed. Used only for policy matching.
    matchPath: `/${decoded.filter(Boolean).join('/').toLowerCase()}`,
  };
}

const PAID_PREFIXES = ['/api/realtime', '/api/openai'];

function hasPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Route policy for an authenticated request.
 *  reserved: the wrapper's own namespace. Never forwarded.
 *  blocked:  refused here no matter what the app would do.
 *  api:      forwarded and rate limited.
 *  static:   forwarded.
 */
export function classifyPath(matchPath, { allowPaidRoutes = false } = {}) {
  if (hasPrefix(matchPath, '/__gev')) return 'reserved';
  for (const segment of matchPath.split('/')) {
    if (segment.startsWith('.') && segment !== '.well-known') return 'blocked';
  }
  // Provider Settings. The hosted copy keeps it off. Keys come from host secrets.
  if (hasPrefix(matchPath, '/api/setup')) return 'blocked';
  if (!allowPaidRoutes && PAID_PREFIXES.some((prefix) => hasPrefix(matchPath, prefix))) {
    return 'blocked';
  }
  if (hasPrefix(matchPath, '/api')) return 'api';
  return 'static';
}
