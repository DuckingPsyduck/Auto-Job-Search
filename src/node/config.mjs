/**
 * Configuration loader.
 *
 * Reads `scan-config.yml` plus the candidate `profile.yml` it points at, resolves every path
 * against the repo root, validates the handful of fields the pipeline cannot run without, and
 * returns one frozen object. Nothing else in the kit reads a config file directly.
 *
 * Resolution order for the root: AJS_ROOT env var, then `paths.root` in the config file,
 * then the directory containing the config file.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/** Fields without which a run cannot produce meaningful output. */
const REQUIRED = [
  'version',
  'paths.work_dir',
  'paths.output_dir',
  'http.user_agent',
  'windows.tracked_scan_days',
  'location.ranks',
  'scoring.min_jd_chars',
];

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function readYaml(file) {
  try {
    return yaml.load(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read YAML at ${file}: ${err.message}`);
  }
}

/**
 * @param {string} [configPath] path to scan-config.yml; defaults to <root>/config/scan-config.yml
 * @returns {object} frozen config with `.profile`, absolute `.paths.*` and helpers
 */
export function loadConfig(configPath) {
  const file = resolve(configPath || process.env.AJS_CONFIG || join(REPO_ROOT, 'config', 'scan-config.yml'));
  if (!existsSync(file)) {
    throw new Error(`config not found: ${file}\nCopy config/scan-config.example.yml and edit it.`);
  }
  const cfg = readYaml(file);

  const root = resolve(process.env.AJS_ROOT || cfg?.paths?.root || dirname(dirname(file)));
  const abs = p => (p == null ? p : isAbsolute(p) ? p : resolve(root, p));

  for (const key of REQUIRED) {
    if (get(cfg, key) === undefined) throw new Error(`config ${file} is missing required key: ${key}`);
  }

  cfg.paths = { ...cfg.paths, root };
  for (const key of ['work_dir', 'output_dir', 'profile', 'portals', 'geo_terms', 'ats_vocab', 'cv_dir', 'tracker']) {
    if (cfg.paths[key]) cfg.paths[key] = abs(cfg.paths[key]);
  }

  // The profile is optional for source-only runs (e.g. a sweep with no ranking), so a missing
  // file is not fatal — but ranking and scoring will refuse to run without it.
  cfg.profile = cfg.paths.profile && existsSync(cfg.paths.profile) ? readYaml(cfg.paths.profile) : null;
  if (cfg.profile) assertProfileFilled(cfg.profile, cfg.paths.profile);

  mkdirSync(cfg.paths.work_dir, { recursive: true });
  mkdirSync(cfg.paths.output_dir, { recursive: true });

  cfg.configFile = file;
  return Object.freeze(cfg);
}

/** Placeholders left in profile.yml are a setup mistake, not a runtime surprise. */
function assertProfileFilled(profile, file) {
  const leftovers = [];
  (function walk(node, path) {
    if (typeof node === 'string') {
      if (/\{\{.+?\}\}/.test(node)) leftovers.push(`${path}: ${node}`);
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  })(profile, '');
  if (leftovers.length) {
    throw new Error(
      `profile still has placeholders (${file}):\n  ${leftovers.slice(0, 8).join('\n  ')}` +
      (leftovers.length > 8 ? `\n  ...and ${leftovers.length - 8} more` : '')
    );
  }
}

/** Today's date from the system clock, as YYYY-MM-DD in local time. */
export function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Absolute path for a configured output, with {date} filled in. */
export function outputPath(cfg, kind, date = today()) {
  const name = cfg.paths.outputs?.[kind];
  if (!name) throw new Error(`no output configured for "${kind}"`);
  return join(cfg.paths.output_dir, name.replace('{date}', date));
}

/** Absolute path inside the work directory (scan JSON, fetched descriptions, checkpoints). */
export function workPath(cfg, ...parts) {
  return join(cfg.paths.work_dir, ...parts);
}
