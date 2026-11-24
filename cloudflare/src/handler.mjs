// Request handling that reproduces marquee's nginx behavior on top of R2.
//
// Everything that touches the outside world is passed in, so this runs both
// in the Workers runtime and under Node in tests:
//
//   handle(request, {
//     config,          // config/hosts.json
//     bucket,          // R2 bucket (or fake) with all files, keyed <host><path>
//     cache,           // optional Cache API object, used for listings
//     waitUntil,       // optional ctx.waitUntil
//     allowHostHeader, // staging: take the host from X-Marquee-Host
//     defaultHost,     // staging: the host when there is no X-Marquee-Host
//   })

import { BadRequest, parseTarget, escapePath, escapeHeaderValue, extension } from './path.mjs';
import { findLocation } from './locations.mjs';
import { collectEntries, sortEntries, sortFromQuery, renderListing, objectDate } from './listing.mjs';

export const HOST_HEADER = 'X-Marquee-Host';
export const LISTING_CACHE_SECONDS = 300;

// Statuses for which nginx applies `expires` and non-`always` add_header.
const SAFE_STATUSES = new Set([200, 201, 204, 206, 301, 302, 303, 304, 307, 308]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REASONS = {
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Not Allowed',
  410: 'Gone',
  412: 'Precondition Failed',
  416: 'Requested Range Not Satisfiable',
  500: 'Internal Server Error',
};

export async function handle(request, deps) {
  const url = new URL(request.url);
  let host = url.hostname;
  if (deps.allowHostHeader) {
    // Staging: the X-Marquee-Host header, else the configured default host,
    // so that a browser (which can't set the header) sees a site too.
    host = request.headers.get(HOST_HEADER) ?? deps.defaultHost ?? host;
  }
  host = host.toLowerCase();
  const hostConf = deps.config.hosts[host];
  if (!hostConf) {
    return new Response(`Unknown host ${host}\n`, {
      status: 421,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const ctx = {
    deps,
    config: deps.config,
    host,
    hostConf,
    request,
    method: request.method,
    // $request_uri: the original path and query.
    requestUri: url.pathname + url.search,
    args: url.search.slice(1),
  };

  // A server-level return runs before location matching.
  if (hostConf.return) {
    return doReturn(ctx, hostConf.return, [], null, {});
  }

  let uri;
  try {
    uri = parseTarget(url.pathname, ctx.args).uri;
  } catch (e) {
    if (e instanceof BadRequest) return specialResponse(ctx, null, 400);
    throw e;
  }
  return processUri(ctx, uri, {});
}

// Settings lookup with nginx inheritance: location, then server, then http.
function setting(ctx, location, name) {
  if (location && location[name] !== undefined) return location[name];
  const server = ctx.hostConf.server;
  if (server && server[name] !== undefined) return server[name];
  return ctx.config.http[name];
}

function keyFor(ctx, uri) {
  return ctx.host + uri;
}

// Runs location matching and the content phase for `uri`. Also used for
// internal redirects (index files and error pages).
async function processUri(ctx, uri, state) {
  const { location, captures } = findLocation(ctx.hostConf, uri);

  if (location?.features?.includes('strip-sid')) {
    // if ($args ~ ^(.*?)&?sid=[a-z0-9]*$) {
    //     set $stripped $1$2;
    //     rewrite ^(.*)$ $1?$stripped? permanent;
    // }
    const m = /^(.*?)&?sid=[a-z0-9]*$/.exec(ctx.args);
    if (m) {
      return redirect(ctx, location, 301, `${escapePath(uri)}?${m[1]}`);
    }
  }

  if (location?.return) {
    return doReturn(ctx, location.return, captures, location, state);
  }

  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    return error(ctx, location, 405, state);
  }

  if (location?.tryFiles) {
    for (const template of location.tryFiles.files) {
      const candidate = template
        .replace(/\$\{uri\}|\$uri\b/g, uri)
        .replace(/\$\{args\}|\$args\b/g, ctx.args);
      if (candidate.endsWith('/')) continue; // try_files without a trailing slash only tests files
      const response = await serveFile(ctx, candidate, state, { fallthrough: true });
      if (response) return response;
    }
    return error(ctx, location, location.tryFiles.code, state);
  }

  if (uri.endsWith('/')) {
    const index = setting(ctx, location, 'index') ?? ['index.html'];
    const bucket = ctx.deps.bucket;
    for (const name of index) {
      if (await bucket.head(keyFor(ctx, uri + name))) {
        return processUri(ctx, uri + name, state);
      }
    }
    if (setting(ctx, location, 'fancyindex')) {
      return listing(ctx, uri, location, state);
    }
    // Like nginx, 403 for an existing directory without an index, else 404.
    const exists = await bucket.list({ prefix: keyFor(ctx, uri), limit: 1 });
    return error(ctx, location, exists.objects.length ? 403 : 404, state);
  }

  return serveFile(ctx, uri, state, { location });
}

function substitute(ctx, text, captures) {
  return text.replace(/\$(?:\{(request_uri|[1-9])\}|(request_uri|[1-9]))/g, (_, a, b) => {
    const name = a ?? b;
    if (name === 'request_uri') return ctx.requestUri;
    return captures[Number(name)] ?? '';
  });
}

function doReturn(ctx, ret, captures, location, state) {
  if (ret.text !== undefined && REDIRECT_STATUSES.has(ret.code)) {
    return redirect(ctx, location, ret.code, substitute(ctx, ret.text, captures));
  }
  if (ret.text !== undefined) {
    const body = substitute(ctx, ret.text, captures);
    const type = contentType(ctx, location, '');
    return finish(ctx, location, ret.code, type, body);
  }
  return error(ctx, location, ret.code, state);
}

function redirect(ctx, location, status, target) {
  // absolute_redirect on: relative targets get the scheme and host.
  if (target.startsWith('/')) target = `https://${ctx.host}${target}`;
  return specialResponse(ctx, location, status, { Location: escapeHeaderValue(target) });
}

// Handles an error status: an error_page if there is one, else nginx's
// built-in page. Like nginx with recursive_error_pages off, error pages are
// not applied while already serving an error page.
async function error(ctx, location, status, state) {
  const errorPages = setting(ctx, location, 'errorPage');
  const page = errorPages?.[String(status)];
  if (page && !state.inErrorPage) {
    // The internal redirect turns everything but HEAD into GET.
    if (ctx.method !== 'HEAD') ctx.method = 'GET';
    return processUri(ctx, page, { inErrorPage: true, errorStatus: status });
  }
  return specialResponse(ctx, location, status);
}

function specialResponse(ctx, location, status, extraHeaders = {}) {
  const reason = REASONS[status] ?? '';
  const title = `${status} ${reason}`.trim();
  const body = `<html>\r\n<head><title>${title}</title></head>\r\n<body>\r\n` +
    `<center><h1>${title}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`;
  // The charset filter skips 301 and 302 responses.
  const type = status === 301 || status === 302 ? 'text/html' : withCharset(ctx, location, 'text/html');
  return finish(ctx, location, status, type, body, extraHeaders);
}

export function contentType(ctx, location, uri) {
  const tableIndex = setting(ctx, location, 'types');
  const table = ctx.config.typeTables[tableIndex] ?? {};
  const ext = extension(uri);
  const type = (ext && table[ext]) || setting(ctx, location, 'defaultType');
  return withCharset(ctx, location, type);
}

function withCharset(ctx, location, type) {
  const charset = setting(ctx, location, 'charset');
  if (!charset) return type;
  // A type with parameters never matches charset_types in nginx.
  if (type.includes(';')) return type;
  if (!ctx.config.http.charsetTypes.includes(type.toLowerCase())) return type;
  return `${type}; charset=${charset}`;
}

// Adds add_header and expires headers, and drops the body for HEAD.
function finish(ctx, location, status, type, body, extraHeaders = {}) {
  const headers = new Headers();
  if (type) headers.set('Content-Type', type);
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value !== undefined && value !== null) headers.set(name, value);
  }
  applyHeaders(ctx, location, status, type, headers);
  return new Response(ctx.method === 'HEAD' || status === 304 ? null : body, { status, headers });
}

function applyHeaders(ctx, location, status, type, headers) {
  const safe = SAFE_STATUSES.has(status);
  // Intentional difference from nginx: nginx drops the server-level
  // add_headers in a location that has its own add_header. Here both apply.
  const list = [...(ctx.hostConf.server?.addHeader ?? []), ...(location?.addHeader ?? [])];
  for (const [name, value, always] of list) {
    if (always || safe) headers.append(name, value);
  }
  if (safe && type) {
    const { expires } = ctx.config.http;
    let seconds = expires.default;
    for (const rule of expires.rules) {
      if (new RegExp(rule.regex, rule.flags).test(type)) { seconds = rule.seconds; break; }
    }
    if (seconds !== null && seconds !== undefined) {
      headers.set('Expires', new Date(Date.now() + seconds * 1000).toUTCString());
      headers.set('Cache-Control', `max-age=${seconds}`);
    }
  }
}

// Serves the object for `uri`. With `fallthrough` (try_files), returns null
// if it doesn't exist.
async function serveFile(ctx, uri, state, { fallthrough = false } = {}) {
  const { location } = findLocation(ctx.hostConf, uri);
  const bucket = ctx.deps.bucket;
  const key = keyFor(ctx, uri);
  const request = ctx.request;
  // Error pages are served without conditionals or ranges, as in nginx.
  const conditional = !state.errorStatus;
  // Only a single byte range is passed on to R2. Malformed and multi-range
  // requests get the whole object (nginx would send multipart/byteranges).
  const range = conditional ? parseSingleRange(request.headers.get('range')) : null;
  let obj;
  if (!conditional) {
    obj = await bucket.get(key);
  } else {
    try {
      obj = await bucket.get(key, { onlyIf: request.headers, range: range ? request.headers : undefined });
    } catch (e) {
      if (!range) throw e;
      obj = await bucket.get(key, { onlyIf: request.headers });
      if (obj && 'body' in obj) {
        await obj.body.cancel();
        return specialResponse(ctx, location, 416, { 'Content-Range': `bytes */${obj.size}` });
      }
    }
    if (obj && 'body' in obj && range && !rangeSatisfiable(range, obj.size)) {
      await obj.body.cancel();
      return specialResponse(ctx, location, 416, { 'Content-Range': `bytes */${obj.size}` });
    }
  }

  if (!obj) {
    if (fallthrough) return null;
    // A directory without the trailing slash: redirect, keeping the query.
    const children = await bucket.list({ prefix: key + '/', limit: 1 });
    if (children.objects.length || children.delimitedPrefixes?.length) {
      const target = escapePath(uri) + '/' + (ctx.args ? `?${ctx.args}` : '');
      return redirect(ctx, location, 301, target);
    }
    return error(ctx, location, 404, state);
  }

  const type = contentType(ctx, location, uri);
  const headers = new Headers();
  headers.set('Content-Type', type);
  const date = objectDate(obj);
  // nginx drops Last-Modified unless the status is 200, 206 or 304.
  if (date && !state.errorStatus) headers.set('Last-Modified', date.toUTCString());
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

  let status = state.errorStatus ?? 200;
  let body = 'body' in obj ? obj.body : null;

  if (!('body' in obj)) {
    // A precondition failed.
    const h = request.headers;
    status = h.has('if-none-match') || h.has('if-modified-since') ? 304 : 412;
    if (status === 412) return specialResponse(ctx, location, 412);
  } else if (status === 200) {
    headers.set('Accept-Ranges', 'bytes');
    if (range && obj.range) {
      const { offset, length } = resolveRange(obj.range, obj.size);
      status = 206;
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      if (ctx.method === 'HEAD') headers.set('Content-Length', String(length));
    } else if (ctx.method === 'HEAD') {
      headers.set('Content-Length', String(obj.size));
    }
  }

  // Intentional: html.spec.whatwg.org/print.pdf's location add_header
  // (Content-Disposition) is added on top of the standard headers.
  applyHeaders(ctx, location, status, type, headers);

  if (ctx.method === 'HEAD' || status === 304) {
    await body?.cancel?.();
    body = null;
  }
  return new Response(body, { status, headers });
}

function parseSingleRange(header) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] !== '' && m[2] !== '' && Number(m[2]) < Number(m[1])) return null;
  return { start: m[1] === '' ? null : Number(m[1]), end: m[2] === '' ? null : Number(m[2]) };
}

