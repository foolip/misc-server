#!/usr/bin/env node
// Converts the marquee nginx configuration into cloudflare/config/hosts.json,
// the configuration that the Cloudflare Worker reads.
//
// While marquee is live, the nginx files in debian/marquee/ are the source of
// truth. CI runs `node tools/nginx-to-json.mjs --check` to make sure that
// hosts.json is up to date. After cutover, this converter and the nginx files
// are deleted and hosts.json is edited directly.
//
// Usage:
//   node tools/nginx-to-json.mjs           # write config/hosts.json
//   node tools/nginx-to-json.mjs --check   # exit 1 if config/hosts.json is stale
//   node tools/nginx-to-json.mjs --stdout  # print to stdout
//
// The converter only understands the subset of nginx that marquee uses, and
// fails on any directive it doesn't know. TLS, gzip and listen directives are
// ignored because Cloudflare handles them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUDFLARE_DIR = path.resolve(HERE, '..');
const REPO_DIR = path.resolve(CLOUDFLARE_DIR, '..');
const MARQUEE_DIR = path.join(REPO_DIR, 'debian', 'marquee');
const OUTPUT = path.join(CLOUDFLARE_DIR, 'config', 'hosts.json');

// nginx's default charset_types (ngx_http_charset_filter_module.c).
const DEFAULT_CHARSET_TYPES = [
  'text/html',
  'text/xml',
  'text/plain',
  'text/vnd.wap.wml',
  'application/javascript',
  'application/rss+xml',
];

// Directives that are ignored, because Cloudflare does the equivalent.
const IGNORED_DIRECTIVE = /^(listen|ssl_.*|gzip|gzip_.*)$/;

export class ConfigError extends Error {}

// --- Tokenizer and parser --------------------------------------------------

function tokenize(text, file) {
  const tokens = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '{' || c === '}' || c === ';') {
      tokens.push({ value: c, special: true, line });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let value = '';
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === '\n') line++;
        value += text[i++];
      }
      if (i >= text.length) throw new ConfigError(`${file}:${line}: unterminated string`);
      i++;
      tokens.push({ value, quoted: true, line });
      continue;
    }
    let value = '';
    while (i < text.length && !/[\s;{}]/.test(text[i])) {
      // ${var} contains braces that are part of the token.
      if (text[i] === '$' && text[i + 1] === '{') {
        const end = text.indexOf('}', i);
        value += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      value += text[i++];
    }
    tokens.push({ value, line });
  }
  return tokens;
}

// Returns a list of { name, args, block?, file, line }.
export function parse(text, file = '<input>') {
  const tokens = tokenize(text, file);
  let pos = 0;
  function parseBlock(nested) {
    const directives = [];
    for (;;) {
      if (pos >= tokens.length) {
        if (nested) throw new ConfigError(`${file}: unexpected end of file`);
        return directives;
      }
      const tok = tokens[pos];
      if (tok.special && tok.value === '}') {
        if (!nested) throw new ConfigError(`${file}:${tok.line}: unexpected }`);
        pos++;
        return directives;
      }
      if (tok.special) throw new ConfigError(`${file}:${tok.line}: unexpected ${tok.value}`);
      const name = tok.value;
      const args = [];
      pos++;
      for (;;) {
        const t = tokens[pos];
        if (!t) throw new ConfigError(`${file}:${tok.line}: unterminated directive ${name}`);
        if (t.special && t.value === ';') {
          pos++;
          directives.push({ name, args, file, line: tok.line });
          break;
        }
        if (t.special && t.value === '{') {
          pos++;
          const block = parseBlock(true);
          directives.push({ name, args, block, file, line: tok.line });
          break;
        }
        if (t.special) throw new ConfigError(`${file}:${t.line}: unexpected }`);
        args.push(t.value);
        pos++;
      }
    }
  }
  return parseBlock(false);
}

// --- Include resolution ----------------------------------------------------

