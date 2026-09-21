#!/usr/bin/env node
/**
 * careerkit — command line entry point.
 *
 * Usage:
 *   careerkit sweep [--since N] [--date YYYY-MM-DD] [--chunks N] [--config path]
 *   careerkit config                      show the resolved configuration and exit
 *
 * Every command takes --config; the default is ./config/scan-config.yml. Commands are
 * side-effect free apart from writing into the work and output directories.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, today, REPO_ROOT } from '../src/node/config.mjs';
import { runSweep } from '../src/node/sweep.mjs';
import { runEnrich } from '../src/node/enrich.mjs';
import { runInit, findPython } from '../src/node/init.mjs';

const USAGE = `careerkit <command> [options]

Commands:
  init       set up your profile and configuration (start here)
  daily      sweep + enrich + report, in one go
  sweep      discover postings from the public dataset, filter and rank them
  enrich     fetch each survivor's record from the employer's ATS
  report     build the Excel workbook for a run
  config     print the resolved configuration (paths, windows, thresholds)

Options:
  --config <path>   configuration file (default: config/scan-config.yml)
  --date <date>     run date, YYYY-MM-DD (default: today, from the system clock)
  --since <days>    discovery window in days (default: from config)
  --chunks <n>      read only the first N dataset chunks (for a quick check)
  --limit <n>       enrich at most N postings
  --input <path>    enrich a specific ranked file
  --quiet           only print the summary line
  -h, --help        this text
`;

/**
 * Reporting lives on the Python side (openpyxl). Shelling out keeps one entry point for the
 * user; the exit code and stdout are passed straight through.
 */
function runReport(cfg, args, log) {
  const python = findPython();
  if (!python) {
    log('report needs Python with openpyxl and PyYAML installed — skipping the workbook');
    return 0;
  }
  // --config is a top-level flag on the Python parser, so it goes before the subcommand.
  const argv = [...python.args, '-m', 'careerkit.cli', '--config', cfg.configFile, 'report'];
  if (args.date) argv.push('--date', args.date);
  if (args.kind) argv.push('--kind', args.kind);
  const res = spawnSync(python.cmd, argv, {
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: join(REPO_ROOT, 'src', 'python'), PYTHONIOENCODING: 'utf-8' },
  });
  return res.status ?? 1;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (args.help || !command) {
    process.stdout.write(USAGE);
    return 0;
  }

  const log = args.quiet ? () => {} : msg => process.stderr.write(`${msg}\n`);

  // `init` runs before any configuration exists, so it must not load one.
  if (command === 'init') {
    const result = await runInit({ force: Boolean(args.force) });
    process.stdout.write(
      `\nWrote ${result.profilePath}\n      ${result.scanPath}\n\n` +
      `${result.archetypes} target role(s), ${result.keywords} keywords, CVs in ${result.cvDir}\n` +
      (result.python ? '' : 'Python not detected: Excel reports are unavailable until it is installed.\n') +
      `\nNext: careerkit daily\n`
    );
    return 0;
  }

  const cfg = loadConfig(args.config);

  switch (command) {
    case 'sweep': {
      const result = await runSweep(cfg, {
        date: args.date || today(),
        sinceDays: args.since ? Number(args.since) : undefined,
        limitChunks: args.chunks ? Number(args.chunks) : undefined,
        log,
      });
      const lanes = Object.entries(result.lanes).sort((a, b) => b[1] - a[1])
        .map(([lane, n]) => `${lane} ${n}`).join(' · ');
      process.stdout.write(
        `${result.date} | shortlist ${result.counts.shortlist} | check ${result.counts.check} | ` +
        `dropped ${result.counts.dropped}\n${lanes}\n${result.out}\n`
      );
      return result.counts.shortlist > 0 ? 0 : 0;
    }
    case 'enrich': {
      const result = await runEnrich(cfg, {
        date: args.date || today(),
        input: args.input,
        limit: args.limit ? Number(args.limit) : undefined,
        log,
      });
      const after = Object.entries(result.after).map(([verdict, n]) => `${verdict} ${n}`).join(' | ');
      process.stdout.write(`${result.date} | ${after}\n${result.out}\n`);
      return 0;
    }
    case 'report': {
      return runReport(cfg, args, log);
    }
    case 'daily': {
      const date = args.date || today();
      const swept = await runSweep(cfg, { date, sinceDays: args.since ? Number(args.since) : undefined, log });
      const enriched = await runEnrich(cfg, { date, log });
      const reported = runReport(cfg, { ...args, date }, log);
      const after = Object.entries(enriched.after).map(([v, n]) => `${v} ${n}`).join(' | ');
      process.stdout.write(`\n${date} | ${after}\nswept ${swept.counts.seen.toLocaleString()} postings\n`);
      return reported;
    }
    case 'config': {
      process.stdout.write(JSON.stringify({
        config_file: cfg.configFile,
        paths: cfg.paths,
        windows: cfg.windows,
        scoring: cfg.scoring,
        profile_loaded: Boolean(cfg.profile),
        keywords: (cfg.profile?.targets?.archetypes || []).flatMap(a => a.keywords || []).length,
      }, null, 2) + '\n');
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
