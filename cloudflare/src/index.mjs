// Cloudflare Worker entry point for the marquee hosts. See ../README.md.

import config from '../config/hosts.json' with { type: 'json' };
import { handle } from './handler.mjs';

export default {
  async fetch(request, env, ctx) {
    return handle(request, {
      config,
      bucket: env.BUCKET,
      cache: caches.default,
      waitUntil: p => ctx.waitUntil(p),
    });
  },
};
