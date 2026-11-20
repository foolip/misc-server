// Replays the production test suite in ../../test/ against the Worker,
// offline. `describe`/`specify` are defined on top of node:test, and global
// fetch is replaced with a call into the Worker.
//
// The buckets are fakes in which every key exists, except keys with a path
// segment named "foo" (which the production tests use for 404 cases).

import { describe as nodeDescribe, it } from 'node:test';
import config from '../config/hosts.json' with { type: 'json' };
import { handle } from '../src/handler.mjs';

// Hosts that marquee doesn't serve (they are on other droplets).
const SERVED = new Set(Object.keys(config.hosts));

class EverythingBucket {
  exists(key) {
    return !key.split('/').includes('foo');
  }
  meta(key) {
    return {
      key,
      size: 5,
      uploaded: new Date('2024-01-01T00:00:00Z'),
      httpEtag: '"fake"',
      customMetadata: {},
    };
  }
  async head(key) { return this.exists(key) ? this.meta(key) : null; }
  async get(key) {
    if (!this.exists(key)) return null;
    return { ...this.meta(key), body: new Blob(['fake\n']).stream() };
  }
  async list({ prefix }) {
    if (!this.exists(prefix + 'x')) return { objects: [], delimitedPrefixes: [], truncated: false };
    return { objects: [this.meta(prefix + 'index.html')], delimitedPrefixes: [], truncated: false };
  }
}

const deps = {
  config,
  sites: new EverythingBucket(),
  snapshots: new EverythingBucket(),
};

globalThis.fetch = async (url, init) => handle(new Request(url, init), deps);

// Test names are URLs or hostnames. Skip http: URLs (Cloudflare's "Always
// Use HTTPS" handles those) and hosts not served by marquee.
function skipReason(name) {
  let url;
  try {
    url = new URL(name);
  } catch {
    url = new URL(`https://${name}/`);
  }
  if (url.protocol === 'http:') return 'http: is handled by Always Use HTTPS';
  if (!SERVED.has(url.hostname)) return `${url.hostname} is not served by marquee`;
  return null;
}

globalThis.describe = (name, fn) => nodeDescribe(name, fn);
globalThis.specify = (name, fn) => {
  const skip = skipReason(name);
  return skip ? it(name, { skip }, () => {}) : it(name, () => fn.call({}));
};

for (const file of ['redirects', 'content-type', 'caching', 'cors', 'hsts', 'x-headers']) {
  await import(`../../test/${file}.mjs`);
}
