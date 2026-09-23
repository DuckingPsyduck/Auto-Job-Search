#!/usr/bin/env node
/**
 * Privacy check — refuses to let personal data reach a public repository.
 *
 * This project handles one person's job search. The failure mode we care about is a real name,
 * phone number, CV or machine path arriving in a commit and then in a clone. The check runs over
 * git-tracked files only (anything ignored is, by definition, not being published) and exits
 * non-zero on a finding, so CI fails before a push does damage.
 *
 * It looks for patterns, not for a list of names: a denylist of real names would itself leak
 * them. For a one-off check against specific strings, pass a file of them:
 *
 *     node tools/privacy-check.mjs --denylist ~/private/names.txt
 *
 * That file should live outside the repository.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Domains that are safe to appear in examples and documentation. */
const SAFE_EMAIL_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'yourdomain.com',
  'noreply@anthropic.com', 'anthropic.com',
];

/** Extensions that should never be tracked: candidate documents and exports. */
const FORBIDDEN_EXTENSIONS = ['.docx', '.doc', '.xlsx', '.xls', '.pdf', '.csv', '.pptx'];

/** Files whose own text describes the rules, so matches inside them are expected. */
const SELF_REFERENTIAL = ['tools/privacy-check.mjs', '.gitignore', '.github/workflows/ci.yml'];

const CHECKS = [
  {
    id: 'email',
    what: 'email address outside the example domains',
    rx: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g,
    allow: match => SAFE_EMAIL_DOMAINS.some(domain => match.toLowerCase().endsWith(domain)),
  },
  {
    id: 'phone',
    what: 'phone number',
    // (555) 010-0199, 555-010-0199, +1 555 010 0199 — but not version strings or dates
    rx: /(?:\+\d{1,2}\s*)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    allow: match => /555/.test(match),          // 555 numbers are reserved for examples
  },
  {
    id: 'home-path',
    what: 'absolute path from a developer machine',
    rx: /(?:[A-Z]:\\Users\\[^\s"']+|\/(?:home|Users)\/[A-Za-z][^\s"':]*)/g,
    allow: () => false,
  },
  {
    id: 'secret',
    what: 'credential-like string',
    rx: /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{12,}["'])/gi,
    allow: () => false,
  },
];

/** Directories that hold candidate material and must never be tracked. */
const PRIVATE_DIRS = /^(private|output|\.work)\//;

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function loadDenylist(path) {
  if (!path) return [];
  if (!existsSync(path)) throw new Error(`denylist not found: ${path}`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

export function runCheck({ denylistPath = null, root = process.cwd() } = {}) {
  const findings = [];
  const denylist = loadDenylist(denylistPath);
  const files = trackedFiles();

  for (const file of files) {
    // Candidate material lives in directories that must never be tracked; documentation may
    // mention them by name, so this tests the path of tracked files, not their contents.
    if (PRIVATE_DIRS.test(file)) {
      findings.push({ file, line: 0, check: 'private-path', detail: 'candidate data directory is tracked' });
      continue;
    }
    if (FORBIDDEN_EXTENSIONS.includes(extname(file).toLowerCase())) {
      findings.push({ file, line: 0, check: 'document', detail: `${extname(file)} file is tracked` });
      continue;
    }
    if (!existsSync(file) || statSync(file).size > 2_000_000) continue;

    const text = readFileSync(file, 'utf8');
    if (text.includes('\u0000')) continue;                    // binary

    for (const check of CHECKS) {
      if (SELF_REFERENTIAL.includes(file)) continue;
      for (const match of text.matchAll(check.rx)) {
        if (check.allow(match[0])) continue;
        findings.push({ file, line: lineOf(text, match.index), check: check.id, detail: match[0].slice(0, 80) });
      }
    }

    for (const term of denylist) {
      const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (const match of text.matchAll(rx)) {
        findings.push({ file, line: lineOf(text, match.index), check: 'denylist', detail: term });
      }
    }
  }

  return { files: files.length, findings };
}

function main() {
  const args = process.argv.slice(2);
  const denylistPath = args.includes('--denylist') ? args[args.indexOf('--denylist') + 1] : null;
  const { files, findings } = runCheck({ denylistPath });

  if (!findings.length) {
    process.stdout.write(`privacy check: ${files} tracked files, nothing found\n`);
    return 0;
  }

  process.stderr.write(`privacy check FAILED — ${findings.length} finding(s) in ${files} tracked files\n\n`);
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.line}  [${f.check}]  ${f.detail}\n`);
  }
  process.stderr.write(
    '\nNothing here should reach a public repository. Remove the data, or if a match is a false\n' +
    'positive, add the file to SELF_REFERENTIAL or widen the allow rule in tools/privacy-check.mjs.\n'
  );
  return 1;
}

// pathToFileURL handles Windows drive letters and spaces; a hand-built file:// string does not.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
