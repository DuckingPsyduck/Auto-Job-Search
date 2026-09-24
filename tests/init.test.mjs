/**
 * Onboarding tests.
 *
 * `init` is the first thing a new user runs and the only path that writes configuration, so it
 * gets tested end to end: answers in, two valid config files out, loadable by the same loader the
 * pipeline uses. Answers are supplied as an object, which is how the `--answers` flag works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { runInit } from '../src/node/init.mjs';
import { loadConfig } from '../src/node/config.mjs';
import { buildLaneMatcher } from '../src/node/filters.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANSWERS = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'demo-answers.json'), 'utf8'));

/** A throwaway config directory holding the example templates init copies from. */
function scratchConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ajs-init-'));
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  for (const name of ['scan-config.example.yml', 'profile.example.yml', 'portals.example.yml']) {
    copyFileSync(join(ROOT, 'config', name), join(configDir, name));
  }
  copyFileSync(join(ROOT, 'config', 'geo-terms.json'), join(configDir, 'geo-terms.json'));
  copyFileSync(join(ROOT, 'config', 'ats-vocab.yml'), join(configDir, 'ats-vocab.yml'));
  return { dir, configDir };
}

test('init writes both config files from supplied answers', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runInit({ configDir, answers: { ...ANSWERS, cv_dir: join(dir, 'cv') } });

  assert.ok(existsSync(result.profilePath), 'profile.yml written');
  assert.ok(existsSync(result.scanPath), 'scan-config.yml written');
  assert.equal(result.archetypes, 2);
  assert.equal(result.keywords, 8);
});

test('the profile it writes has no placeholders left', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { profilePath } = await runInit({ configDir, answers: { ...ANSWERS, cv_dir: join(dir, 'cv') } });
  const text = readFileSync(profilePath, 'utf8');
  assert.doesNotMatch(text, /\{\{.+?\}\}/, 'no {{PLACEHOLDER}} survives setup');

  const profile = yaml.load(text);
  assert.equal(profile.identity.full_name, ANSWERS.full_name);
  assert.equal(profile.location.home_state, 'TX');
  assert.equal(profile.location.relocating_out_of_home_state, true);
  assert.deepEqual(profile.location.preferred_cities, ['Denver', 'Seattle']);
  assert.equal(profile.compensation.base_floor, 90000);
  assert.equal(profile.targets.archetypes.length, 2);
  assert.ok(profile.constraints.never_submit, 'the never-submit constraint is written by default');
});

test('the written config loads through the normal loader', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { scanPath } = await runInit({ configDir, answers: { ...ANSWERS, cv_dir: join(dir, 'cv') } });
  const cfg = loadConfig(scanPath);

  assert.ok(cfg.profile, 'profile is found and parsed');
  assert.equal(cfg.profile.identity.email, ANSWERS.email);
  assert.ok(existsSync(cfg.paths.work_dir), 'work directory created');
  assert.ok(existsSync(cfg.paths.output_dir), 'output directory created');
});

test('scan-config keeps its documentation comments', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { scanPath } = await runInit({ configDir, answers: { ...ANSWERS, cv_dir: join(dir, 'cv') } });
  const text = readFileSync(scanPath, 'utf8');
  // The example file is copied rather than regenerated, so a user editing their own config still
  // has the guidance next to each setting.
  assert.match(text, /# auto-job-search — pipeline configuration/);
  assert.match(text, /Discovery runs wider than the reporting window/);
  assert.doesNotMatch(text, /\{\{CONTACT_EMAIL\}\}/, 'the contact placeholder is filled in');
});

test('init refuses to overwrite an existing configuration', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await runInit({ configDir, answers: { ...ANSWERS, cv_dir: join(dir, 'cv') } });
  await assert.rejects(
    () => runInit({ configDir, answers: ANSWERS }),
    /already exists/,
    'a second run without --force is refused'
  );
  await runInit({ configDir, force: true, answers: { ...ANSWERS, cv_dir: join(dir, 'cv') } });
});

test('at least one target role is required', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => runInit({ configDir, answers: { ...ANSWERS, archetypes: [], cv_dir: join(dir, 'cv') } }),
    /target role/,
    'setup without keywords would produce a scanner that matches nothing'
  );
});

test('answers accept keywords as a comma-separated string', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { profilePath } = await runInit({
    configDir,
    answers: {
      ...ANSWERS,
      cv_dir: join(dir, 'cv'),
      archetypes: [{ name: 'Data Engineer', keywords: 'data engineer, analytics engineer' }],
    },
  });
  const profile = yaml.load(readFileSync(profilePath, 'utf8'));
  assert.deepEqual(profile.targets.archetypes[0].keywords, ['data engineer', 'analytics engineer']);
});

test('CV keyword suggestions read real .docx files when Python is available', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A minimal but valid .docx: a zip with one document part. Written here rather than committed,
  // so the repository never contains a CV-shaped file.
  const cvDir = join(dir, 'cv');
  mkdirSync(cvDir, { recursive: true });
  writeFileSync(join(cvDir, 'note.txt'), 'not a docx');

  const result = await runInit({ configDir, answers: { ...ANSWERS, cv_dir: cvDir } });
  assert.equal(result.cvDir, cvDir, 'the CV folder is recorded and created');
  assert.ok(existsSync(cvDir));
});

test('lanes are generated from the user’s own target roles', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await runInit({
    configDir,
    answers: {
      ...ANSWERS,
      cv_dir: join(dir, 'cv'),
      archetypes: [
        { name: 'Registered Nurse', keywords: ['registered nurse', 'rn', 'charge nurse'] },
        { name: 'Clinical Educator', keywords: ['nurse educator'] },
      ],
    },
  });

  const cfg = loadConfig(join(configDir, 'scan-config.yml'));
  assert.deepEqual(cfg.lanes.order, ['registered_nurse', 'clinical_educator', 'other']);
  assert.equal(cfg.lanes.labels.registered_nurse, 'Registered Nurse');
  assert.equal(cfg.lanes.patterns.other, '.*', 'the catch-all survives');

  // The shipped example describes one particular job search; nobody else should inherit it.
  assert.ok(!cfg.lanes.order.includes('sysadmin'), 'no leftover lanes from the example file');

  const lanes = buildLaneMatcher(cfg);
  assert.equal(lanes.lane('Charge Nurse, Med/Surg'), 'registered_nurse');
  assert.equal(lanes.lane('Nurse Educator (Oncology)'), 'clinical_educator');
  assert.equal(lanes.lane('Warehouse Associate'), 'other');
  // "rn" must not match inside a word: that is why the generated patterns carry \b.
  assert.equal(lanes.lane('Marketing Intern'), 'other');
});

test('leadership titles are excluded only when the user asks', async t => {
  const { dir, configDir } = scratchConfigDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { ...ANSWERS, cv_dir: join(dir, 'cv') };

  await runInit({ configDir, answers: { ...base, exclude_leadership: 'y' } });
  let cfg = loadConfig(join(configDir, 'scan-config.yml'));
  assert.ok(cfg.titles.extra_negative.includes('director'));

  await runInit({ configDir, force: true, answers: { ...base, exclude_leadership: 'n' } });
  cfg = loadConfig(join(configDir, 'scan-config.yml'));
  assert.ok(!cfg.titles.extra_negative.includes('director'), 'a Director of Nursing search still works');
  assert.ok(cfg.titles.extra_negative.includes('intern'), 'internships stay excluded either way');
});
