import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import defaultConfig from '../src/config.js';
import { createMockToken } from '../src/mock-feed.js';
import { runSimulation } from '../src/simulator.js';
import { formatReport, formatSummaryTable, SIMULATION_BANNER } from '../src/report.js';
import { parseCliArgs, runCli } from '../src/cli.js';

function capture(argv) {
  const out = [];
  const err = [];
  const code = runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, text: out.join('\n'), errText: err.join('\n') };
}

// Stage 3 behavior is reached explicitly: the CLI default is now the Stage 4 strategy.
const launch = (...args) => ['--entry-policy', 'launch', ...args];

describe('report formatting', () => {
  const result = runSimulation({
    tokens: [createMockToken('gradual-decline')],
    closeOpenAtEnd: false,
    label: 'gradual-decline',
  });

  test('labels everything as simulated and shows the key figures', () => {
    const report = formatReport(result);
    assert.ok(report.includes(SIMULATION_BANNER));
    assert.match(report, /SIMULATION: gradual-decline/);
    assert.match(report, /MOCK-GRADUAL-DECLINE/);
    assert.match(report, /ENTRY paper trade #1/);
    assert.match(report, /STILL OPEN/);
    assert.match(report, /Unrealized PnL, open positions:\s+-\$0\.50/);
    assert.match(report, /Balance \(cash\):\s+\$9\.00/);
    assert.match(report, /Open positions at end:\s+1/);
    assert.match(report, /stop-loss OFF/);
    assert.match(report, /Ledger consistency check:\s+OK/);
  });

  test('price lines can be hidden', () => {
    assert.match(formatReport(result, { showPrices: true }), /\| price 0\.00050000/);
    assert.doesNotMatch(formatReport(result, { showPrices: false }), /\| price 0\.0005/);
  });

  test('summary table has one row per run', () => {
    const second = runSimulation({
      tokens: [createMockToken('take-profit-run')],
      config: defaultConfig,
      label: 'take-profit-run',
    });
    const table = formatSummaryTable([result, second]);
    assert.match(table, /gradual-decline\s+1 still open/);
    assert.match(table, /take-profit-run\s+TAKE_PROFIT\s+\+\$1\.00/);
  });
});

describe('parseCliArgs', () => {
  test('defaults: no stop-loss, seed 1, no extra options', () => {
    assert.deepEqual(parseCliArgs([]), {
      entryPolicy: 'strategy',
      profile: null,
      token: null,
      archetype: null,
      timeline: false,
      explain: false,
      scenario: null,
      portfolio: false,
      seed: 1,
      stopLoss: false,
      fee: null,
      keepOpen: false,
      quiet: false,
      list: false,
      help: false,
    });
  });

  test('reads flags with separate or inline values', () => {
    const options = parseCliArgs(['--scenario', 'rug-pull', '--seed=7', '--fee', '0.01', '--stop-loss', '--keep-open', '--quiet']);
    assert.equal(options.scenario, 'rug-pull');
    assert.equal(options.seed, 7);
    assert.equal(options.fee, 0.01);
    assert.equal(options.stopLoss, true);
    assert.equal(options.keepOpen, true);
    assert.equal(options.quiet, true);
  });

  test('rejects bad input', () => {
    assert.throws(() => parseCliArgs(['--bogus']), /Unknown option/);
    assert.throws(() => parseCliArgs(['--scenario']), /needs a name/);
    assert.throws(() => parseCliArgs(['--seed', 'abc']), /--seed/);
    assert.throws(() => parseCliArgs(['--seed', '-1']), /non-negative integer/);
    assert.throws(() => parseCliArgs(['--seed', '1.5']), /non-negative integer/);
    assert.throws(() => parseCliArgs(['--fee']), /needs a value/);
    assert.throws(() => parseCliArgs(['--fee', '']), /needs a value/);
    assert.throws(() => parseCliArgs(['--scenario', 'rug-pull', '--portfolio']), /not both/);
  });
});

describe('runCli', () => {
  test('default run covers all five scripted scenarios and finishes with exit code 0', () => {
    const { code, text, errText } = capture(launch());
    assert.equal(code, 0);
    assert.equal(errText, '');
    for (const name of ['take-profit-run', 'gradual-decline', 'rug-pull', 'sideways-then-pump', 'sideways-then-dump']) {
      assert.ok(text.includes(`SIMULATION: ${name}`), name);
    }
    assert.match(text, /Summary of simulated runs/);
    assert.match(text, /nothing was bought, sold, signed or sent/);
  });

  test('stop-loss is off unless --stop-loss is passed', () => {
    const off = capture(launch('--scenario', 'gradual-decline'));
    assert.equal(off.code, 0);
    assert.doesNotMatch(off.text, /STOP_LOSS/);
    assert.match(off.text, /stop-loss OFF/);

    const on = capture(launch('--scenario', 'gradual-decline', '--stop-loss'));
    assert.equal(on.code, 0);
    assert.match(on.text, /EXIT paper trade #1: STOP_LOSS/);
    assert.match(on.text, /stop-loss ON/);
  });

  test('--keep-open leaves the position open and shows unrealized PnL', () => {
    const { text } = capture(launch('--scenario', 'rug-pull', '--keep-open', '--quiet'));
    assert.match(text, /STILL OPEN/);
    assert.match(text, /Unrealized PnL, open positions:\s+-\$0\.99/);
  });

  test('--portfolio runs one shared ledger and shows risk rejections', () => {
    const { code, text } = capture(launch('--portfolio', '--quiet'));
    assert.equal(code, 0);
    assert.match(text, /ENTRY REJECTED \(MAX_OPEN_POSITIONS\)/);
    assert.match(text, /Peak open positions:\s+2 \(max allowed 2\)/);
    assert.match(text, /Balance \(cash\):\s+\$11\.50/);
  });

  test('--list and --help print and exit 0', () => {
    const list = capture(launch('--list'));
    assert.equal(list.code, 0);
    assert.match(list.text, /random-walk/);
    assert.match(capture(['--help']).text, /paper trading only/);
  });

  test('the same arguments always print exactly the same output', () => {
    for (const argv of [launch(), launch('--portfolio'), launch('--scenario', 'random-walk', '--seed', '42', '--stop-loss')]) {
      assert.equal(capture(argv).text, capture(argv).text);
    }
  });

  test('different random-walk seeds print different output', () => {
    const a = capture(launch('--scenario', 'random-walk', '--seed', '1')).text;
    const b = capture(launch('--scenario', 'random-walk', '--seed', '2')).text;
    assert.notEqual(a, b);
  });

  test('errors go to the error stream and return exit code 1', () => {
    const unknownScenario = capture(launch('--scenario', 'moon-shot'));
    assert.equal(unknownScenario.code, 1);
    assert.match(unknownScenario.errText, /Unknown scenario/);

    assert.equal(capture(launch('--bogus')).code, 1);

    const badFee = capture(launch('--fee', '1.5'));
    assert.equal(badFee.code, 1);
    assert.match(badFee.errText, /tradingFeeRate/);
  });
});

describe('the real command', () => {
  test('node src/run-simulation.js runs offline, finishes, and exits 0', () => {
    const entry = fileURLToPath(new URL('../src/run-simulation.js', import.meta.url));
    const run = spawnSync(process.execPath, [entry, '--entry-policy', 'launch', '--scenario', 'sideways-then-pump', '--quiet'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /SIMULATED PRICES AND PAPER TRADES ONLY/);
    assert.match(run.stdout, /TAKE_PROFIT/);
    assert.match(run.stdout, /Balance \(cash\):\s+\$11\.00/);
  });
});

describe('Stage 3 source safety scan', () => {
  const files = ['mock-feed.js', 'simulator.js', 'report.js', 'cli.js', 'run-simulation.js'];
  const sources = files.map((name) => [
    name,
    readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
  ]);

  const forbidden = [
    [/\.openPosition\s*\(/, 'calls the risk manager open method directly'],
    [/\.closePosition\s*\(/, 'calls the risk manager close method directly'],
    [/\bfetch\s*\(/, 'uses fetch'],
    [/node:(http|https|http2|net|dgram|tls|dns|child_process|worker_threads)/, 'imports a network or process module'],
    [/\bWebSocket\b|\bXMLHttpRequest\b/, 'uses a network API'],
    [/Math\.random/, 'uses non-seeded randomness'],
    [/Date\.now|new Date\(/, 'uses the wall clock'],
    [/process\.env/, 'reads environment variables (API keys)'],
    [/privateKey|secretKey|mnemonic|seed phrase|@solana|web3/i, 'mentions wallet or key material'],
  ];

  for (const [name, source] of sources) {
    test(`${name} stays offline, deterministic, wallet-free and ledger-only`, () => {
      for (const [pattern, why] of forbidden) {
        assert.doesNotMatch(source, pattern, `${name} ${why}`);
      }
    });
  }
});