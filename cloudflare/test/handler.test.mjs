import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/hosts.json' with { type: 'json' };
import { handle } from '../src/handler.mjs';
import { MemoryBucket, MemoryCache } from './helpers/memory-bucket.mjs';

function setup(files = {}, filesWithMtime = []) {
  const bucket = new MemoryBucket(files);
  for (const [key, value, mtime] of filesWithMtime) bucket.put(key, value, { mtime });
  const cache = new MemoryCache();
  const deps = { config, bucket, cache };
  const fetch = (url, init = {}) => handle(new Request(url, init), deps);
  return { bucket, cache, deps, fetch };
}

const STANDARD = {
  'access-control-allow-origin': '*',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
};

function assertStandardHeaders(response) {
  for (const [name, value] of Object.entries(STANDARD)) {
    assert.equal(response.headers.get(name), value, name);
  }
}

describe('files', () => {
  test('serves host/path keys', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/index.html': 'dom' });
    const r = await fetch('https://dom.spec.whatwg.org/');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'dom');
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(r.headers.get('etag'));
    assert.ok(r.headers.get('last-modified'));
    assertStandardHeaders(r);
  });

  test('query string is ignored for lookup', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'a' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt?x=1');
    assert.equal(r.status, 200);
  });

  test('decoded, normalized path', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a b/c.txt': 'c' });
    const r = await fetch('https://dom.spec.whatwg.org//a%20b/./x/../c.txt');
    assert.equal(r.status, 200);
  });

  test('snapshots are in the same bucket', async () => {
    const { fetch } = setup({}, [['dom.spec.whatwg.org/commit-snapshots/abc/index.html', 'snap']]);
    const r = await fetch('https://dom.spec.whatwg.org/commit-snapshots/abc/');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'snap');
  });

  test('directory without slash redirects, keeping the query', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/dir/index.html': 'x' });
    const r = await fetch('https://dom.spec.whatwg.org/dir?a=b', { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), 'https://dom.spec.whatwg.org/dir/?a=b');
    assert.equal(r.headers.get('content-type'), 'text/html');
    assertStandardHeaders(r);
  });

  test('missing file is the default 404 page', async () => {
    const { fetch } = setup();
    const r = await fetch('https://dom.spec.whatwg.org/nope');
    assert.equal(r.status, 404);
    assert.match(await r.text(), /<title>404 Not Found<\/title>/);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assertStandardHeaders(r);
  });

  test('HEAD has headers and no body', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'hello' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '5');
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await r.text(), '');
  });

  test('other methods get 405', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'hello' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt', { method: 'POST', body: 'x' });
    assert.equal(r.status, 405);
    assertStandardHeaders(r);
  });

  test('bad escapes get 400', async () => {
    const { fetch } = setup();
    const r = await fetch('https://dom.spec.whatwg.org/%zz');
    assert.equal(r.status, 400);
  });

  test('304 with If-None-Match', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'hello' });
    const first = await fetch('https://dom.spec.whatwg.org/a.txt');
    const r = await fetch('https://dom.spec.whatwg.org/a.txt', {
      headers: { 'If-None-Match': first.headers.get('etag') },
    });
    assert.equal(r.status, 304);
    assert.equal(await r.text(), '');
    assertStandardHeaders(r);
  });

  test('412 with failed If-Match', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'hello' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt', { headers: { 'If-Match': '"other"' } });
    assert.equal(r.status, 412);
  });

  test('206 with Range', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'hello world' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt', { headers: { Range: 'bytes=0-4' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 0-4/11');
    assert.equal(await r.text(), 'hello');
    const suffix = await fetch('https://dom.spec.whatwg.org/a.txt', { headers: { Range: 'bytes=-5' } });
    assert.equal(suffix.headers.get('content-range'), 'bytes 6-10/11');
    assert.equal(await suffix.text(), 'world');
  });

  test('416 for unsatisfiable Range', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'hello' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt', { headers: { Range: 'bytes=10-' } });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */5');
  });

  test('multiple ranges get the whole object', async () => {
    const { fetch } = setup({ 'dom.spec.whatwg.org/a.txt': 'hello world' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt', { headers: { Range: 'bytes=0-1,3-4' } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello world');
  });

  test('Last-Modified comes from rclone mtime metadata', async () => {
    const { bucket, fetch } = setup();
    bucket.put('dom.spec.whatwg.org/a.txt', 'x', { mtime: '2015-05-05T05:05:05.123Z' });
    const r = await fetch('https://dom.spec.whatwg.org/a.txt');
    assert.equal(r.headers.get('last-modified'), 'Tue, 05 May 2015 05:05:05 GMT');
  });
});

