// Command line interface for the offline mock-feed simulation.
// No network, no wallet, no API key: it only runs the local simulator and prints text.
//
// Two entry policies:
//   strategy (default)  Stage 4: fabricated attributes, entry checks, then a ledger-routed entry
//   launch              Stage 3: enter every token at its first price (kept for compatibility)

import defaultConfig from './config.js';
import {
  SCRIPTED_SCENARIO_NAMES,
  createMockToken,
  listScenarios,
} from './mock-feed.js';
import { runSimulation } from './simulator.js';
import { formatReport, formatSummaryTable, SIMULATION_BANNER } from './report.js';
import {
  ARCHETYPE_NAMES,
  SHOWCASE_TOKENS,
  SHOWCASE_IDS,
  createShowcaseToken,
  createStrategyToken,
  listArchetypes,
} from './mock-attributes.js';
import { PROFILE_NAMES, DEFAULT_PROFILE, resolveStrategyConfig } from './strategy-config.js';
import { runStrategySimulation } from './strategy-simulator.js';
import {
  formatStrategyReport,
  formatStrategySummaryTable,
  formatStrategyTotals,
  STRATEGY_BANNER,
} from './strategy-report.js';

export const ENTRY_POLICIES = Object.freeze(['strategy', 'launch']);

// Flags that switch something on. They take no value, so "--stop-loss=false" must be an error,
// not a silent way of turning the flag ON.
const BOOLEAN_FLAGS = new Set(['--stop-loss', '--portfolio', '--keep-open', '--quiet', '--timeline', '--explain', '--list', '--help']);

export const HELP_TEXT = `Solana Paper Sniper: offline mock-feed simulation (paper trading only)

Usage:
  node src/run-simulation.js [options]
  npm run simulate -- [options]

By default (--entry-policy strategy) each fabricated showcase token is evaluated by the
Balanced entry strategy on its own fresh paper ledger. All data is invented for testing.

Options (both policies):
  --entry-policy <p>  strategy (default) or launch. "launch" is the Stage 3 behavior:
                      enter every token at its first price, no checks
  --seed <integer>    Seed for fabricated data (default 1)
  --stop-loss         Enable the 40% stop-loss. It is OFF unless you pass this flag
  --fee <rate>        Simulated cost per side as a fraction, e.g. 0.01 = 1% (default 0)
  --keep-open         Leave positions open when a feed ends (default: force-close them)
  --quiet             Strategy: show only checks that did not pass. Launch: hide price lines
  --portfolio         Run the tokens together on ONE ledger (launching one tick apart)
  --scenario <name>   One scenario. Strategy mode builds a token from it (see --archetype)
  --list              List what can be run
  --help              Show this help

Strategy-only options:
  --profile <name>    conservative, balanced (default) or aggressive
  --token <id>        Run one showcase token (see --list)
  --archetype <name>  With --scenario: the fabricated attribute profile (default healthy-momentum)
  --timeline          Also print every simulated tick
  --explain           Also print what real on-chain data a future version would need

Everything printed is simulated. No real prices, tokens, wallets or trades are used.`;

