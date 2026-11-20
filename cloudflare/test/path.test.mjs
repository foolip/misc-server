import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePath, normalizePath, extension, escapePath, BadRequest } from '../src/path.mjs';

test('decodePath', () => {
  assert.equal(decodePath('/a%20b'), '/a b');
  assert.equal(decodePath('/a%2Fb'), '/a/b');
  assert.equal(decodePath('/%C3%A5'), '/å');
  assert.throws(() => decodePath('/%zz'), BadRequest);
  assert.throws(() => decodePath('/%00'), BadRequest);
});

test('normalizePath', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('//a///b'), '/a/b');
  assert.equal(normalizePath('/a/./b/'), '/a/b/');
  assert.equal(normalizePath('/a/b/../c'), '/a/c');
  assert.equal(normalizePath('/a/..'), '/');
  assert.equal(normalizePath('/a/b/.'), '/a/b/');
  assert.throws(() => normalizePath('/..'), BadRequest);
});

test('extension', () => {
  assert.equal(extension('/a/b.HTML'), 'html');
  assert.equal(extension('/a.d/b'), '');
  assert.equal(extension('/a/b.min.js.map'), 'map');
  assert.equal(extension('/a/'), '');
});

test('escapePath', () => {
  assert.equal(escapePath('/a b/å'), '/a%20b/%C3%A5');
  assert.equal(escapePath('/mailing-list)'), '/mailing-list)');
});