describe('content types', () => {
  const cases = [
    ['https://resources.whatwg.org/x.js', 'text/javascript; charset=utf-8'],
    ['https://resources.whatwg.org/x.JS', 'text/javascript; charset=utf-8'],
    ['https://resources.whatwg.org/x.json', 'application/json'],
    ['https://resources.whatwg.org/x.woff', 'application/font-woff'],
    ['https://resources.whatwg.org/x.woff2', 'font/woff2'],
    ['https://resources.whatwg.org/x.xml', 'text/xml; charset=utf-8'],
    ['https://resources.whatwg.org/x.rss', 'application/rss+xml; charset=utf-8'],
    ['https://resources.whatwg.org/x.unknown', 'application/octet-stream'],
    ['https://resources.whatwg.org/noext', 'application/octet-stream'],
    ['https://images.whatwg.org/x', 'image/png'],
    ['https://images.whatwg.org/x.txt', 'text/plain; charset=utf-8'],
    ['https://n.whatwg.org/x', 'text/plain; charset=utf-8'],
    ['https://lists.whatwg.org/x', 'text/html; charset=utf-8'],
    ['https://whatwg.org/news/x', 'text/html; charset=utf-8'],
    ['https://whatwg.org/status-2008-12', 'text/plain; charset=utf-8'],
    ['https://whatwg.org/style/x', 'text/css'],
    ['https://forums.whatwg.org/bb3/viewtopic.php', 'text/html; charset=utf-8'],
  ];
  for (const [url, type] of cases) {
    test(url, async () => {
      const key = new URL(url).hostname + new URL(url).pathname;
      const { fetch } = setup({ [key]: 'x', [key + '__']: 'x' });
      const r = await fetch(url);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), type);
    });
  }
});

describe('caching headers', () => {
  test('fonts and images get 7 days', async () => {
    const { fetch } = setup({ 'resources.whatwg.org/a.png': 'x', 'resources.whatwg.org/a.ttf': 'x' });
    for (const p of ['a.png', 'a.ttf']) {
      const r = await fetch(`https://resources.whatwg.org/${p}`);
      assert.equal(r.headers.get('cache-control'), 'max-age=604800');
      const expires = Date.parse(r.headers.get('expires'));
      assert.ok(Math.abs(expires - (Date.now() + 604800e3)) < 5000);
    }
  });
  test('not on 404 or other types', async () => {
    const { fetch } = setup({ 'resources.whatwg.org/a.css': 'x' });
    assert.equal((await fetch('https://resources.whatwg.org/a.css')).headers.get('cache-control'), null);
    assert.equal((await fetch('https://resources.whatwg.org/missing.png')).headers.get('cache-control'), null);
  });
});

