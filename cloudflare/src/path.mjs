// URI handling that mirrors nginx's ngx_http_parse_complex_uri():
// percent-decode, merge slashes, and resolve dot segments.

export class BadRequest extends Error {}

const utf8 = new TextDecoder('utf-8');

// Percent-decodes `raw` (the path part of the request target). Like nginx,
// decoded characters are treated the same as literal ones, so %2F is a slash
// and %2E is a dot. Invalid escapes are a 400 error, as in nginx.
export function decodePath(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x25) { // %
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new BadRequest(`bad escape in ${raw}`);
      const b = parseInt(hex, 16);
      if (b === 0) throw new BadRequest('NUL in path');
      bytes.push(b);
      i += 2;
    } else if (c < 0x80) {
      bytes.push(c);
    } else {
      // Non-ASCII characters can only appear here if something upstream
      // already decoded them; encode as UTF-8.
      bytes.push(...new TextEncoder().encode(raw[i]));
    }
  }
  return utf8.decode(new Uint8Array(bytes));
}

// Merges slashes and resolves "." and ".." segments. Going above the root is
// a 400 error, as in nginx.
export function normalizePath(path) {
  if (!path.startsWith('/')) throw new BadRequest('path must start with /');
  const segments = path.split('/').slice(1);
  const out = [];
  const trailingSlash = path.endsWith('/') || /\/\.\.?$/.test(path);
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) throw new BadRequest('path above root');
      out.pop();
      continue;
    }
    out.push(segment);
  }
  let result = '/' + out.join('/');
  if (trailingSlash && result !== '/') result += '/';
  return result;
}

// Splits a raw request target into decoded+normalized path and raw query.
export function parseTarget(rawPath, rawQuery) {
  return { uri: normalizePath(decodePath(rawPath)), args: rawQuery };
}

// Escapes a decoded path for use in a Location header. nginx writes the
// decoded bytes as is, which isn't possible in a Workers Headers object for
// non-ASCII, so escape what isn't safe.
export function escapePath(path) {
  return path.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@\/%]/gu, c =>
    Array.from(new TextEncoder().encode(c), b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));
}

// Makes a header value safe: anything outside visible ASCII is
// percent-encoded.
export function escapeHeaderValue(value) {
  return value.replace(/[^\x21-\x7E]/gu, c =>
    Array.from(new TextEncoder().encode(c), b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));
}

// The extension nginx uses for type lookup: after the last "." in the last
// path segment, lowercased.
export function extension(uri) {
  const slash = uri.lastIndexOf('/');
  const dot = uri.lastIndexOf('.');
  if (dot <= slash) return '';
  return uri.slice(dot + 1).toLowerCase();
}