function rangeSatisfiable(range, size) {
  if (range.start === null) return range.end > 0 && size > 0;
  return range.start < size;
}

function resolveRange(range, size) {
  if ('suffix' in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  const length = range.length ?? size - offset;
  return { offset, length };
}

async function listing(ctx, uri, location, state) {
  const sort = sortFromQuery(ctx.args, setting(ctx, location, 'fancyindexDefaultSort'));
  const cache = ctx.deps.cache;
  const cacheKey = new Request(`https://${ctx.host}${escapePath(uri)}?fancyindex-sort=${sort}`);
  let html = null;
  if (cache && !state.errorStatus) {
    const hit = await cache.match(cacheKey);
    if (hit) html = await hit.text();
  }
  if (html === null) {
    const entries = await collectEntries(ctx.deps.bucket, keyFor(ctx, uri));
    if (!entries) return error(ctx, location, 404, state);
    html = renderListing(uri, sortEntries(entries, sort), {
      cssHref: setting(ctx, location, 'fancyindexCssHref'),
      exactSize: setting(ctx, location, 'fancyindexExactSize') ?? true,
    });
    if (cache) {
      const put = cache.put(cacheKey, new Response(html, {
        headers: { 'Cache-Control': `max-age=${LISTING_CACHE_SECONDS}` },
      }));
      if (ctx.deps.waitUntil) ctx.deps.waitUntil(put);
      else await put;
    }
  }
  const status = state.errorStatus ?? 200;
  return finish(ctx, location, status, withCharset(ctx, location, 'text/html'), html);
}