describe('redirects', () => {
  test('server-level return with $request_uri', async () => {
    const { fetch } = setup();
    const r = await fetch('https://www.whatwg.org/a/b?c=d');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), 'https://whatwg.org/a/b?c=d');
    assertStandardHeaders(r);
  });
  test('server-level return applies to any method', async () => {
    const { fetch } = setup();
    const r = await fetch('https://www.whatwg.org/', { method: 'POST' });
    assert.equal(r.status, 301);
  });
  test('captures that do not participate are empty', async () => {
    const { fetch } = setup();
    const r = await fetch('https://whatwg.org/C');
    assert.equal(r.headers.get('location'), 'https://html.spec.whatwg.org/multipage/');
  });
  test('relative return becomes absolute', async () => {
    const { fetch } = setup();
    const r = await fetch('https://forums.whatwg.org/');
    assert.equal(r.headers.get('location'), 'https://forums.whatwg.org/bb3/');
  });
  test('forums sid is stripped', async () => {
    const { fetch } = setup();
    const r = await fetch('https://forums.whatwg.org/bb3/viewtopic.php?f=3&p=8538&sid=1cb9e434c59258d940d476648b0301df');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), 'https://forums.whatwg.org/bb3/viewtopic.php?f=3&p=8538');
  });
});

describe('forums try_files', () => {
  test('file with query appended first, then without', async () => {
    const { fetch } = setup({
      'forums.whatwg.org/bb3/viewtopic.php__p=1': 'one',
      'forums.whatwg.org/bb3/viewtopic.php': 'plain',
    });
    assert.equal(await (await fetch('https://forums.whatwg.org/bb3/viewtopic.php?p=1')).text(), 'one');
    assert.equal(await (await fetch('https://forums.whatwg.org/bb3/viewtopic.php?p=2')).text(), 'plain');
    const missing = await fetch('https://forums.whatwg.org/bb3/missing.php');
    assert.equal(missing.status, 404);
  });
  test('index index.php', async () => {
    const { fetch } = setup({ 'forums.whatwg.org/bb3/index.php': 'index' });
    const r = await fetch('https://forums.whatwg.org/bb3/');
    assert.equal(await r.text(), 'index');
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  });
});

describe('error pages', () => {
  test('whatwg.org 404 uses /404 with status 404', async () => {
    const { fetch } = setup({ 'whatwg.org/404': 'custom 404' });
    const r = await fetch('https://whatwg.org/missing');
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'custom 404');
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('last-modified'), null);
    assertStandardHeaders(r);
  });
  test('whatwg.org 410 uses /410', async () => {
    const { fetch } = setup({ 'whatwg.org/410': 'gone' });
    const r = await fetch('https://whatwg.org/issues');
    assert.equal(r.status, 410);
    assert.equal(await r.text(), 'gone');
  });
  test('html.spec uses /404.html', async () => {
    const { fetch } = setup({ 'html.spec.whatwg.org/404.html': 'html 404' });
    const r = await fetch('https://html.spec.whatwg.org/missing');
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'html 404');
  });
  test('missing error page falls back without recursion', async () => {
    const { bucket, fetch } = setup();
    const r = await fetch('https://whatwg.org/missing');
    assert.equal(r.status, 404);
    assert.match(await r.text(), /404 Not Found/);
    assert.equal(bucket.calls.filter(([op, key]) => op === 'get' && key === 'whatwg.org/404').length, 1);
  });
  test('error pages ignore conditionals', async () => {
    const { fetch } = setup({ 'whatwg.org/404': 'custom 404' });
    const r = await fetch('https://whatwg.org/missing', { headers: { 'If-None-Match': '*', Range: 'bytes=0-1' } });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'custom 404');
  });
  test('return 410 without error_page is the default page', async () => {
    const { fetch } = setup();
    const r = await fetch('https://encoding.spec.whatwg.org/index-gbk.txt');
    assert.equal(r.status, 410);
    assert.match(await r.text(), /410 Gone/);
  });
});

describe('print.pdf', () => {
  test('has Content-Disposition and the standard headers', async () => {
    const { fetch } = setup({ 'html.spec.whatwg.org/print.pdf': 'pdf' });
    const r = await fetch('https://html.spec.whatwg.org/print.pdf');
    assert.equal(r.headers.get('content-disposition'), 'inline; filename=html-standard.pdf');
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assertStandardHeaders(r);
  });
});

