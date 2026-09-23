/**
 * Fixture and first-run tests.
 *
 * The demo fixtures are what a new user sees before they have a profile, and what CI checks
 * without touching the network. They have to stay parseable and complete, and they must not
 * drift away from the record shape the pipeline actually writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { loadConfig } from '../src/node/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = readFileSync(join(ROOT, 'fixtures', 'demo-postings.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);

test('demo postings parse and cover every verdict', () => {
  assert.ok(rows.length >= 10, 'enough rows to fill a workbook');
  const verdicts = new Set(rows.map(r => r.verdict));
  assert.ok(verdicts.has('shortlist') && verdicts.has('check') && verdicts.has('dropped'),
    'the demo shows all three outcomes, including what was rejected and why');
});

test('demo postings carry the fields the workbook reads', () => {
  for (const row of rows) {
    for (const field of ['id', 'source', 'company', 'title', 'url', 'locations', 'verdict']) {
      assert.ok(row[field] !== undefined, `${field} present on ${row.id}`);
    }
    if (row.verdict === 'dropped') {
      assert.ok(row.verdict_reason, `dropped rows explain themselves (${row.id})`);
    }
    if (row.verdict === 'shortlist' && row.call) {
      assert.ok(['apply', 'maybe', 'skip'].includes(row.call), `valid call on ${row.id}`);
      assert.equal(typeof row.fit_tailored, 'number');
    }
  }
});

test('demo postings contain no real company or contact data', () => {
  const text = JSON.stringify(rows);
  assert.match(text, /example\.com/, 'URLs point at example.com');
  assert.doesNotMatch(text, /@(?!example\.com)[\w-]+\.[a-z]{2,}/i, 'no real email addresses');
});

test('the example config is loadable on its own', () => {
  // This is the path `ajs demo` takes on a fresh clone, before any profile exists.
  const cfg = loadConfig(join(ROOT, 'config', 'scan-config.example.yml'));
  assert.equal(cfg.profile, null, 'no profile is required to read the example config');
  assert.ok(cfg.paths.outputs.demo, 'a demo output name is configured');
});

test('the demo profile is complete and has no placeholders', () => {
  const text = readFileSync(join(ROOT, 'fixtures', 'demo-profile.yml'), 'utf8');
  assert.doesNotMatch(text, /\{\{.+?\}\}/);
  const profile = yaml.load(text);
  assert.ok(profile.targets.archetypes.length >= 1);
  assert.ok(profile.targets.archetypes.every(a => (a.keywords || []).length), 'every role has keywords');
});

test('the example profile still has placeholders, so setup cannot be skipped by accident', () => {
  const text = readFileSync(join(ROOT, 'config', 'profile.example.yml'), 'utf8');
  assert.match(text, /\{\{CANDIDATE_NAME\}\}/);
});
