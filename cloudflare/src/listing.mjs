// Directory listings in the style of ngx-fancyindex.

// How many list() calls one listing may make. Each call returns up to 1000
// objects. Directories with more objects than this show "-" as the date for
// subdirectories that weren't reached, and those sort last by date.
export const MAX_LIST_CALLS = 200;

// Returns null if nothing exists under `prefix`.
export async function collectEntries(bucket, prefix, { maxCalls = MAX_LIST_CALLS } = {}) {
  const files = new Map();
  const dirs = new Map();
  let cursor;
  let calls = 0;
  let complete = false;
  // List every object under the prefix (no delimiter), so that each
  // subdirectory gets a date: the newest mtime of anything inside it.
  while (calls < maxCalls) {
    const result = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
    calls++;
    for (const obj of result.objects) {
      const rest = obj.key.slice(prefix.length);
      const slash = rest.indexOf('/');
      const date = objectDate(obj);
      if (slash === -1) {
        files.set(rest, { name: rest, dir: false, size: obj.size, date });
      } else {
        const name = rest.slice(0, slash);
        const d = dirs.get(name);
        if (!d) dirs.set(name, { name, dir: true, size: null, date });
        else if (date > d.date) d.date = date;
      }
    }
    if (!result.truncated) { complete = true; break; }
    cursor = result.cursor;
  }
  if (!complete) {
    // Make sure every subdirectory is at least listed, without dates for the
    // ones not reached above.
    let c;
    do {
      const result = await bucket.list({ prefix, delimiter: '/', cursor: c });
      for (const p of result.delimitedPrefixes ?? []) {
        const name = p.slice(prefix.length, -1);
        if (!dirs.has(name)) dirs.set(name, { name, dir: true, size: null, date: null });
      }
      for (const obj of result.objects) {
        const name = obj.key.slice(prefix.length);
        if (!files.has(name)) files.set(name, { name, dir: false, size: obj.size, date: objectDate(obj) });
      }
      c = result.truncated ? result.cursor : undefined;
    } while (c);
  }
  if (files.size === 0 && dirs.size === 0) return null;
  return [...dirs.values(), ...files.values()].filter(e => e.name !== '' && !e.name.startsWith('.'));
}

// rclone stores the original modification time in the "mtime" custom
// metadata, as RFC 3339 or as seconds since the epoch.
export function objectDate(obj) {
  const mtime = obj.customMetadata?.mtime;
  if (mtime) {
    const n = /^\d+(\.\d+)?$/.test(mtime) ? Number(mtime) * 1000 : Date.parse(mtime);
    if (Number.isFinite(n)) return new Date(n);
  }
  return obj.uploaded ? new Date(obj.uploaded) : null;
}

const SORT_KEYS = { N: 'name', S: 'size', M: 'date' };

// fancyindex accepts ?C=N|S|M&O=A|D to override the default sort.
export function sortFromQuery(args, defaultSort) {
  const params = new URLSearchParams(args);
  const c = params.get('C');
  const o = params.get('O');
  if (c && SORT_KEYS[c]) {
    return SORT_KEYS[c] + (o === 'D' ? '_desc' : '');
  }
  return defaultSort || 'name';
}

function compare(a, b, key) {
  if (key === 'name') return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  if (key === 'size') return (a.size ?? -1) - (b.size ?? -1) || compare(a, b, 'name');
  // date: unknown dates sort as oldest.
  return (a.date?.getTime() ?? -Infinity) - (b.date?.getTime() ?? -Infinity) || compare(a, b, 'name');
}

export function sortEntries(entries, sort) {
  const desc = sort.endsWith('_desc');
  const key = sort.replace(/_desc$/, '');
  return entries.slice().sort((a, b) => {
    // fancyindex_directories_first is on by default.
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const r = compare(a, b, key);
    return desc ? -r : r;
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// fancyindex_time_format default "%Y-%b-%d %H:%M", in GMT.
export function formatDate(date) {
  if (!date) return '-';
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${MONTHS[date.getUTCMonth()]}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

export function formatSize(size, exact) {
  if (size === null || size === undefined) return '-';
  if (exact) return String(size);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = size;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// fancyindex_name_length default 50.
function displayName(name) {
  return name.length > 50 ? name.slice(0, 47) + '..&gt;' : escapeHtml(name);
}

export function renderListing(uri, entries, { cssHref, exactSize }) {
  const title = `Index of ${escapeHtml(uri)}`;
  const header = (label, c) =>
    `<a href="?C=${c}&amp;O=A">${label}</a>&nbsp;<a href="?C=${c}&amp;O=D">&nbsp;&darr;&nbsp;</a>`;
  const rows = [];
  if (uri !== '/') {
    rows.push('<tr><td class="link"><a href="../">Parent directory/</a></td><td class="size">-</td><td class="date">-</td></tr>');
  }
  for (const e of entries) {
    const href = encodeURIComponent(e.name) + (e.dir ? '/' : '');
    const label = displayName(e.name) + (e.dir ? '/' : '');
    rows.push(`<tr><td class="link"><a href="${href}" title="${escapeHtml(e.name)}">${label}</a></td>` +
      `<td class="size">${e.dir ? '-' : formatSize(e.size, exactSize)}</td>` +
      `<td class="date">${formatDate(e.date)}</td></tr>`);
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="content-type" content="text/html; charset=utf-8"/>
<meta name="viewport" content="width=device-width"/>
${cssHref ? `<link rel="stylesheet" href="${escapeHtml(cssHref)}" type="text/css"/>\n` : ''}<title>${title}</title>
</head>
<body>
<h1>${title}</h1>
<table id="list"><thead><tr><th style="width:55%">${header('File Name', 'N')}</th><th style="width:20%">${header('File Size', 'S')}</th><th style="width:25%">${header('Date', 'M')}</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody></table>
</body>
</html>
`;
}
