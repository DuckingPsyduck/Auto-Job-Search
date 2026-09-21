/**
 * Onboarding: the first thing a new user runs.
 *
 * Asks what the pipeline cannot infer, reads their CV documents to propose keywords, and writes
 * a working `config/profile.yml` and `config/scan-config.yml`. Nobody should have to open a YAML
 * file to get a first scan, and nobody should have to invent search keywords from scratch —
 * keywords are the single biggest lever on result quality, so we read what their CV already says.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as yaml from 'js-yaml';
import { REPO_ROOT } from './config.mjs';

/** Find a usable Python, or null. Reporting and CV reading need it; the scan does not. */
export function findPython() {
  for (const [cmd, args] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const probe = spawnSync(cmd, [...args, '-c', 'import openpyxl, yaml'], { encoding: 'utf8' });
    if (probe.status === 0) return { cmd, args };
  }
  return null;
}

/** Ask Python to read the CV folder and propose titles and skills. */
function suggestFromCvs(python, cvDir) {
  if (!python) return null;
  const res = spawnSync(
    python.cmd,
    [...python.args, '-m', 'careerkit.cli', 'suggest', '--cv-dir', cvDir,
     '--vocab', join(REPO_ROOT, 'config', 'ats-vocab.yml')],
    { encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(REPO_ROOT, 'src', 'python'), PYTHONIOENCODING: 'utf-8' } }
  );
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const yes = s => /^y(es)?$/i.test(String(s || '').trim());