function makeIncludeResolver(files) {
  return function resolve(arg, from) {
    const base = path.basename(arg);
    if (!(base in files)) {
      throw new ConfigError(`${from.file}:${from.line}: unknown include ${arg}`);
    }
    return parse(files[base].text, files[base].label);
  };
}

function expandIncludes(directives, resolveInclude) {
  const out = [];
  for (const d of directives) {
    if (d.name === 'include') {
      if (d.args.length !== 1) fail(d, 'include takes one argument');
      out.push(...expandIncludes(resolveInclude(d.args[0], d), resolveInclude));
    } else if (d.block) {
      out.push({ ...d, block: expandIncludes(d.block, resolveInclude) });
    } else {
      out.push(d);
    }
  }
  return out;
}

function fail(d, message) {
  throw new ConfigError(`${d.file}:${d.line}: ${d.name}: ${message}`);
}

// --- Type tables -----------------------------------------------------------

class TypeTables {
  constructor() {
    this.tables = [];
    this.keys = new Map();
  }
  intern(table) {
    const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const key = JSON.stringify(sorted);
    if (!this.keys.has(key)) {
      this.keys.set(key, this.tables.length);
      this.tables.push(sorted);
    }
    return this.keys.get(key);
  }
}

// nginx merges multiple `types` blocks in the same context. A later
// definition of an extension replaces an earlier one.
function addTypes(table, d) {
  for (const entry of d.block) {
    if (entry.block) fail(entry, 'unexpected block in types');
    if (entry.args.length === 0) fail(entry, 'type without extensions');
    for (const ext of entry.args) {
      table[ext.toLowerCase()] = entry.name;
    }
  }
}

// --- Context handling ------------------------------------------------------

function parseReturn(d) {
  if (d.args.length < 1 || d.args.length > 2) fail(d, 'expected 1 or 2 arguments');
  let code;
  let text = null;
  if (d.args.length === 1 && !/^\d+$/.test(d.args[0])) {
    // `return URL;` means 302.
    code = 302;
    text = d.args[0];
  } else {
    code = Number(d.args[0]);
    if (d.args.length === 2) text = d.args[1];
  }
  if (!(code >= 200 && code <= 599) && code !== 444) fail(d, `bad status ${code}`);
  if (text !== null) {
    for (const m of text.matchAll(/\$(\{?)([A-Za-z_0-9]+)\}?/g)) {
      const name = m[2];
      if (name !== 'request_uri' && !/^[1-9]$/.test(name)) {
        fail(d, `unsupported variable $${name}`);
      }
    }
  }
  if ([301, 302, 303, 307, 308].includes(code) && text === null) {
    fail(d, 'redirect without URL');
  }
  return text === null ? { code } : { code, text };
}

function parseAddHeader(d) {
  if (d.args.length === 2) return [d.args[0], d.args[1], false];
  if (d.args.length === 3 && d.args[2] === 'always') return [d.args[0], d.args[1], true];
  fail(d, 'expected name value [always]');
}

function parseErrorPage(d, ctx) {
  if (d.args.length < 2) fail(d, 'expected codes and URI');
  const uri = d.args[d.args.length - 1];
  if (!uri.startsWith('/')) fail(d, 'only local error pages are supported');
  ctx.errorPage ??= {};
  for (const code of d.args.slice(0, -1)) {
    if (!/^\d{3}$/.test(code)) fail(d, `unsupported error_page argument ${code}`);
    ctx.errorPage[code] = uri;
  }
}

const FANCYINDEX_SORTS = ['name', 'size', 'date', 'name_desc', 'size_desc', 'date_desc'];

// The forums.whatwg.org `if` block that strips &sid=... from the query string.
// This exact block is recognized and turned into the "strip-sid" feature;
// `if` and `rewrite` are not supported in general.
const STRIP_SID_IF_ARGS = ['($args', '~', '^(.*?)&?sid=[a-z0-9]*$)'];
const STRIP_SID_BODY = [
  ['set', '$stripped', '$1$2'],
  ['rewrite', '^(.*)$', '$1?$stripped?', 'permanent'],
];

