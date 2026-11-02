import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import defaultConfig from '../src/config.js';
import { createShowcaseToken, createStrategyToken, SHOWCASE_IDS, ARCHETYPE_NAMES } from '../src/mock-attributes.js';
import { resolveStrategyConfig } from '../src/strategy-config.js';
import { runStrategySimulation } from '../src/strategy-simulator.js';
import {
  formatStrategyReport,
  formatStrategySummaryTable,
  formatStrategyTotals,
  STRATEGY_BANNER,
} from '../src/strategy-report.js';
import { parseCliArgs, runCli } from '../src/cli.js';

function capture(argv) {
  const out = [];
  const err = [];
  const code = runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, text: out.join('\n'), errText: err.join('\n') };
}

const runToken = (id, { profile = 'balanced', config = defaultConfig, closeOpenAtEnd = true } = {}) =>
  runStrategySimulation({
    tokens: [createShowcaseToken(id)],
    strategy: resolveStrategyConfig(profile),
    config,
    closeOpenAtEnd,
    label: id,
  });

describe('strategy report', () => {
  test('shows the fabricated attributes, every check, both decisions, and the trade', () => {
    const report = formatStrategyReport(runToken('promising-runner'));
    for (const line of STRATEGY_BANNER) assert.ok(report.includes(line));
    assert.match(report, /STRATEGY SIMULATION: promising-runner/);
    assert.match(report, /FABRICATED attributes \(not blockchain data\)/);
    assert.match(report, /mint authority REVOKED \| freeze authority REVOKED \| permission flags none/);
    assert.match(report, /top holder [\d.]+% \| top-10 holders [\d.]+% \| liquidity \$[\d,]+ \| quote-side reserve \$[\d,]+/);
    assert.match(report, /simulated sell SUCCEEDED \| age when first seen 0 ticks/);
    for (const id of ['observationWindow', 'tokenAge', 'mintAuthority', 'freezeAuthority', 'suspiciousPermissions', 'holderConcentration', 'minLiquidity', 'priceImpact', 'sellability', 'priceSpike', 'priceCollapse', 'momentum', 'buySellActivity']) {
      assert.ok(report.includes(id), id);
    }
    assert.match(report, /\[MANDATORY-SAFETY\s*\] mintAuthority\s+PASS/);
    assert.match(report, /\[SIGNAL\s*\] momentum\s+PASS/);
    assert.match(report, /Strategy decision: APPROVED/);
    assert.match(report, /Risk manager: ACCEPTED the entry at tick 6/);
    assert.match(report, /Trade #1: entry [\d.]+ at tick 6 \(launch price was [\d.]+\)/);
    assert.match(report, /EXIT TAKE_PROFIT at [\d.]+ at tick \d+ \| realized \+\$1\.00 \(WIN\)/);
    assert.match(report, /Ledger consistency:\s+OK/);
  });

  test('the strategy decision and the risk-manager decision are separate lines', () => {
    const report = formatStrategyReport(runToken('promising-runner'));
    assert.match(report, /^Strategy decision:/m);
    assert.match(report, /^Risk manager:/m);
  });

  test('a rejected token says so and says no position was created', () => {
    const report = formatStrategyReport(runToken('honeypot'));
    assert.match(report, /\[MANDATORY-SAFETY\s*\] sellability\s+FAIL\s+simulated sell FAILED/);
    assert.match(report, /Strategy decision: REJECTED \(sellability\)/);
    assert.match(report, /Risk manager: not asked \(the strategy did not approve an entry\)/);
    assert.doesNotMatch(report, /Trade #/);
    assert.match(report, /Balance \(cash\):\s+\$10\.00/);
  });

  test('unknown critical data is reported as UNKNOWN and BLOCKED, never as a pass', () => {
    const report = formatStrategyReport(runToken('unknown-safety-data'));
    assert.match(report, /mint authority MISSING \| freeze authority MISSING \| permission flags MISSING/);
    assert.match(report, /simulated sell MISSING/);
    assert.match(report, /mintAuthority\s+UNKNOWN/);
    assert.match(report, /Strategy decision: BLOCKED \(mintAuthority, freezeAuthority, suspiciousPermissions, sellability\)/);
  });

  test('a token whose feed ends too soon says it never became eligible', () => {
    const report = formatStrategyReport(runToken('short-history'));
    assert.match(report, /The feed ended at tick 1 before the token became eligible/);
    assert.match(report, /Strategy decision: BLOCKED/);
  });

  test('forced end-of-feed closures are labelled separately from strategy exits', () => {
    const forced = formatStrategyReport(runToken('clean-looking-rug'));
    assert.match(forced, /EXIT FEED_ENDED \(FORCED close because the feed ended, not a strategy exit\)/);
    assert.match(forced, /forced end-of-feed closures: 1/);
    const strategyExit = formatStrategyReport(runToken('promising-runner'));
    assert.doesNotMatch(strategyExit, /FORCED close/);
    assert.match(strategyExit, /forced end-of-feed closures: 0/);
  });

  test('open positions show unrealized PnL, not a realized loss', () => {
    const report = formatStrategyReport(runToken('clean-looking-rug', { closeOpenAtEnd: false }));
    assert.match(report, /STILL OPEN at [\d.]+ \| unrealized -\$[\d.]+ \(not realized, not counted toward the daily loss limit\)/);
    assert.match(report, /Net realized PnL:\s+\$0\.00/);
    assert.match(report, /Unrealized PnL:\s+-\$0\.9\d \(open positions only\)/);
    assert.match(report, /Open positions:\s+1 at end/);
    assert.match(report, /leave positions open/);
  });

  test('risk-manager rejections of approved tokens are reported with the reason', () => {
    const tokens = [0, 1, 2].map((start, i) => createStrategyToken('gradual-decline', { startTick: start, symbol: `MOCK-R-${i}` }));
    const result = runStrategySimulation({ tokens, strategy: resolveStrategyConfig('balanced'), closeOpenAtEnd: false });
    const report = formatStrategyReport(result);
    assert.match(report, /Risk manager: REJECTED the entry at tick 8: MAX_OPEN_POSITIONS .* No position was created and the balance is unchanged\./);
    assert.match(report, /Risk manager:\s+3 approved|1 entries rejected/);
  });

  test('quiet hides passing checks; explain adds what a real version would need; timeline adds ticks', () => {
    const result = runToken('promising-runner');
    const quiet = formatStrategyReport(result, { quiet: true });
    assert.match(quiet, /13 passing checks hidden/);
    assert.doesNotMatch(quiet, /\] mintAuthority/);

    const explain = formatStrategyReport(result, { explain: true });
    assert.match(explain, /real version would need: Read the mint authority field of the real token mint account on-chain\./);

    assert.doesNotMatch(formatStrategyReport(result), /Timeline \(every price below is simulated\)/);
    const timeline = formatStrategyReport(result, { timeline: true });
    assert.match(timeline, /Timeline \(every price below is simulated\)/);
    assert.match(timeline, /DECISION APPROVED/);
    assert.match(timeline, /ENTRY paper trade #1/);
  });

  test('summary table and totals', () => {
    const results = ['promising-runner', 'honeypot', 'clean-looking-rug'].map((id) => runToken(id));
    const table = formatStrategySummaryTable(results);
    assert.match(table, /promising-runner\s+APPROVED\s+ACCEPTED\s+TAKE_PROFIT\s+\+\$1\.00/);
    assert.match(table, /honeypot\s+REJECTED \(sellability\)/);
    assert.match(table, /clean-looking-rug\s+APPROVED\s+ACCEPTED\s+FEED_ENDED/);
    const totals = formatStrategyTotals(results);
    assert.match(totals, /3 independent runs \(separate ledgers/);
    assert.match(totals, /2 approved \| 1 rejected by filters/);
    assert.match(totals, /2 entries accepted/);
    assert.match(totals, /Closed positions: 2 \(1 won, 1 lost, 0 break-even\) \| forced end-of-feed closures: 1/);
  });
});

describe('parseCliArgs (strategy options)', () => {
  test('reads the new options', () => {
    const o = parseCliArgs(['--profile', 'aggressive', '--token=honeypot', '--timeline', '--explain']);
    assert.equal(o.entryPolicy, 'strategy');
    assert.equal(o.profile, 'aggressive');
    assert.equal(o.token, 'honeypot');
    assert.equal(o.timeline, true);
    assert.equal(o.explain, true);
    const s = parseCliArgs(['--scenario', 'rug-pull', '--archetype', 'pumped']);
    assert.equal(s.archetype, 'pumped');
    assert.equal(parseCliArgs(['--entry-policy', 'launch']).entryPolicy, 'launch');
  });

  test('rejects bad or conflicting input', () => {
    assert.throws(() => parseCliArgs(['--entry-policy', 'yolo']), /--entry-policy must be one of/);
    assert.throws(() => parseCliArgs(['--entry-policy']), /needs a name/);
    assert.throws(() => parseCliArgs(['--profile', 'reckless']), /--profile must be one of/);
    assert.throws(() => parseCliArgs(['--token', 'x', '--scenario', 'rug-pull']), /--token cannot be combined/);
    assert.throws(() => parseCliArgs(['--token', 'x', '--portfolio']), /--token cannot be combined/);
    assert.throws(() => parseCliArgs(['--archetype', 'pumped']), /--archetype needs --scenario/);
    for (const flag of [['--profile', 'balanced'], ['--token', 'honeypot'], ['--archetype', 'pumped'], ['--timeline'], ['--explain']]) {
      assert.throws(() => parseCliArgs(['--entry-policy', 'launch', ...flag]), /only applies with --entry-policy strategy/, flag[0]);
    }
  });
});

describe('runCli: strategy mode (the default)', () => {
  test('the default run evaluates every showcase token and finishes with exit code 0', () => {
    const { code, text, errText } = capture([]);
    assert.equal(code, 0);
    assert.equal(errText, '');
    assert.match(text, /Stage 4 strategy simulation \(profile: balanced\)/);
    for (const line of STRATEGY_BANNER) assert.ok(text.includes(line));
    for (const id of SHOWCASE_IDS) assert.ok(text.includes(`STRATEGY SIMULATION: ${id}`), id);
    assert.match(text, /Summary of simulated runs/);
    assert.match(text, /Totals across 15 independent runs/);
    assert.match(text, /nothing was bought, sold, signed or sent/);
  });

  test('default results: 3 entries, 8 rejected, 2 blocked, 2 no-signal (Balanced, stop-loss off)', () => {
    const { text } = capture([]);
    assert.match(text, /Strategy: 3 approved \| 8 rejected by filters \| 2 blocked \(unknown data\) \| 2 no signal/);
    assert.match(text, /Risk manager: 3 entries accepted \| 0 entries rejected/);
    assert.match(text, /Closed positions: 3 \(1 won, 2 lost, 0 break-even\) \| forced end-of-feed closures: 2/);
  });

  test('profiles change the decisions', () => {
    for (const profile of ['conservative', 'balanced', 'aggressive']) {
      const { code, text } = capture(['--profile', profile, '--quiet']);
      assert.equal(code, 0);
      assert.match(text, new RegExp(`profile: ${profile}`));
    }
    assert.match(capture(['--profile', 'aggressive']).text, /Strategy: 4 approved/); // quiet-trading gets in on momentum alone
    assert.match(capture(['--profile', 'conservative']).text, /Strategy: 3 approved/);
  });

  test('a single showcase token: the clean-looking rug is approved and force-closed at a loss', () => {
    const { code, text } = capture(['--token', 'clean-looking-rug']);
    assert.equal(code, 0);
    assert.match(text, /Strategy decision: APPROVED/);
    assert.match(text, /FEED_ENDED \(FORCED close/);
    assert.match(text, /\(LOSS\)/);
  });

  test('--stop-loss is off unless passed, and only then do STOP_LOSS exits appear', () => {
    const off = capture(['--token', 'clean-looking-rug']);
    assert.match(off.text, /stop-loss OFF/);
    assert.doesNotMatch(off.text, /EXIT STOP_LOSS/);
    const on = capture(['--token', 'clean-looking-rug', '--stop-loss']);
    assert.match(on.text, /stop-loss ON \(40% loss\)/);
    assert.match(on.text, /EXIT STOP_LOSS at/);
  });

  test('--keep-open leaves the position open and shows unrealized PnL', () => {
    const { text } = capture(['--token', 'clean-looking-rug', '--keep-open']);
    assert.match(text, /STILL OPEN/);
    assert.match(text, /Net realized PnL:\s+\$0\.00/);
    assert.doesNotMatch(text, /FEED_ENDED/);
  });

  test('--scenario with --archetype builds a custom fabricated token', () => {
    const win = capture(['--scenario', 'take-profit-run']);
    assert.equal(win.code, 0);
    assert.match(win.text, /archetype healthy-momentum/);
    assert.match(win.text, /Strategy decision: APPROVED/);

    const bad = capture(['--scenario', 'take-profit-run', '--archetype', 'unsafe-honeypot', '--profile', 'aggressive']);
    assert.match(bad.text, /Strategy decision: REJECTED \(sellability\)/);
  });

  test('--portfolio runs one shared ledger where the risk manager turns away an approved token', () => {
    const { code, text } = capture(['--portfolio', '--quiet']);
    assert.equal(code, 0);
    assert.match(text, /STRATEGY SIMULATION: portfolio/);
    assert.match(text, /Risk manager: REJECTED the entry at tick 8: MAX_OPEN_POSITIONS/);
    assert.match(text, /Strategy decisions:\s+3 approved/);
    assert.match(text, /Risk manager:\s+2 entries accepted \| 1 entries rejected/);
    assert.match(text, /Peak open positions|Open positions:\s+0 at end \| peak 2 \(max allowed 2\)/);
    assert.doesNotMatch(text, /Totals across/, 'one ledger: no per-run totals');
  });

  test('--list shows profiles, showcase tokens, archetypes and scenarios', () => {
    const { code, text } = capture(['--list']);
    assert.equal(code, 0);
    for (const id of SHOWCASE_IDS) assert.ok(text.includes(id), id);
    for (const name of ARCHETYPE_NAMES) assert.ok(text.includes(name), name);
    assert.match(text, /conservative, balanced, aggressive/);
    assert.match(text, /random-walk/);
  });

  test('--help documents both policies and says paper trading only', () => {
    const { text } = capture(['--help']);
    assert.match(text, /paper trading only/);
    assert.match(text, /--entry-policy/);
    assert.match(text, /--profile/);
    assert.match(text, /invented for testing/);
  });

  test('the same arguments always print exactly the same output', () => {
    for (const argv of [[], ['--portfolio'], ['--profile', 'aggressive', '--stop-loss'], ['--scenario', 'random-walk', '--seed', '42', '--archetype', 'quiet-token']]) {
      assert.equal(capture(argv).text, capture(argv).text, argv.join(' '));
    }
  });

  test('a different seed prints different fabricated data', () => {
    assert.notEqual(capture(['--seed', '1']).text, capture(['--seed', '2']).text);
  });

  test('errors go to the error stream with exit code 1', () => {
    for (const argv of [['--token', 'real-token'], ['--scenario', 'moon-shot'], ['--scenario', 'rug-pull', '--archetype', 'legit'], ['--bogus'], ['--fee', '1.5']]) {
      const { code, errText, text } = capture(argv);
      assert.equal(code, 1, argv.join(' '));
      assert.match(errText, /^Error: /, argv.join(' '));
      assert.equal(text, '');
    }
  });
});

describe('Stage 3 compatibility through the CLI', () => {
  test('--entry-policy launch reproduces the Stage 3 portfolio result exactly', () => {
    const { code, text } = capture(['--entry-policy', 'launch', '--portfolio', '--quiet']);
    assert.equal(code, 0);
    assert.match(text, /Stage 3 mock feed simulation \(entry policy: launch, no entry checks\)/);
    assert.match(text, /Balance \(cash\):\s+\$11\.50/);
    assert.match(text, /ENTRY REJECTED \(MAX_OPEN_POSITIONS\)/);
    assert.doesNotMatch(text, /STRATEGY SIMULATION|FABRICATED/);
  });

  test('--entry-policy launch keeps the Stage 3 forced-close label (MANUAL) so old results are unchanged', () => {
    const { text } = capture(['--entry-policy', 'launch', '--scenario', 'gradual-decline', '--quiet']);
    assert.match(text, /MANUAL \(feed ended, manual close\)/);
    assert.doesNotMatch(text, /FEED_ENDED/);
  });
});

describe('the real command', () => {
  const entry = fileURLToPath(new URL('../src/run-simulation.js', import.meta.url));
  const spawn = (...args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30000 });

  test('node src/run-simulation.js runs offline, finishes, and exits 0 (strategy default)', () => {
    const run = spawn('--token', 'promising-runner', '--quiet');
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /FABRICATED MOCK DATA ONLY/);
    assert.match(run.stdout, /EXIT TAKE_PROFIT/);
    assert.match(run.stdout, /Balance \(cash\):\s+\$11\.00/);
  });

  test('the full default run also finishes with exit code 0', () => {
    const run = spawn('--quiet');
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /Totals across 15 independent runs/);
  });

  test('a bad option exits non-zero with the message on stderr', () => {
    const run = spawn('--token', 'real-token');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Unknown showcase token/);
  });
});