function parseNumber(flag, text) {
  if (text === undefined || text.trim() === '') {
    throw new Error(`${flag} needs a value`);
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} must be a number (got "${text}")`);
  }
  return value;
}

/** Parses command line arguments into an options object. Throws Error on bad input. */
export function parseCliArgs(argv) {
  const options = {
    entryPolicy: 'strategy',
    scenario: null,
    portfolio: false,
    seed: 1,
    stopLoss: false,
    fee: null,
    keepOpen: false,
    quiet: false,
    list: false,
    help: false,
    profile: null,
    token: null,
    archetype: null,
    timeline: false,
    explain: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (inline !== null && BOOLEAN_FLAGS.has(arg)) {
      throw new Error(`${arg} does not take a value (got "${inline}"). Leave the flag out to turn it off.`);
    }

    const takeValue = () => {
      if (inline !== null) return inline;
      i += 1;
      return argv[i];
    };
    const takeName = (flag) => {
      const value = takeValue();
      if (value === undefined || value === '') throw new Error(`${flag} needs a name`);
      return value;
    };

    switch (arg) {
      case '--entry-policy': {
        const value = takeName('--entry-policy');
        if (!ENTRY_POLICIES.includes(value)) {
          throw new Error(`--entry-policy must be one of: ${ENTRY_POLICIES.join(', ')}`);
        }
        options.entryPolicy = value;
        break;
      }
      case '--scenario':
        options.scenario = takeName('--scenario');
        break;
      case '--profile': {
        const value = takeName('--profile');
        if (!PROFILE_NAMES.includes(value)) {
          throw new Error(`--profile must be one of: ${PROFILE_NAMES.join(', ')}`);
        }
        options.profile = value;
        break;
      }
      case '--token':
        options.token = takeName('--token');
        break;
      case '--archetype':
        options.archetype = takeName('--archetype');
        break;
      case '--seed': {
        const value = parseNumber('--seed', takeValue());
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error('--seed must be a non-negative integer');
        }
        options.seed = value;
        break;
      }
      case '--fee':
        options.fee = parseNumber('--fee', takeValue());
        break;
      case '--stop-loss':
        options.stopLoss = true;
        break;
      case '--portfolio':
        options.portfolio = true;
        break;
      case '--keep-open':
        options.keepOpen = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--timeline':
        options.timeline = true;
        break;
      case '--explain':
        options.explain = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}. Use --help to see the options.`);
    }
  }

  if (options.scenario !== null && options.portfolio) {
    throw new Error('Use either --scenario or --portfolio, not both');
  }
  if (options.entryPolicy === 'launch') {
    for (const [flag, used] of [
      ['--profile', options.profile !== null],
      ['--token', options.token !== null],
      ['--archetype', options.archetype !== null],
      ['--timeline', options.timeline],
      ['--explain', options.explain],
    ]) {
      if (used) throw new Error(`${flag} only applies with --entry-policy strategy`);
    }
  } else {
    if (options.token !== null && (options.scenario !== null || options.portfolio)) {
      throw new Error('--token cannot be combined with --scenario or --portfolio');
    }
    if (options.archetype !== null && options.scenario === null) {
      throw new Error('--archetype needs --scenario');
    }
  }
  return options;
}

function buildConfig(options) {
  // The 40% stop-loss is only enabled by an explicit --stop-loss flag
  // (or if the project config itself enables it).
  return {
    ...defaultConfig,
    stopLossEnabled: options.stopLoss ? true : defaultConfig.stopLossEnabled,
    tradingFeeRate: options.fee === null ? defaultConfig.tradingFeeRate : options.fee,
  };
}

function runLaunchMode(options, out) {
  const config = buildConfig(options);
  const closeOpenAtEnd = !options.keepOpen;
  const showPrices = !options.quiet;

  const results = [];
  if (options.portfolio) {
    const tokens = SCRIPTED_SCENARIO_NAMES.map((name, index) =>
      createMockToken(name, { seed: options.seed, startTick: index * 2 })
    );
    results.push(runSimulation({ tokens, config, closeOpenAtEnd, label: 'portfolio (all scripted scenarios)' }));
  } else {
    const names = options.scenario === null ? SCRIPTED_SCENARIO_NAMES : [options.scenario];
    for (const name of names) {
      const token = createMockToken(name, { seed: options.seed });
      results.push(runSimulation({ tokens: [token], config, closeOpenAtEnd, label: name }));
    }
  }

  out('Solana Paper Sniper: Stage 3 mock feed simulation (entry policy: launch, no entry checks)');
  out(SIMULATION_BANNER);
  out('No network, wallet, or API key is used. This run is deterministic and always finishes.');
  out('');
  for (const result of results) {
    out(formatReport(result, { showPrices }));
    out('');
  }
  if (results.length > 1) {
    out(formatSummaryTable(results));
    out('');
  }
  out('Done. Everything above was simulated; nothing was bought, sold, signed or sent.');
}