export async function runInit({ configDir = join(REPO_ROOT, 'config'), force = false } = {}) {
  const profilePath = join(configDir, 'profile.yml');
  const scanPath = join(configDir, 'scan-config.yml');
  if (!force && (existsSync(profilePath) || existsSync(scanPath))) {
    throw new Error(`config already exists in ${configDir}. Re-run with --force to overwrite.`);
  }
  if (!stdin.isTTY) {
    throw new Error('init is interactive; run it in a terminal (or copy config/*.example.yml by hand).');
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (question, fallback = '') => {
    const answer = (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim();
    return answer || fallback;
  };

  stdout.write(`
careerops-kit setup
-------------------
This writes config/profile.yml (your details, never committed) and config/scan-config.yml
(pipeline settings). Press Enter to accept a default. You can edit both files afterwards.

`);

  // 1. Identity -------------------------------------------------------------------------
  const full_name = await ask('Your full name:');
  const email = await ask('Email:');
  const phone = await ask('Phone (optional):');
  const linkedin = await ask('LinkedIn URL (optional):');
  const github = await ask('GitHub/portfolio URL (optional):');

  // 2. Eligibility ----------------------------------------------------------------------
  const citizenship = await ask('Country you can work in without sponsorship:', 'US');
  const clearanceCurrent = (await ask('Security clearance — active, inactive or none?', 'none')).toLowerCase();
  const clearanceHighest = clearanceCurrent === 'none'
    ? await ask('Highest clearance ever held (blank if none):')
    : await ask('Clearance level:');

  // 3. Location -------------------------------------------------------------------------
  const home_state = (await ask('Home state/region code (e.g. TX):')).toUpperCase();
  const relocating = yes(await ask('Are you relocating out of there? (y/n)', 'n'));
  const preferred = list(await ask('Preferred cities, comma separated (optional):'));
  const excluded = list(await ask('Cities to avoid, comma separated (optional):'));
  const remote_ok = yes(await ask('Include remote roles? (y/n)', 'y'));

  // 4. Money ----------------------------------------------------------------------------
  const base_floor = Number(await ask('Minimum acceptable base salary (0 for none):', '0')) || 0;
  const target_min = Number(await ask('Target base, low end (0 to skip):', '0')) || 0;
  const target_max = Number(await ask('Target base, high end (0 to skip):', '0')) || 0;

  // 5. CVs and keywords -----------------------------------------------------------------
  const defaultCvDir = join(REPO_ROOT, 'private', 'cv');
  const cvDir = resolve(await ask('Folder holding your CV .docx files:', defaultCvDir));
  mkdirSync(cvDir, { recursive: true });

  const python = findPython();
  if (!python) {
    stdout.write('\nNote: Python with openpyxl and PyYAML was not found. Scanning works without it;\n' +
                 'Excel reports and CV keyword suggestions need it. See README.\n');
  }
  const suggestions = suggestFromCvs(python, cvDir);
  if (suggestions?.files?.length) {
    stdout.write(`\nRead ${suggestions.files.length} CV file(s).\n`);
    if (suggestions.titles.length) stdout.write(`Roles found: ${suggestions.titles.join(', ')}\n`);
    if (suggestions.skills.length) stdout.write(`Skills found: ${suggestions.skills.slice(0, 12).join(', ')}\n`);
  } else if (python) {
    stdout.write('\nNo .docx CVs found in that folder — you can add them later and re-run init.\n');
  }

  const archetypes = [];
  const suggestedTitles = suggestions?.titles || [];
  for (let i = 1; i <= 3; i++) {
    const fallbackName = suggestedTitles[i - 1] || '';
    const name = await ask(`\nTarget role ${i} (blank to stop):`, i === 1 ? fallbackName : '');
    if (!name) break;
    const kwFallback = [name, ...suggestedTitles.filter(t => t !== name).slice(0, 2)].join(', ');
    const keywords = list(await ask('  Title keywords to search for, comma separated:', kwFallback));
    const cv = await ask('  CV file for this role (optional):', suggestions?.files?.[i - 1] || '');
    archetypes.push({ name, priority: i === 1 ? 'primary' : 'secondary', keywords, cv });
  }
  if (!archetypes.length) {
    rl.close();
    throw new Error('at least one target role is required — the scanners match on its keywords');
  }

  await rl.close();

  // 6. Write the files -------------------------------------------------------------------
  const profile = {
    version: 1,
    identity: { full_name, email, phone, links: { linkedin, github, portfolio: '' } },
    eligibility: {
      citizenship,
      work_authorization: `${citizenship} work authorization`,
      veteran: false,
      clearance: { current: clearanceCurrent, highest_held: clearanceHighest, expired: '' },
    },
    location: {
      home_country: citizenship,
      home_state,
      relocating_out_of_home_state: relocating,
      preferred_cities: preferred,
      excluded_cities: excluded,
      remote_ok,
      ranking_note: relocating
        ? `1 remote, 2 on-site outside ${home_state}, 3 on-site in ${home_state}, 4 outside ${citizenship}.`
        : `1 remote, 2 on-site anywhere in ${citizenship}, 4 outside ${citizenship}.`,
    },
    compensation: { currency: 'USD', base_floor, target_min, target_max, notes: '' },
    targets: {
      archetypes: archetypes.map(a => ({ name: a.name, priority: a.priority, keywords: a.keywords })),
      cv_masters: Object.fromEntries(archetypes.filter(a => a.cv).map(a => [a.name, a.cv])),
    },
    narrative: { headline: '', exit_story: '', superpowers: [] },
    confirmed_facts: [],
    constraints: {
      never_fabricate: true,
      never_submit: true,
      no_account_creation: true,
      respect_site_terms: true,
      honeypot_phrases: [],
    },
  };

  const header = `# careerops-kit — candidate profile (generated by \`careerkit init\`)\n` +
    `# Personal data lives only here, and this file is gitignored.\n` +
    `# Full documentation of every field: config/profile.example.yml\n\n`;
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, header + yaml.dump(profile, { lineWidth: 100, noRefs: true }), 'utf8');

  // The example config carries its documentation in comments, so copy it and patch the few
  // values onboarding knows, rather than regenerating it and losing the guidance.
  const example = readFileSync(join(configDir, 'scan-config.example.yml'), 'utf8');
  const scanConfig = example
    .replace('{{CONTACT_EMAIL}}', email || 'you@example.com')
    .replace(/^(\s*cv_dir:\s*).*$/m, `$1${JSON.stringify(cvDir)}`);
  writeFileSync(scanPath, scanConfig, 'utf8');

  return { profilePath, scanPath, cvDir, python: Boolean(python), archetypes: archetypes.length,
           keywords: archetypes.flatMap(a => a.keywords).length };
}