describe('listings', () => {
  const snaps = [
    ['dom.spec.whatwg.org/commit-snapshots/aaa/index.html', 'a', '2020-01-01T00:00:00Z'],
    ['dom.spec.whatwg.org/commit-snapshots/bbb/index.html', 'b', '2022-01-01T00:00:00Z'],
    ['dom.spec.whatwg.org/commit-snapshots/ccc/index.html', 'c', '2021-01-01T00:00:00Z'],
    ['dom.spec.whatwg.org/review-drafts/2020-01/index.html', 'r', '2020-01-01T00:00:00Z'],
    ['dom.spec.whatwg.org/review-drafts/2021-01/index.html', 'r', '2021-01-01T00:00:00Z'],
  ];
  const order = (html, names) => names.map(n => html.indexOf(`href="${n}/"`));

  test('/commit-snapshots/ sorts by date, newest first', async () => {
    const { fetch } = setup({}, snaps);
    const r = await fetch('https://dom.spec.whatwg.org/commit-snapshots/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await r.text();
    const [a, b, c] = order(html, ['aaa', 'bbb', 'ccc']);
    assert.ok(b < c && c < a, html);
    assert.match(html, /2022-Jan-01 00:00/);
    assert.match(html, /nginx-fancyindex-whatwg\.css/);
    assertStandardHeaders(r);
  });

  test('/review-drafts/ sorts by name, descending', async () => {
    const { fetch } = setup({}, snaps);
    const html = await (await fetch('https://dom.spec.whatwg.org/review-drafts/')).text();
    const [x, y] = order(html, ['2020-01', '2021-01']);
    assert.ok(y < x);
  });

  test('?C=N&O=A overrides the sort', async () => {
    const { fetch } = setup({}, snaps);
    const html = await (await fetch('https://dom.spec.whatwg.org/commit-snapshots/?C=N&O=A')).text();
    const [a, b, c] = order(html, ['aaa', 'bbb', 'ccc']);
    assert.ok(a < b && b < c);
  });

  test('default sort is by name, directories first, dotfiles hidden', async () => {
    const { fetch } = setup({
      'dom.spec.whatwg.org/d/b.txt': 'x',
      'dom.spec.whatwg.org/d/a.txt': 'x',
      'dom.spec.whatwg.org/d/z/x.txt': 'x',
      'dom.spec.whatwg.org/d/.hidden': 'x',
    });
    const html = await (await fetch('https://dom.spec.whatwg.org/d/')).text();
    assert.ok(html.indexOf('href="z/"') < html.indexOf('href="a.txt"'));
    assert.ok(html.indexOf('href="a.txt"') < html.indexOf('href="b.txt"'));
    assert.ok(!html.includes('.hidden'));
    assert.match(html, /Parent directory/);
  });

  test('paginates and caches', async () => {
    const files = {};
    for (let i = 0; i < 2500; i++) files[`dom.spec.whatwg.org/big/f${i}.txt`] = 'x';
    const { bucket, cache, fetch } = setup(files);
    const html = await (await fetch('https://dom.spec.whatwg.org/big/')).text();
    assert.ok(html.includes('f2499.txt'));
    assert.equal(bucket.calls.filter(([op]) => op === 'list').length, 3);
    assert.equal(cache.entries.size, 1);
    bucket.calls.length = 0;
    await fetch('https://dom.spec.whatwg.org/big/');
    assert.equal(bucket.calls.filter(([op]) => op === 'list').length, 0);
  });

  test('nonexistent directory is 404', async () => {
    const { fetch } = setup();
    const r = await fetch('https://dom.spec.whatwg.org/nope/');
    assert.equal(r.status, 404);
  });
});

describe('hosts', () => {
  test('unknown host', async () => {
    const { fetch } = setup();
    assert.equal((await fetch('https://example.com/')).status, 421);
  });

  test('the host comes from the request URL', async () => {
    const { fetch } = setup();
    const r = await fetch('https://WWW.whatwg.org/x');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), 'https://whatwg.org/x');
  });
});