function isStripSidBlock(d) {
  return d.name === 'if' &&
    JSON.stringify(d.args) === JSON.stringify(STRIP_SID_IF_ARGS) &&
    JSON.stringify(d.block.map(x => x.block ? null : [x.name, ...x.args])) === JSON.stringify(STRIP_SID_BODY);
}

function parseTryFiles(d) {
  if (d.args.length < 2) fail(d, 'expected at least two arguments');
  const files = d.args.slice(0, -1);
  const last = d.args[d.args.length - 1];
  if (!/^=\d{3}$/.test(last)) fail(d, 'only a final =code is supported');
  for (const f of files) {
    for (const m of f.matchAll(/\$\{?([A-Za-z_0-9]+)\}?/g)) {
      if (m[1] !== 'uri' && m[1] !== 'args') fail(d, `unsupported variable $${m[1]}`);
    }
  }
  return { files, code: Number(last.slice(1)) };
}

// Directives shared by server and location contexts.
function applyCommon(d, ctx, typeTables) {
  switch (d.name) {
    case 'default_type':
      if (d.args.length !== 1) fail(d, 'expected one argument');
      ctx.defaultType = d.args[0];
      return true;
    case 'types': {
      if (!d.block || d.args.length) fail(d, 'expected a block');
      ctx._types ??= {};
      addTypes(ctx._types, d);
      return true;
    }
    case 'add_header':
      // Like nginx, a context with any add_header doesn't inherit any.
      (ctx.addHeader ??= []).push(parseAddHeader(d));
      return true;
    case 'error_page':
      parseErrorPage(d, ctx);
      return true;
    case 'index':
      if (d.args.length < 1) fail(d, 'expected arguments');
      ctx.index = d.args;
      return true;
    case 'charset':
      if (d.args.length !== 1) fail(d, 'expected one argument');
      ctx.charset = d.args[0] === 'off' ? null : d.args[0];
      return true;
    case 'fancyindex':
      if (d.args.length !== 1 || !['on', 'off'].includes(d.args[0])) fail(d, 'expected on|off');
      ctx.fancyindex = d.args[0] === 'on';
      return true;
    case 'fancyindex_exact_size':
      if (d.args.length !== 1 || !['on', 'off'].includes(d.args[0])) fail(d, 'expected on|off');
      ctx.fancyindexExactSize = d.args[0] === 'on';
      return true;
    case 'fancyindex_css_href':
      if (d.args.length !== 1) fail(d, 'expected one argument');
      ctx.fancyindexCssHref = d.args[0];
      return true;
    case 'fancyindex_default_sort':
      if (d.args.length !== 1 || !FANCYINDEX_SORTS.includes(d.args[0])) fail(d, 'bad sort');
      ctx.fancyindexDefaultSort = d.args[0];
      return true;
  }
  return false;
}

function finishTypes(ctx, typeTables) {
  if (ctx._types) {
    ctx.types = typeTables.intern(ctx._types);
    delete ctx._types;
  }
}

function parseLocation(d, typeTables) {
  let loc;
  const a = d.args;
  if (a.length === 2 && (a[0] === '=' || a[0] === '^~')) {
    loc = { match: a[0], path: a[1] };
  } else if (a.length === 2 && (a[0] === '~' || a[0] === '~*')) {
    try {
      new RegExp(a[1], a[0] === '~*' ? 'i' : '');
    } catch (e) {
      fail(d, `regex not supported in JavaScript: ${a[1]}`);
    }
    loc = { match: a[0], regex: a[1] };
  } else if (a.length === 1 && !a[0].startsWith('@') && !['=', '^~', '~', '~*'].includes(a[0])) {
    loc = { match: '', path: a[0] };
  } else {
    fail(d, `unsupported location ${a.join(' ')}`);
  }
  for (const c of d.block) {
    if (applyCommon(c, loc, typeTables)) continue;
    switch (c.name) {
      case 'return':
        if (loc.return) fail(c, 'duplicate return');
        loc.return = parseReturn(c);
        continue;
      case 'try_files':
        loc.tryFiles = parseTryFiles(c);
        continue;
      case 'if':
        if (isStripSidBlock(c)) {
          (loc.features ??= []).push('strip-sid');
          continue;
        }
        fail(c, 'only the forums.whatwg.org sid-stripping block is supported');
    }
    if (c.block && c.name === 'location') fail(c, 'nested locations are not supported');
    fail(c, 'unknown directive in location');
  }
  finishTypes(loc, typeTables);
  return loc;
}

