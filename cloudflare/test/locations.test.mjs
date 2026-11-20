import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLocation } from '../src/locations.mjs';

const host = {
  locations: [
    { match: '', path: '/', id: 'root' },
    { match: '~*', regex: '\\.js$', id: 'js' },
    { match: '', path: '/static/', id: 'static' },
    { match: '^~', path: '/stop/', id: 'stop' },
    { match: '=', path: '/exact.js', id: 'exact' },
    { match: '~', regex: '^/static/(.*)\\.css$', id: 'css' },
    { match: '~', regex: '^/(a)(/(.*))?$', id: 'captures' },
  ],
};

const id = uri => findLocation(host, uri).location?.id;

test('exact match wins', () => assert.equal(id('/exact.js'), 'exact'));
test('^~ prefix stops regex matching', () => assert.equal(id('/stop/x.js'), 'stop'));
test('first regex in config order wins', () => {
  assert.equal(id('/static/x.JS'), 'js');
  assert.equal(id('/static/x.css'), 'css');
});
test('longest prefix when no regex matches', () => {
  assert.equal(id('/static/x.png'), 'static');
  assert.equal(id('/other'), 'root');
});
test('captures, with non-participating groups', () => {
  assert.deepEqual(findLocation(host, '/a').captures, ['/a', 'a', undefined, undefined]);
  assert.deepEqual(findLocation(host, '/a/b').captures, ['/a/b', 'a', '/b', 'b']);
});
test('no match', () => {
  assert.equal(findLocation({ locations: [] }, '/x').location, null);
});
