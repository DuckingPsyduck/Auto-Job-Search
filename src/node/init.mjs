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
    [...python.args, '-m', 'ajs.cli', 'suggest', '--cv-dir', cvDir,
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

/** The whole `lanes:` block in the example file: the key, then every indented line under it. */
const LANES_BLOCK_RX = new RegExp('^lanes:\\n(?:(?:[ \\t].*)?\\n)*', 'm');

/** A YAML-safe key for a target role: "Registered Nurse" -> registered_nurse. */
const laneKey = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'role';

/**
 * Build the `lanes:` block from the user's own target roles.
 *
 * Lanes are how the workbook groups a day's postings. Shipping the example file's lanes to
 * everyone put every row of a nurse's workbook under "Sysadmin / DBA / SRE"'s neighbour, the
 * catch-all — technically fine, useless to read. One lane per target role, matched on that
 * role's own keywords, plus a real "other" for everything else.
 */
export function lanesBlock(archetypes) {
  const escape = t => String(t).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seen = new Set();
  const lanes = [];
  for (const a of archetypes) {
    let key = laneKey(a.name);
    while (seen.has(key)) key += '_2';
    seen.add(key);
    // Case-insensitive de-duplication, because a role's name is usually also one of its
    // keywords. Word boundaries matter here: "rn" unanchored also matches "Intern".
    const terms = new Map();
    for (const term of [a.name, ...a.keywords]) {
      const clean = String(term).trim();
      if (clean) terms.set(clean.toLowerCase(), escape(clean));
    }
    lanes.push({ key, label: a.name, pattern: `\\b(${[...terms.values()].join('|')})\\b` });
  }
  const q = v => JSON.stringify(String(v));
  return [
    'lanes:',
    '  # Postings are bucketed by title so the workbook groups by the kind of work. These were',
    '  # generated from your target roles; edit freely. `other` is the catch-all and stays last.',
    `  order: [${[...lanes.map(l => l.key), 'other'].join(', ')}]`,
    '  labels:',
    ...lanes.map(l => `    ${l.key}: ${q(l.label)}`),
    '    other: "Other"',
    '  patterns:',
    ...lanes.map(l => `    ${l.key}: ${q(l.pattern)}`),
    "    other: '.*'                           # fallback; keep last in `order`",
    '',
  ].join('\n');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.configDir] where to write the two config files
 * @param {boolean} [opts.force] overwrite an existing configuration
 * @param {object|null} [opts.answers] pre-supplied answers; when given, nothing is prompted.
 *   Keys match the prompts below (full_name, email, home_state, archetypes, …). This is what
 *   makes setup scriptable — for tests, for CI, and for an agent running setup on a user's
 *   behalf from information it already has.
 */
export async function runInit({ configDir = join(REPO_ROOT, 'config'), force = false, answers = null } = {}) {
  const profilePath = join(configDir, 'profile.yml');
  const scanPath = join(configDir, 'scan-config.yml');
  if (!force && (existsSync(profilePath) || existsSync(scanPath))) {
    throw new Error(`config already exists in ${configDir}. Re-run with --force to overwrite.`);
  }
  if (!answers && !stdin.isTTY) {
    throw new Error(
      'init is interactive; run it in a terminal, pass --answers <file.json>, ' +
      'or copy config/*.example.yml by hand.'
    );
  }

  const rl = answers ? null : createInterface({ input: stdin, output: stdout });
  /** Ask, or take the value from the answers file, or fall back to the default. */
  const ask = async (question, fallback = '', key = null) => {
    if (answers) {
      const supplied = key && answers[key] !== undefined ? answers[key] : undefined;
      return String(supplied ?? fallback).trim();
    }
    const answer = (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim();
    return answer || fallback;
  };
  const say = msg => {
    if (!answers) stdout.write(msg);
  };

  say(`
auto-job-search setup
-------------------
This writes config/profile.yml (your details, never committed) and config/scan-config.yml
(pipeline settings). Press Enter to accept a default. You can edit both files afterwards.

`);

  // 1. Identity -------------------------------------------------------------------------
  const full_name = await ask('Your full name:', '', 'full_name');
  const email = await ask('Email:', '', 'email');
  const phone = await ask('Phone (optional):', '', 'phone');
  const linkedin = await ask('LinkedIn URL (optional):', '', 'linkedin');
  const github = await ask('GitHub/portfolio URL (optional):', '', 'github');

  // 2. Eligibility ----------------------------------------------------------------------
  const citizenship = await ask('Country you can work in without sponsorship:', 'US', 'citizenship');
  const clearanceCurrent = (await ask('Security clearance — active, inactive or none?', 'none', 'clearance_current')).toLowerCase();
  const clearanceHighest = clearanceCurrent === 'none'
    ? await ask('Highest clearance ever held (blank if none):', '', 'clearance_highest')
    : await ask('Clearance level:', '', 'clearance_highest');

  // 3. Location -------------------------------------------------------------------------
  const home_state = (await ask('Home state/region code (e.g. TX):', '', 'home_state')).toUpperCase();
  const relocating = yes(await ask('Are you relocating out of there? (y/n)', 'n', 'relocating'));
  const preferred = list(await ask('Preferred cities, comma separated (optional):', '', 'preferred_cities'));
  const excluded = list(await ask('Cities to avoid, comma separated (optional):', '', 'excluded_cities'));
  const remote_ok = yes(await ask('Include remote roles? (y/n)', 'y', 'remote_ok'));

  // 4. Money ----------------------------------------------------------------------------
  const base_floor = Number(await ask('Minimum acceptable base salary (0 for none):', '0', 'base_floor')) || 0;
  const target_min = Number(await ask('Target base, low end (0 to skip):', '0', 'target_min')) || 0;
  const target_max = Number(await ask('Target base, high end (0 to skip):', '0', 'target_max')) || 0;

  // 5. CVs and keywords -----------------------------------------------------------------
  const defaultCvDir = join(REPO_ROOT, 'private', 'cv');
  const cvDir = resolve(await ask(
    'Folder holding your CV files (.docx, .pdf, .txt, .md):', defaultCvDir, 'cv_dir'));
  mkdirSync(cvDir, { recursive: true });

  const python = findPython();
  if (!python) {
    say('\nNote: Python with openpyxl and PyYAML was not found. Scanning works without it;\n' +
                 'Excel reports and CV keyword suggestions need it. See README.\n');
  }
  const suggestions = suggestFromCvs(python, cvDir);
  if (suggestions?.files?.length) {
    say(`\nRead ${suggestions.files.length} CV file(s).\n`);
    if (suggestions.titles.length) say(`Roles found: ${suggestions.titles.join(', ')}\n`);
    if (suggestions.skills.length) say(`Skills found: ${suggestions.skills.slice(0, 12).join(', ')}\n`);
  } else if (python) {
    say('\nNo CV found in that folder — you can add one later and re-run init.\n');
  }
  // A CV that failed to parse is indistinguishable from an empty folder unless we say so.
  for (const [name, why] of Object.entries(suggestions?.unreadable || {})) {
    say(`  could not read ${name}: ${why}\n`);
  }

  // Answers may supply archetypes directly: [{name, keywords: [...], cv}]
  const archetypes = Array.isArray(answers?.archetypes)
    ? answers.archetypes.map((a, i) => ({
        name: String(a.name || '').trim(),
        priority: i === 0 ? 'primary' : 'secondary',
        keywords: Array.isArray(a.keywords) ? a.keywords : list(a.keywords),
        cv: a.cv || '',
      })).filter(a => a.name && a.keywords.length)
    : [];
  const suggestedTitles = suggestions?.titles || [];
  for (let i = 1; !answers && i <= 3; i++) {
    const fallbackName = suggestedTitles[i - 1] || '';
    const name = await ask(`\nTarget role ${i} (blank to stop):`, i === 1 ? fallbackName : '');
    if (!name) break;
    const kwFallback = [name, ...suggestedTitles.filter(t => t !== name).slice(0, 2)].join(', ');
    const keywords = list(await ask('  Title keywords to search for, comma separated:', kwFallback));
    const cv = await ask('  CV file for this role (optional):', suggestions?.files?.[i - 1] || '');
    archetypes.push({ name, priority: i === 1 ? 'primary' : 'secondary', keywords, cv });
  }
  if (!archetypes.length) {
    rl?.close();
    throw new Error('at least one target role is required — the scanners match on its keywords');
  }

  // The shipped exclusions assume an individual-contributor search. Someone targeting a
  // Director of Nursing would have watched the scan drop their best postings as "excluded
  // title keyword", so this is asked rather than assumed.
  const excludeLeadership = yes(await ask(
    '\nExclude director / VP / chief-level titles from results? (y/n)', 'y', 'exclude_leadership'));

  await rl?.close();

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

  const header = `# auto-job-search — candidate profile (generated by \`ajs init\`)\n` +
    `# Personal data lives only here, and this file is gitignored.\n` +
    `# Full documentation of every field: config/profile.example.yml\n\n`;
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, header + yaml.dump(profile, { lineWidth: 100, noRefs: true }), 'utf8');

  // The example config carries its documentation in comments, so copy it and patch the few
  // values onboarding knows, rather than regenerating it and losing the guidance.
  const example = readFileSync(join(configDir, 'scan-config.example.yml'), 'utf8');
  const negatives = excludeLeadership
    ? ['intern', 'internship', 'director', 'vice president', 'chief', 'head of']
    : ['intern', 'internship'];
  const scanConfig = example
    .replace('{{CONTACT_EMAIL}}', email || 'you@example.com')
    .replace(/^(\s*cv_dir:\s*).*$/m, `$1${JSON.stringify(cvDir)}`)
    .replace(/^(\s*extra_negative:\s*).*$/m, `$1[${negatives.map(n => JSON.stringify(n)).join(', ')}]`)
    // The example's lanes describe one person's search; these describe the user's.
    .replace(LANES_BLOCK_RX, `${lanesBlock(archetypes)}\n`);
  writeFileSync(scanPath, scanConfig, 'utf8');

  return { profilePath, scanPath, cvDir, python: Boolean(python), archetypes: archetypes.length,
           keywords: archetypes.flatMap(a => a.keywords).length };
}