function convertServer(domain, directives, typeTables) {
  const servers = directives.filter(d => d.name === 'server');
  if (servers.length !== 1 || directives.length !== 1) {
    throw new ConfigError(`${domain}: expected exactly one server block`);
  }
  const server = {};
  const locations = [];
  let serverReturn = null;
  let root = null;
  for (const d of servers[0].block) {
    if (IGNORED_DIRECTIVE.test(d.name)) continue;
    if (applyCommon(d, server, typeTables)) continue;
    switch (d.name) {
      case 'server_name':
        if (d.args.length !== 1 || d.args[0] !== domain) fail(d, `expected server_name ${domain}`);
        continue;
      case 'root':
        if (d.args.length !== 1 || d.args[0] !== `/var/www/${domain}`) {
          fail(d, `expected root /var/www/${domain}`);
        }
        root = d.args[0];
        continue;
      case 'return':
        if (serverReturn) fail(d, 'duplicate return');
        serverReturn = parseReturn(d);
        continue;
      case 'location':
        if (!d.block) fail(d, 'expected a block');
        locations.push(parseLocation(d, typeTables));
        continue;
    }
    fail(d, 'unknown directive in server');
  }
  finishTypes(server, typeTables);

  if (serverReturn) {
    // A server-level return runs in the rewrite phase, before location
    // matching, so the locations are unreachable. Server-level settings like
    // add_header still apply to the response.
    if (root !== null) throw new ConfigError(`${domain}: both root and return`);
    return { serveFiles: false, return: serverReturn, server };
  }
  if (root === null) throw new ConfigError(`${domain}: no root and no return`);
  return { serveFiles: true, server, locations };
}

// Parses cache.conf: a `map $sent_http_content_type $expires` and
// `expires $expires;` at http level.
function convertHttpConf(directives) {
  let map = null;
  let expiresVar = null;
  for (const d of directives) {
    if (d.name === 'map') {
      if (d.args.length !== 2 || d.args[0] !== '$sent_http_content_type') {
        fail(d, 'only a map on $sent_http_content_type is supported');
      }
      map = { variable: d.args[1], default: null, rules: [] };
      for (const e of d.block) {
        if (e.block || e.args.length !== 1) fail(e, 'unsupported map entry');
        const value = e.args[0];
        if (value !== 'off' && !/^\d+[dhms]$/.test(value)) fail(e, `unsupported expires value ${value}`);
        if (e.name === 'default') {
          map.default = value;
        } else if (e.name.startsWith('~*')) {
          map.rules.push({ regex: e.name.slice(2), flags: 'i', value });
        } else if (e.name.startsWith('~')) {
          map.rules.push({ regex: e.name.slice(1), flags: '', value });
        } else {
          fail(e, 'only regex map entries are supported');
        }
      }
    } else if (d.name === 'expires') {
      if (d.args.length !== 1) fail(d, 'expected one argument');
      expiresVar = d.args[0];
    } else {
      fail(d, 'unknown directive at http level');
    }
  }
  if (!map || expiresVar !== map.variable) {
    throw new ConfigError('cache.conf: expected expires to use the content type map');
  }
  const toSeconds = v => v === 'off' ? null :
    Number(v.slice(0, -1)) * { d: 86400, h: 3600, m: 60, s: 1 }[v.slice(-1)];
  return {
    default: toSeconds(map.default ?? 'off'),
    rules: map.rules.map(r => ({ regex: r.regex, flags: r.flags, seconds: toSeconds(r.value) })),
  };
}

// --- Output ----------------------------------------------------------------

