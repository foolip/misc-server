// In-memory stand-ins for an R2 bucket and the Cache API, implementing the
// parts the Worker uses.

const encoder = new TextEncoder();

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) throw new Error('invalid range');
  if (m[1] === '') return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (offset >= size) throw new Error('range not satisfiable');
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { offset, length: end - offset + 1 };
}

function preconditionFails(headers, etag, uploaded) {
  const inm = headers.get('if-none-match');
  if (inm !== null) {
    return inm.split(',').map(s => s.trim()).some(t => t === '*' || t === etag || t === `W/${etag}`);
  }
  const ims = headers.get('if-modified-since');
  if (ims !== null && Date.parse(ims) >= Math.floor(uploaded.getTime() / 1000) * 1000) return true;
  const im = headers.get('if-match');
  if (im !== null && !im.split(',').map(s => s.trim()).some(t => t === '*' || t === etag)) return true;
  return false;
}

export class MemoryBucket {
  constructor(entries = {}) {
    this.objects = new Map();
    this.calls = [];
    for (const [key, value] of Object.entries(entries)) this.put(key, value);
  }

  put(key, value, { mtime, uploaded = new Date('2024-01-02T03:04:05Z') } = {}) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    this.objects.set(key, {
      key,
      bytes,
      size: bytes.length,
      uploaded,
      etag: `etag-${this.objects.size}`,
      customMetadata: mtime ? { mtime } : {},
    });
  }

  meta(o) {
    return {
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      customMetadata: o.customMetadata,
    };
  }

  async head(key) {
    this.calls.push(['head', key]);
    const o = this.objects.get(key);
    return o ? this.meta(o) : null;
  }

  async get(key, options = {}) {
    this.calls.push(['get', key]);
    const o = this.objects.get(key);
    if (!o) return null;
    const meta = this.meta(o);
    if (options.onlyIf instanceof Headers && preconditionFails(options.onlyIf, meta.httpEtag, o.uploaded)) {
      return meta;
    }
    let bytes = o.bytes;
    let range;
    if (options.range instanceof Headers && options.range.has('range')) {
      range = parseRange(options.range.get('range'), o.size);
      const offset = range.suffix !== undefined ? Math.max(0, o.size - range.suffix) : range.offset;
      const length = range.suffix !== undefined ? o.size - offset : range.length;
      bytes = bytes.slice(offset, offset + length);
    }
    return {
      ...meta,
      range,
      body: new Blob([bytes]).stream(),
    };
  }

  async list({ prefix = '', delimiter, cursor, limit = 1000 } = {}) {
    this.calls.push(['list', prefix]);
    const keys = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const objects = [];
    const prefixes = new Set();
    let i = start;
    for (; i < keys.length && objects.length + prefixes.size < limit; i++) {
      const rest = keys[i].slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) {
        prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
      } else {
        objects.push(this.meta(this.objects.get(keys[i])));
      }
    }
    const truncated = i < keys.length;
    return {
      objects,
      delimitedPrefixes: [...prefixes],
      truncated,
      cursor: truncated ? String(i) : undefined,
    };
  }
}

export class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(request) {
    const r = this.entries.get(request.url);
    return r ? r.clone() : undefined;
  }
  async put(request, response) {
    this.entries.set(request.url, response.clone());
  }
}
