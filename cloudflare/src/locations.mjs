// nginx location matching.
//
// 1. An `=` exact match wins.
// 2. Otherwise find the longest prefix match. If it is `^~`, it wins.
// 3. Otherwise the first matching regex (`~`, `~*`) in config order wins.
// 4. Otherwise the longest prefix match wins.
//
// Captures of the winning regex are returned for use in `return`.

const compiled = new WeakMap();

function compile(host) {
  let c = compiled.get(host);
  if (c) return c;
  const exact = new Map();
  const prefixes = [];
  const regexes = [];
  for (const loc of host.locations) {
    if (loc.match === '=') {
      // nginx uses the first definition of a duplicate; nginx -t rejects
      // duplicates anyway.
      if (!exact.has(loc.path)) exact.set(loc.path, loc);
    } else if (loc.match === '' || loc.match === '^~') {
      prefixes.push(loc);
    } else {
      regexes.push({ loc, re: new RegExp(loc.regex, loc.match === '~*' ? 'i' : '') });
    }
  }
  // Longest first, so the first match is the longest.
  prefixes.sort((a, b) => b.path.length - a.path.length);
  c = { exact, prefixes, regexes };
  compiled.set(host, c);
  return c;
}

export function findLocation(host, uri) {
  const { exact, prefixes, regexes } = compile(host);
  const e = exact.get(uri);
  if (e) return { location: e, captures: [] };
  const prefix = prefixes.find(p => uri.startsWith(p.path)) ?? null;
  if (prefix && prefix.match === '^~') return { location: prefix, captures: [] };
  for (const { loc, re } of regexes) {
    const m = re.exec(uri);
    if (m) return { location: loc, captures: Array.from(m) };
  }
  return { location: prefix, captures: [] };
}