function runStrategyMode(options, out) {
  const config = buildConfig(options);
  const strategy = resolveStrategyConfig(options.profile ?? DEFAULT_PROFILE);
  const closeOpenAtEnd = !options.keepOpen;
  const reportOptions = { timeline: options.timeline, quiet: options.quiet, explain: options.explain };
  const run = (tokens, label) =>
    runStrategySimulation({ tokens, strategy, config, closeOpenAtEnd, label });

  const results = [];
  if (options.scenario !== null) {
    const token = createStrategyToken(options.scenario, {
      archetype: options.archetype ?? 'healthy-momentum',
      seed: options.seed,
    });
    results.push(run([token], token.symbol));
  } else if (options.token !== null) {
    results.push(run([createShowcaseToken(options.token, { seed: options.seed })], `MOCK-${options.token}`.toUpperCase()));
  } else if (options.portfolio) {
    const tokens = SHOWCASE_TOKENS.map((entry, index) =>
      createShowcaseToken(entry.id, { seed: options.seed, startTick: index })
    );
    results.push(run(tokens, 'portfolio (all showcase tokens on one ledger)'));
  } else {
    for (const entry of SHOWCASE_TOKENS) {
      results.push(run([createShowcaseToken(entry.id, { seed: options.seed })], entry.id));
    }
  }

  out(`Solana Paper Sniper: Stage 4 strategy simulation (profile: ${strategy.profile})`);
  for (const line of STRATEGY_BANNER) out(line);
  out('No network, wallet, or API key is used. This run is deterministic and always finishes.');
  out('');
  for (const result of results) {
    out(formatStrategyReport(result, reportOptions));
    out('');
  }
  if (results.length > 1) {
    out(formatStrategySummaryTable(results));
    out('');
    if (!options.portfolio) {
      out(formatStrategyTotals(results));
      out('');
    }
  }
  out('Done. Everything above was simulated; nothing was bought, sold, signed or sent.');
}

function printList(options, out) {
  if (options.entryPolicy === 'launch') {
    out('Available mock scenarios (all prices are simulated):');
    for (const s of listScenarios()) {
      out(`  ${s.name.padEnd(20)} [${s.kind}] ${s.description}`);
    }
    return;
  }
  out('Strategy profiles: ' + PROFILE_NAMES.join(', ') + ` (default ${DEFAULT_PROFILE})`);
  out('');
  out('Showcase tokens (fabricated; use --token <id>):');
  for (const t of SHOWCASE_TOKENS) {
    out(`  ${t.id.padEnd(22)} ${t.scenario} x ${t.archetype}: ${t.description}`);
  }
  out('');
  out('Archetypes (fabricated attribute profiles; use with --scenario):');
  for (const a of listArchetypes()) out(`  ${a.name.padEnd(22)} ${a.description}`);
  out('');
  out('Scenarios (fabricated price paths after the observation phase):');
  for (const s of listScenarios()) out(`  ${s.name.padEnd(22)} [${s.kind}] ${s.description}`);
}

/**
 * Runs the command. Returns the process exit code (0 = success, 1 = error).
 * out and err are injectable so tests can capture the output.
 */
export function runCli(argv, { out = console.log, err = console.error } = {}) {
  try {
    const options = parseCliArgs(argv);

    if (options.help) {
      out(HELP_TEXT);
      return 0;
    }
    if (options.list) {
      printList(options, out);
      return 0;
    }

    if (options.entryPolicy === 'launch') runLaunchMode(options, out);
    else runStrategyMode(options, out);
    return 0;
  } catch (error) {
    err(`Error: ${error.message}`);
    return 1;
  }
}

// Re-exported so tests can confirm every id and archetype name the CLI accepts.
export { SHOWCASE_IDS, ARCHETYPE_NAMES };