// JSON with one location (or type table entry) per line, so that diffs of
// hosts.json are readable.
function stringify(value, indent = '') {
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(v => typeof v !== 'object' || v === null || Array.isArray(v) || isFlat(v))) {
      if (value.every(v => typeof v !== 'object' || v === null)) return JSON.stringify(value);
      return '[\n' + value.map(v => inner + JSON.stringify(v)).join(',\n') + '\n' + indent + ']';
    }
    return '[\n' + value.map(v => inner + stringify(v, inner)).join(',\n') + '\n' + indent + ']';
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    if (isFlat(value) && JSON.stringify(value).length < 100) return JSON.stringify(value);
    return '{\n' + entries.map(([k, v]) => inner + JSON.stringify(k) + ': ' + stringify(v, inner)).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(value);
}

function isFlat(obj) {
  return Object.values(obj).every(v => typeof v !== 'object' || v === null ||
    (Array.isArray(v) && v.every(x => typeof x !== 'object' || x === null)) ||
    (!Array.isArray(v) && Object.values(v).every(x => typeof x !== 'object' || x === null)));
}

// --- Main ------------------------------------------------------------------

export function readInputs(marqueeDir = MARQUEE_DIR, mimeTypesPath = path.join(CLOUDFLARE_DIR, 'vendor', 'mime.types')) {
  const read = p => fs.readFileSync(p, 'utf8');
  const conf = path.join(marqueeDir, 'nginx', 'conf');
  const domains = read(path.join(marqueeDir, 'DOMAINS')).split('\n').map(s => s.trim()).filter(Boolean);
  const sites = {};
  for (const domain of domains) {
    sites[domain] = read(path.join(marqueeDir, 'nginx', 'sites', `${domain}.conf`));
  }
  return {
    domains,
    sites,
    includes: {
      'whatwg.conf': { text: read(path.join(conf, 'whatwg.conf')), label: 'nginx/conf/whatwg.conf' },
      'whatwg-headers.conf': { text: read(path.join(conf, 'whatwg-headers.conf')), label: 'nginx/conf/whatwg-headers.conf' },
      'mime.types': { text: read(mimeTypesPath), label: 'vendor/mime.types' },
    },
    cacheConf: read(path.join(conf, 'cache.conf')),
  };
}

export function convert(inputs) {
  const typeTables = new TypeTables();
  const resolveInclude = makeIncludeResolver(inputs.includes);

  // http level: Debian's default nginx.conf has `include mime.types;` and
  // `default_type application/octet-stream;`.
  const httpTypes = {};
  for (const d of parse(inputs.includes['mime.types'].text, 'vendor/mime.types')) {
    if (d.name !== 'types' || !d.block) fail(d, 'expected a types block');
    addTypes(httpTypes, d);
  }
  const http = {
    defaultType: 'application/octet-stream',
    types: typeTables.intern(httpTypes),
    charsetTypes: DEFAULT_CHARSET_TYPES,
    expires: convertHttpConf(parse(inputs.cacheConf, 'nginx/conf/cache.conf')),
  };

  const hosts = {};
  for (const domain of inputs.domains) {
    const label = `nginx/sites/${domain}.conf`;
    const directives = expandIncludes(parse(inputs.sites[domain], label), resolveInclude);
    hosts[domain] = convertServer(domain, directives, typeTables);
  }

  return {
    _comment: 'Generated by cloudflare/tools/nginx-to-json.mjs from debian/marquee/. Do not edit while marquee is live.',
    http,
    typeTables: typeTables.tables,
    hosts,
  };
}

export function render(config) {
  return stringify(config) + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const output = render(convert(readInputs()));
  if (args.includes('--stdout')) {
    process.stdout.write(output);
  } else if (args.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== output) {
      console.error('config/hosts.json is out of date. Run `node tools/nginx-to-json.mjs` in cloudflare/ and commit the result.');
      process.exit(1);
    }
    console.log('config/hosts.json is up to date.');
  } else {
    fs.writeFileSync(OUTPUT, output);
    console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(e instanceof ConfigError ? `error: ${e.message}` : e);
    process.exit(1);
  });
}
