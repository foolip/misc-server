#!/usr/bin/env node
// Try the Worker locally against a sample of real content, and compare it
// with production. Needs network access to the whatwg.org hosts.
//
//   npm run local:seed      # copy a sample of production into local R2
//   npm run dev             # in another terminal: wrangler dev --env staging
//   npm run local:compare   # request the same URLs from both and diff
//
// The sample is every https: URL in ../test/*.mjs on a host the Worker
// serves, the error pages, and a few commit snapshots and review drafts.
// Local R2 lives in .wrangler/state (wrangler's default).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../config/hosts.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUDFLARE_DIR = path.resolve(HERE, '..');
const TEST_DIR = path.resolve(CLOUDFLARE_DIR, '..', 'test');
const SEED_DIR = path.join(CLOUDFLARE_DIR, '.wrangler', 'seed');
const WRANGLER = ['--yes', 'wrangler@4.156.2'];
const LOCAL = process.env.LOCAL_URL ?? 'http://localhost:8787';
const TEST_FILES = ['redirects', 'content-type', 'caching', 'cors', 'hsts', 'x-headers'];

const EXTRA_URLS = [
  'https://whatwg.org/404',
  'https://whatwg.org/410',
  'https://lists.whatwg.org/404',
  'https://html.spec.whatwg.org/404.html',
  'https://html.spec.whatwg.org/print.pdf',
  'https://forums.whatwg.org/bb3/',
  'https://forums.whatwg.org/bb3/index.php',
];

// Spec hosts whose newest snapshots/drafts get copied, for listings.
const SNAPSHOT_HOSTS = ['dom.spec.whatwg.org', 'url.spec.whatwg.org'];
const SNAPSHOTS_PER_DIR = 3;

function served(url) {
  return url.protocol === 'https:' && url.hostname in config.hosts;
}

function testUrls() {
  const urls = new Set();
  for (const file of TEST_FILES) {
    const text = fs.readFileSync(path.join(TEST_DIR, `${file}.mjs`), 'utf8');
    for (const m of text.matchAll(/'(https:\/\/[^']+)'/g)) urls.add(m[1]);
    // hsts/x-headers list hostnames and fetch https://host/.
    for (const m of text.matchAll(/^\s*\[?'([a-z0-9.-]+\.whatwg\.org)'/gm)) urls.add(`https://${m[1]}/`);
  }
  return [...urls].map(u => new URL(u)).filter(served);
}

function withFoo(url) {
  const u = new URL(url);
  u.pathname = u.pathname.endsWith('/') ? u.pathname + 'foo' : u.pathname + '/foo';
  return u;
}

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const j = i++;
      results[j] = await fn(items[j]);
    }
  }));
  return results;
}

function keyFor(url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  return url.hostname + p;
}

async function snapshotUrls() {
  const urls = [];
  for (const host of SNAPSHOT_HOSTS) {
    for (const dir of ['commit-snapshots', 'review-drafts']) {
      const r = await fetch(`https://${host}/${dir}/`);
      if (!r.ok) continue;
      const html = await r.text();
      const subdirs = [...html.matchAll(/<a href="([^"?/][^"]*\/)"/g)].map(m => m[1]).filter(h => h !== '../');
      for (const sub of subdirs.slice(0, SNAPSHOTS_PER_DIR)) {
        urls.push(new URL(`https://${host}/${dir}/${sub}`));
      }
    }
  }
  return urls;
}

async function seed() {
  fs.mkdirSync(SEED_DIR, { recursive: true });
  const urls = [...testUrls(), ...EXTRA_URLS.map(u => new URL(u)), ...await snapshotUrls()];
  const entries = { 'whatwg-sites': [] };
  const seen = new Set();
  await pool(urls, 8, async url => {
    const key = keyFor(url);
    if (seen.has(key)) return;
    seen.add(key);
    const r = await fetch(url, { redirect: 'manual' });
    if (r.status !== 200) {
      await r.body?.cancel();
      return;
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    const file = path.join(SEED_DIR, crypto.createHash('sha256').update(key).digest('hex'));
    fs.writeFileSync(file, bytes);
    entries['whatwg-sites'].push({ key, file });
    console.log(`${r.status} ${url.href} -> ${key}`);
  });
  for (const [bucket, list] of Object.entries(entries)) {
    if (!list.length) continue;
    const listFile = path.join(SEED_DIR, `${bucket}.json`);
    fs.writeFileSync(listFile, JSON.stringify(list));
    execFileSync('npx', [...WRANGLER, 'r2', 'bulk', 'put', bucket, '--filename', listFile, '--local', '--env', 'staging'], {
      cwd: CLOUDFLARE_DIR,
      stdio: 'inherit',
    });
  }
  console.log(`\nSeeded ${entries['whatwg-sites'].length} objects. Now run: npm run dev`);
}

const COMPARED_HEADERS = [
  'location',
  'content-type',
  'cache-control',
  'content-disposition',
  'access-control-allow-origin',
  'strict-transport-security',
  'x-content-type-options',
];

function summarize(r) {
  const out = { status: r.status };
  for (const h of COMPARED_HEADERS) out[h] = r.headers.get(h);
  return out;
}

async function compare() {
  try {
    await fetch(LOCAL);
  } catch {
    console.error(`Nothing is listening on ${LOCAL}. Start it with: npm run dev`);
    process.exit(1);
  }
  const base = [...testUrls(), ...EXTRA_URLS.map(u => new URL(u))];
  const urls = [...new Map([...base, ...base.map(withFoo)].map(u => [u.href, u])).values()];
  let same = 0;
  const diffs = [];
  await pool(urls, 8, async url => {
    const prod = await fetch(url, { redirect: 'manual' });
    await prod.body?.cancel();
    const local = await fetch(LOCAL + url.pathname + url.search, {
      redirect: 'manual',
      headers: { 'X-Marquee-Host': url.hostname },
    });
    await local.body?.cancel();
    const a = summarize(prod);
    const b = summarize(local);
    const fields = Object.keys(a).filter(k => a[k] !== b[k]);
    if (fields.length === 0) same++;
    else diffs.push({ url: url.href, fields: fields.map(k => ({ k, prod: a[k], local: b[k] })) });
  });
  diffs.sort((x, y) => x.url < y.url ? -1 : 1);
  for (const d of diffs) {
    console.log(d.url);
    for (const { k, prod, local } of d.fields) console.log(`  ${k}: production=${JSON.stringify(prod)} local=${JSON.stringify(local)}`);
  }
  console.log(`\n${same} of ${urls.length} URLs match on status and ${COMPARED_HEADERS.join(', ')}.`);
  console.log('Expected differences: html.spec.whatwg.org/print.pdf has the standard headers locally (see README).');
  console.log('URLs that 404 locally but not in production were not part of the seeded sample.');
}

const command = process.argv[2];
if (command === 'seed') await seed();
else if (command === 'compare') await compare();
else {
  console.error('usage: node tools/try-local.mjs seed|compare');
  process.exit(1);
}
