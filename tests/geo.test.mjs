/**
 * Location classifier tests (Node side). The Python twin runs the same fixtures in
 * tests/test_geo.py, so the two implementations cannot drift apart silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Geo, workdayUrlLocation } from '../src/node/geo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const terms = JSON.parse(readFileSync(join(ROOT, 'config', 'geo-terms.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(join(HERE, 'geo_cases.json'), 'utf8'));
const geo = new Geo(terms, { homeState: fixtures.home_state });

test('classifies each fixture location', () => {
  for (const c of fixtures.cases) {
    if (!c.locs.length) continue;
    const got = geo.domestic(c.locs[0]);
    assert.equal(got, c.domestic, `${c.locs[0]} -> ${got}, expected ${c.domestic}`);
  }
});

test('ranks each fixture posting', () => {
  for (const c of fixtures.cases) {
    const { rank } = geo.rank(c.locs);
    assert.equal(rank, c.rank, `${JSON.stringify(c.locs)} -> rank ${rank}, expected ${c.rank}`);
  }
});

test('never ranks a recognised foreign location as domestic', () => {
  for (const c of fixtures.cases.filter(x => x.domestic === 'no')) {
    const { rank } = geo.rank(c.locs);
    assert.equal(rank, 4, `${c.locs[0]} must be rank 4`);
  }
});

test('unrecognised locations go to review, never to the shortlist', () => {
  for (const c of fixtures.cases.filter(x => x.domestic === 'check')) {
    const { rank, domestic } = geo.rank(c.locs);
    assert.equal(rank, 5);
    assert.equal(domestic, 'check');
  }
});

test('extracts the location from a Workday posting URL', () => {
  for (const c of fixtures.workday_url_cases) {
    assert.equal(workdayUrlLocation(c.url), c.location);
  }
});

test('home state is profile-driven, not hardcoded', () => {
  const ny = new Geo(terms, { homeState: 'NY' });
  assert.equal(ny.rank(['Poughkeepsie, NY']).rank, 3, 'home state on-site ranks last');
  assert.equal(ny.rank(['US - TX, Houston']).rank, 2, 'other states rank above it');
});
