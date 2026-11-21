import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, convert, render, readInputs, ConfigError } from '../tools/nginx-to-json.mjs';

const real = readInputs();

function withSite(domain, text) {
  return { ...real, domains: [domain], sites: { [domain]: text } };
}

test('config/hosts.json is up to date', () => {
  const expected = render(convert(real));
  const actual = fs.readFileSync(new URL('../config/hosts.json', import.meta.url), 'utf8');
  assert.equal(actual, expected, 'run `npm run convert` in cloudflare/');
});

test('all DOMAINS are converted', () => {
  const config = convert(real);
  const hosts = Object.values(config.hosts);
  assert.equal(hosts.length, 49);
  assert.equal(hosts.filter(h => h.return).length, 17);
});

test('parser handles quotes, comments and ${var}', () => {
  const d = parse('a "b c" d; # comment\ntry_files "${uri}__${args}" $uri =404;');
  assert.deepEqual(d.map(x => [x.name, ...x.args]), [
    ['a', 'b c', 'd'],
    ['try_files', '${uri}__${args}', '$uri', '=404'],
  ]);
});

test('unknown directives fail', () => {
  const site = 'server { server_name x.whatwg.org; root /var/www/x.whatwg.org; proxy_pass http://a; }';
  assert.throws(() => convert(withSite('x.whatwg.org', site)), ConfigError);
  const loc = 'server { server_name x.whatwg.org; root /var/www/x.whatwg.org; location / { autoindex on; } }';
  assert.throws(() => convert(withSite('x.whatwg.org', loc)), /autoindex/);
});

test('TLS, gzip and listen directives are ignored', () => {
  const site = 'server { server_name x.whatwg.org; root /var/www/x.whatwg.org; listen 443 ssl; ssl_foo bar; gzip on; gzip_vary on; }';
  const config = convert(withSite('x.whatwg.org', site));
  assert.deepEqual(config.hosts['x.whatwg.org'].locations, []);
});

test('only the forums sid-stripping if block is accepted', () => {
  const ok = fs.readFileSync(new URL('../../debian/marquee/nginx/sites/forums.whatwg.org.conf', import.meta.url), 'utf8');
  const config = convert(withSite('forums.whatwg.org', ok));
  const php = config.hosts['forums.whatwg.org'].locations.find(l => l.regex === '\\.php');
  assert.deepEqual(php.features, ['strip-sid']);
  assert.deepEqual(php.tryFiles, { files: ['${uri}__${args}', '$uri'], code: 404 });
  const bad = ok.replace('permanent', 'redirect');
  assert.throws(() => convert(withSite('forums.whatwg.org', bad)), /sid-stripping/);
});

test('unsupported variables in return fail', () => {
  const site = 'server { server_name x.whatwg.org; return 301 https://a$host; }';
  assert.throws(() => convert(withSite('x.whatwg.org', site)), /\$host/);
});

test('later types replace earlier ones; types {} clears', () => {
  const config = convert(real);
  const server = config.typeTables[config.hosts['whatwg.org'].server.types];
  assert.equal(server.woff, 'application/font-woff');
  assert.equal(server.woff2, 'font/woff2');
  assert.equal(server.map, 'text/javascript');
  assert.equal(server.ttf, 'font/ttf');
  const js = config.hosts['whatwg.org'].locations.find(l => l.regex === '\\.js$');
  assert.deepEqual(config.typeTables[js.types], {});
  assert.equal(js.defaultType, 'text/javascript; charset=utf-8');
});

test('whatwg.conf locations come before the site locations', () => {
  const config = convert(real);
  const locs = config.hosts['whatwg.org'].locations;
  assert.equal(locs[0].path, '/commit-snapshots');
  assert.equal(locs[1].path, '/review-drafts');
  assert.equal(locs[2].regex, '\\.js$');
});

test('cache.conf becomes expires rules', () => {
  const { expires } = convert(real).http;
  assert.deepEqual(expires, {
    default: null,
    rules: [
      { regex: 'font', flags: '', seconds: 604800 },
      { regex: 'image/', flags: '', seconds: 604800 },
    ],
  });
});

test('config/lock-rules.json is up to date and covers every file-serving host', async () => {
  const { render: renderRules, lockRules } = await import('../tools/lock-rules.mjs');
  const config = convert(real);
  const actual = fs.readFileSync(new URL('../config/lock-rules.json', import.meta.url), 'utf8');
  assert.equal(actual, renderRules(config), 'run `npm run lock-rules` in cloudflare/');
  const { rules } = lockRules(config);
  assert.equal(rules.length, 2 * 32);
  assert.ok(rules.length <= 1000, 'R2 allows at most 1,000 lock rules per bucket');
  assert.ok(rules.some(r => r.prefix === 'html.spec.whatwg.org/commit-snapshots/'));
  assert.ok(rules.some(r => r.prefix === 'dom.spec.whatwg.org/review-drafts/'));
});
