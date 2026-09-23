/**
 * Live sweep tests.
 *
 * Board assembly is the part worth pinning: a bad slug should be skipped rather than crash the
 * day, and the cap must never be what removes the employers a user chose to track.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlugList, mergeBoards } from '../src/node/live.mjs';

test('bare slugs become boards for the simple providers', () => {
  const boards = parseSlugList('greenhouse', ['acme', 'globex']);
  assert.deepEqual(boards, [
    { provider: 'greenhouse', slug: 'acme', name: 'acme' },
    { provider: 'greenhouse', slug: 'globex', name: 'globex' },
  ]);
});

test('Workday entries carry tenant, host and site', () => {
  const [board] = parseSlugList('workday', ['acme|wd1|Careers']);
  assert.deepEqual(board, { provider: 'workday', tenant: 'acme', wd: 'wd1', site: 'Careers', name: 'acme' });
});

test('unusable entries are skipped, not fatal', () => {
  // Published lists are third-party data: blanks and half-filled Workday rows both turn up.
  assert.deepEqual(parseSlugList('workday', ['acme|wd1', '', null, 'acme|wd1|Careers']).length, 1);
  assert.deepEqual(parseSlugList('lever', ['', '  ', null, undefined]), []);
  assert.deepEqual(parseSlugList('lever', []), []);
});

test('slugs are trimmed', () => {
  assert.equal(parseSlugList('ashby', ['  acme  '])[0].slug, 'acme');
});

test("the user's own boards come first and survive the cap", () => {
  const own = parseSlugList('greenhouse', ['my-employer']);
  const discovered = parseSlugList('greenhouse', ['a', 'b', 'c', 'd']);
  const merged = mergeBoards(own, discovered, 2);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].slug, 'my-employer');
});

test('a board listed in both places appears once', () => {
  const own = parseSlugList('greenhouse', ['acme']);
  const discovered = parseSlugList('greenhouse', ['acme', 'globex']);
  assert.deepEqual(mergeBoards(own, discovered, 100).map(b => b.slug), ['acme', 'globex']);
});

test('the same slug on two providers is two boards', () => {
  const merged = mergeBoards([], [...parseSlugList('lever', ['acme']), ...parseSlugList('ashby', ['acme'])], 100);
  assert.equal(merged.length, 2);
});

test('Workday boards de-duplicate on all three parts', () => {
  const discovered = parseSlugList('workday', ['acme|wd1|Careers', 'acme|wd1|Careers', 'acme|wd1|Internal']);
  assert.equal(mergeBoards([], discovered, 100).length, 2);
});

test('the cap is reported, and only when it bites', () => {
  const lines = [];
  mergeBoards([], parseSlugList('lever', ['a', 'b']), 5, m => lines.push(m));
  assert.deepEqual(lines, []);
  mergeBoards([], parseSlugList('lever', ['a', 'b', 'c']), 2, m => lines.push(m));
  assert.match(lines[0], /capped at 2 boards of 3/);
});