describe('Stage 4 source safety scan', () => {
  const files = [
    'mock-attributes.js', 'strategy-config.js', 'entry-checks.js',
    'strategy-simulator.js', 'strategy-report.js', 'cli.js', 'run-simulation.js',
  ];
  const sources = files.map((name) => [name, readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')]);

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
    [/\brequire\s*\(|import\s*\(/, 'uses a dynamic import'],
  ];

  for (const [name, source] of sources) {
    test(`${name} stays offline, deterministic, wallet-free and ledger-only`, () => {
      for (const [pattern, why] of forbidden) {
        assert.doesNotMatch(source, pattern, `${name} ${why}`);
      }
    });
  }

  test('the strategy simulator opens positions only through the ledger entry flow', () => {
    const source = sources.find(([name]) => name === 'strategy-simulator.js')[1];
    assert.match(source, /ledger\.canOpenTrade\(/);
    assert.match(source, /ledger\.openTrade\(/);
    assert.ok(source.indexOf('ledger.canOpenTrade(') < source.indexOf('ledger.openTrade('), 'the risk check comes first');
  });

  test('no source file anywhere in src/ imports a network, process or filesystem module', () => {
    for (const name of readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /from '(?!\.)/, `${name} imports only local modules (no node: or package imports)`);
    }
  });
});