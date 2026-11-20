// Cloudflare Worker entry point for the marquee hosts. See ../README.md.

import config from '../config/hosts.json' with { type: 'json' };
import { handle } from './handler.mjs';

export default {
  async fetch(request, env, ctx) {
    return handle(request, {
      config,
      sites: env.SITES,
      snapshots: env.SNAPSHOTS,
      cache: caches.default,
      waitUntil: p => ctx.waitUntil(p),
      // Only the staging environment sets this. Production ignores the
      // X-Marquee-Host header.
      allowHostHeader: env.ALLOW_HOST_HEADER === 'true',
    });
  },
};
