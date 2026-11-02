import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import defaultConfig from '../src/config.js';
import {
  createMockToken,
  SCRIPTED_SCENARIO_NAMES,
  DEFAULT_BASE_PRICE,
} from '../src/mock-feed.js';
import { runSimulation, EVENT_TYPE } from '../src/simulator.js';

const BASE = DEFAULT_BASE_PRICE;
const withStop = { ...defaultConfig, stopLossEnabled: true };

const near = (actual, expected, label = '') =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label} expected ${actual} to be about ${expected}`
  );
const tok = (scenario, startTick = 0, symbol) =>
  createMockToken(scenario, { startTick, ...(symbol ? { symbol } : {}) });
const ofType = (result, type) => result.events.filter((e) => e.type === type);
const exitsOf = (result) => ofType(result, EVENT_TYPE.EXIT);
const rejectionsOf = (result) => ofType(result, EVENT_TYPE.ENTRY_REJECTED);

function assertAccounting(result) {
  const s = result.summary;
  assert.deepEqual(result.consistency, { ok: true, errors: [] });
  near(
    s.balanceUsd,
    result.config.startingBalanceUsd + s.totalRealizedPnlUsd - s.openCostBasisUsd,
    'cash identity'
  );
  assert.equal(s.openTrades, result.openPositions.length);
  assert.ok(result.peakOpenPositions <= result.config.maxOpenPositions);
}

const portfolioTokens = () =>
  SCRIPTED_SCENARIO_NAMES.map((name, index) => tok(name, index * 2));

describe('scripted scenarios through the ledger', () => {
  test('take-profit-run: closes at exactly 2x and never again afterwards', () => {
    const result = runSimulation({ tokens: [tok('take-profit-run')] });
    const exits = exitsOf(result);

    assert.equal(exits.length, 1);
    assert.equal(exits[0].reason, 'TAKE_PROFIT');
    assert.equal(exits[0].tick, 6);
    assert.equal(exits[0].exitPrice, BASE * 2);
    assert.equal(exits[0].endOfFeed, false);
    near(exits[0].realizedPnlUsd, 1);

    const lastPrice = ofType(result, EVENT_TYPE.PRICE).at(-1);
    assert.equal(lastPrice.tick, 7);
    assert.equal(lastPrice.position, 'CLOSED'); // price moved on, ledger untouched
    near(result.summary.balanceUsd, 11);
    assertAccounting(result);
  });

  test('sideways-then-pump: survives the sideways phase, then takes profit', () => {
    const result = runSimulation({ tokens: [tok('sideways-then-pump')] });
    const exits = exitsOf(result);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].reason, 'TAKE_PROFIT');
    assert.equal(exits[0].tick, 9);
    assert.equal(exits[0].exitPrice, BASE * 2); // fills at the target, not the 2.1x price
    near(result.summary.dailyPnlUsd, 1);
    assertAccounting(result);
  });

  test('sideways-then-pump with stop-loss enabled is not stopped out', () => {
    const result = runSimulation({ tokens: [tok('sideways-then-pump')], config: withStop });
    assert.deepEqual(exitsOf(result).map((e) => e.reason), ['TAKE_PROFIT']);
  });

  test('every scenario starts with one accepted entry at the launch price', () => {
    for (const name of SCRIPTED_SCENARIO_NAMES) {
      const result = runSimulation({ tokens: [tok(name)] });
      const entries = ofType(result, EVENT_TYPE.ENTRY);
      assert.equal(entries.length, 1, name);
      assert.equal(entries[0].price, BASE, name);
      assert.equal(entries[0].sizeUsd, 1, name);
      assert.equal(result.rejectedEntries, 0, name);
    }
  });
});

describe('stop-loss disabled (default config)', () => {
  test('gradual-decline: a 40% fall does not close the position', () => {
    const result = runSimulation({ tokens: [tok('gradual-decline')], closeOpenAtEnd: false });

    assert.equal(exitsOf(result).length, 0);
    const at60 = ofType(result, EVENT_TYPE.PRICE).find((e) => e.tick === 8); // 0.60x entry
    assert.equal(at60.position, 'OPEN');

    assert.equal(result.openTradesAtEnd, 1);
    near(result.openPositions[0].unrealizedPnlUsd, -0.5);
    near(result.summary.unrealizedPnlUsd, -0.5);
    assert.equal(result.summary.totalRealizedPnlUsd, 0);
    assert.equal(result.summary.dailyPnlUsd, 0);
    near(result.summary.balanceUsd, 9);
    assertAccounting(result);
  });

  test('gradual-decline: the end-of-feed close is a MANUAL close, not a stop-loss', () => {
    const result = runSimulation({ tokens: [tok('gradual-decline')] });
    const exits = exitsOf(result);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].reason, 'MANUAL');
    assert.equal(exits[0].endOfFeed, true);
    assert.equal(exits[0].outcome, 'LOSS');
    near(exits[0].realizedPnlUsd, -0.5);
    near(result.summary.dailyPnlUsd, -0.5);
    near(result.summary.balanceUsd, 9.5);
    assert.equal(result.openTradesAtEnd, 0);
  });

  test('rug-pull: the collapse is unrealized while the position stays open', () => {
    const result = runSimulation({ tokens: [tok('rug-pull')], closeOpenAtEnd: false });
    assert.equal(exitsOf(result).length, 0);
    near(result.summary.unrealizedPnlUsd, -0.99);
    assert.equal(result.summary.dailyPnlUsd, 0);
    assert.equal(result.summary.losses, 0);
    assertAccounting(result);
  });

  test('sideways-then-dump: stays open through the dump', () => {
    const result = runSimulation({ tokens: [tok('sideways-then-dump')], closeOpenAtEnd: false });
    assert.equal(exitsOf(result).length, 0);
    near(result.summary.unrealizedPnlUsd, -0.7);
  });

  test('no scenario or seed ever produces a STOP_LOSS exit', () => {
    const tokens = [
      ...SCRIPTED_SCENARIO_NAMES.map((name) => tok(name)),
      ...[1, 2, 3, 4, 5].map((seed) => createMockToken('random-walk', { seed })),
    ];
    for (const token of tokens) {
      const result = runSimulation({ tokens: [token] });
      assert.ok(
        exitsOf(result).every((e) => e.reason !== 'STOP_LOSS'),
        token.symbol
      );
      assert.equal(ofType(result, EVENT_TYPE.ENTRY)[0].stopLossPrice, null, token.symbol);
    }
  });
});

describe('stop-loss explicitly enabled', () => {
  test('gradual-decline: stops out at 60% of entry for a $0.40 loss', () => {
    const result = runSimulation({ tokens: [tok('gradual-decline')], config: withStop });
    const exits = exitsOf(result);

    assert.equal(exits.length, 1);
    assert.equal(exits[0].reason, 'STOP_LOSS');
    assert.equal(exits[0].tick, 8);
    assert.equal(exits[0].exitPrice, BASE * 0.6);
    assert.equal(exits[0].endOfFeed, false);
    near(exits[0].realizedPnlUsd, -0.4);

    const later = ofType(result, EVENT_TYPE.PRICE).filter((e) => e.tick > 8);
    assert.ok(later.length > 0 && later.every((e) => e.position === 'CLOSED'));
    near(result.summary.balanceUsd, 9.6);
    near(result.summary.dailyPnlUsd, -0.4);
    assertAccounting(result);
  });

  test('rug-pull: stops out at the first price below the trigger (gap fill)', () => {
    const result = runSimulation({ tokens: [tok('rug-pull')], config: withStop });
    const [exit] = exitsOf(result);
    assert.equal(exit.reason, 'STOP_LOSS');
    assert.equal(exit.tick, 3);
    assert.equal(exit.exitPrice, BASE * 0.02);
    near(exit.realizedPnlUsd, -0.98);
    assertAccounting(result);
  });

  test('sideways-then-dump: not stopped during sideways, stopped on the dump', () => {
    const result = runSimulation({ tokens: [tok('sideways-then-dump')], config: withStop });
    const [exit] = exitsOf(result);
    assert.equal(exit.reason, 'STOP_LOSS');
    assert.equal(exit.tick, 8);
    near(exit.realizedPnlUsd, -0.4);
    assert.ok(result.events.filter((e) => e.tick < 8).every((e) => e.type !== EVENT_TYPE.EXIT));
  });

  test('the entry event shows the stop-loss price (60% of entry)', () => {
    const result = runSimulation({ tokens: [tok('gradual-decline')], config: withStop });
    assert.equal(ofType(result, EVENT_TYPE.ENTRY)[0].stopLossPrice, BASE * 0.6);
  });
});

describe('maximum two open positions', () => {
  test('a third simultaneous entry is rejected by the risk manager', () => {
    const tokens = [
      tok('gradual-decline', 0, 'MOCK-A'),
      tok('gradual-decline', 0, 'MOCK-B'),
      tok('gradual-decline', 0, 'MOCK-C'),
    ];
    const result = runSimulation({ tokens, closeOpenAtEnd: false });

    assert.equal(ofType(result, EVENT_TYPE.ENTRY).length, 2);
    const rejections = rejectionsOf(result);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].symbol, 'MOCK-C');
    assert.equal(rejections[0].reason, 'MAX_OPEN_POSITIONS');
    assert.equal(result.trades.length, 2);
    assert.equal(result.peakOpenPositions, 2);
    assert.equal(result.summary.openTrades, 2);
    assertAccounting(result);
  });

  test('a rejected token is never traded later, even after a slot frees up', () => {
    const tokens = [
      tok('take-profit-run', 0, 'MOCK-A'),
      tok('gradual-decline', 0, 'MOCK-B'),
      tok('sideways-then-pump', 3, 'MOCK-C'), // launches while both slots are taken
    ];
    const result = runSimulation({ tokens });

    assert.equal(rejectionsOf(result).length, 1);
    assert.equal(rejectionsOf(result)[0].symbol, 'MOCK-C');
    // Slot frees at tick 6 when MOCK-A takes profit, but MOCK-C already missed its entry.
    assert.equal(ofType(result, EVENT_TYPE.ENTRY).filter((e) => e.symbol === 'MOCK-C').length, 0);
    assert.equal(result.trades.length, 2);
  });

  test('a closed position frees its slot for the next launch', () => {
    const tokens = [
      tok('take-profit-run', 0, 'MOCK-A'), // takes profit at tick 6
      tok('gradual-decline', 0, 'MOCK-B'),
      tok('sideways-then-pump', 7, 'MOCK-C'),
    ];
    const result = runSimulation({ tokens });

    assert.equal(result.rejectedEntries, 0);
    const entries = ofType(result, EVENT_TYPE.ENTRY);
    assert.deepEqual(entries.map((e) => e.symbol), ['MOCK-A', 'MOCK-B', 'MOCK-C']);
    assert.equal(entries[2].tick, 7);
    assert.equal(result.peakOpenPositions, 2);
    assertAccounting(result);
  });
});

describe('daily loss limit', () => {
  test('after realized losses reach the limit, new entries are rejected', () => {
    const tokens = [0, 10, 20, 30].map((start, i) => tok('rug-pull', start, `MOCK-RUG-${i + 1}`));
    const result = runSimulation({ tokens, config: withStop });

    assert.equal(ofType(result, EVENT_TYPE.ENTRY).length, 3);
    const rejections = rejectionsOf(result);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].symbol, 'MOCK-RUG-4');
    assert.equal(rejections[0].reason, 'DAILY_LOSS_LIMIT');
    assert.equal(rejections[0].tick, 30);

    assert.equal(result.trades.length, 3); // the fourth token was never traded
    near(result.summary.dailyPnlUsd, -2.94);
    near(result.summary.balanceUsd, 7.06);
    assert.equal(result.summary.openTrades, 0);
    assertAccounting(result);
  });

  test('unrealized losses never trigger the limit', () => {
    // Four slots so three rug-pulls can sit open at about -$0.99 each (-$2.97 unrealized,
    // more than the $2 limit) while a fourth token still gets its entry accepted.
    const config = { ...defaultConfig, maxOpenPositions: 4 };
    const tokens = [
      tok('rug-pull', 0, 'MOCK-RUG-1'),
      tok('rug-pull', 0, 'MOCK-RUG-2'),
      tok('rug-pull', 0, 'MOCK-RUG-3'),
      tok('gradual-decline', 4, 'MOCK-LATE'),
    ];
    const result = runSimulation({ tokens, config, closeOpenAtEnd: false });

    const lateEntry = ofType(result, EVENT_TYPE.ENTRY).find((e) => e.symbol === 'MOCK-LATE');
    assert.equal(lateEntry.tick, 4); // all three rugs were already collapsed on paper
    assert.equal(result.rejectedEntries, 0);
    assert.equal(result.summary.dailyPnlUsd, 0);
    assert.equal(result.summary.totalRealizedPnlUsd, 0);
    assert.ok(result.summary.unrealizedPnlUsd < -2, 'unrealized loss exceeds the daily limit');
    assert.equal(result.openTradesAtEnd, 4);
    assertAccounting(result);
  });

  test('realized wins offset realized losses in the daily total', () => {
    const tokens = [
      tok('rug-pull', 0, 'MOCK-RUG'),
      tok('take-profit-run', 10, 'MOCK-WIN'),
      tok('rug-pull', 20, 'MOCK-RUG-2'),
    ];
    const result = runSimulation({ tokens, config: withStop });
    near(result.summary.dailyPnlUsd, -0.98 + 1 - 0.98);
    assert.equal(result.rejectedEntries, 0);
  });
});

describe('determinism', () => {
  test('scripted scenarios produce identical results every run', () => {
    for (const name of SCRIPTED_SCENARIO_NAMES) {
      const first = runSimulation({ tokens: [tok(name)], config: withStop });
      const second = runSimulation({ tokens: [tok(name)], config: withStop });
      assert.deepEqual(first, second, name);
    }
  });

  test('the same seed repeats the whole random-walk run exactly', () => {
    const run = (seed) =>
      runSimulation({ tokens: [createMockToken('random-walk', { seed })], config: withStop });
    assert.deepEqual(run(42), run(42));
  });

  test('different seeds give different price sequences', () => {
    const a = createMockToken('random-walk', { seed: 1 });
    const b = createMockToken('random-walk', { seed: 2 });
    assert.notDeepEqual(a.prices, b.prices);
    assert.notDeepEqual(
      runSimulation({ tokens: [a] }).events,
      runSimulation({ tokens: [b] }).events
    );
  });

  test('the portfolio run is repeatable', () => {
    assert.deepEqual(
      runSimulation({ tokens: portfolioTokens() }),
      runSimulation({ tokens: portfolioTokens() })
    );
  });

  test('timestamps are simulation ticks, not wall-clock time', () => {
    const result = runSimulation({ tokens: [tok('take-profit-run')] });
    assert.equal(result.trades[0].openedAt, 0);
    assert.equal(result.trades[0].closedAt, 6);
  });
});

describe('ledger and risk-manager consistency', () => {
  test('holds for every scenario, with and without stop-loss, open or closed at end', () => {
    for (const name of SCRIPTED_SCENARIO_NAMES) {
      for (const config of [defaultConfig, withStop]) {
        for (const closeOpenAtEnd of [true, false]) {
          assertAccounting(runSimulation({ tokens: [tok(name)], config, closeOpenAtEnd }));
        }
      }
    }
  });

  test('holds for the portfolio run and with simulated trading costs', () => {
    assertAccounting(runSimulation({ tokens: portfolioTokens() }));
    assertAccounting(runSimulation({ tokens: portfolioTokens(), config: withStop }));

    const costly = runSimulation({
      tokens: [tok('take-profit-run')],
      config: { ...defaultConfig, tradingFeeRate: 0.01 },
    });
    near(costly.summary.totalRealizedPnlUsd, 0.97);
    assertAccounting(costly);
  });

  test('portfolio run with the default config: exact expected result', () => {
    const result = runSimulation({ tokens: portfolioTokens() });
    assert.equal(ofType(result, EVENT_TYPE.ENTRY).length, 3);
    assert.deepEqual(
      rejectionsOf(result).map((e) => [e.symbol, e.reason]),
      [
        ['MOCK-RUG-PULL', 'MAX_OPEN_POSITIONS'],
        ['MOCK-SIDEWAYS-THEN-DUMP', 'MAX_OPEN_POSITIONS'],
      ]
    );
    near(result.summary.totalRealizedPnlUsd, 1.5); // +1 take-profit, -0.5 feed end, +1 take-profit
    near(result.summary.balanceUsd, 11.5);
    assert.equal(result.openTradesAtEnd, 0);
  });
});

describe('positions close exactly once', () => {
  test('each trade has at most one exit and PnL is counted once', () => {
    for (const config of [defaultConfig, withStop]) {
      const result = runSimulation({ tokens: portfolioTokens(), config });
      const exits = exitsOf(result);

      const exitCount = new Map();
      for (const exit of exits) exitCount.set(exit.tradeId, (exitCount.get(exit.tradeId) ?? 0) + 1);
      for (const trade of result.trades) {
        assert.equal(exitCount.get(trade.id), 1, `trade ${trade.id} exits`);
        assert.equal(trade.status, 'CLOSED');
      }

      assert.equal(exits.length, result.summary.closedTrades);
      const exitPnl = exits.reduce((sum, e) => sum + e.realizedPnlUsd, 0);
      near(exitPnl, result.summary.totalRealizedPnlUsd);
      near(exitPnl, result.summary.dailyPnlUsd);
      near(result.summary.balanceUsd, 10 + exitPnl);
    }
  });
});

describe('no unintended open positions', () => {
  test('by default every position is closed when the feeds end', () => {
    for (const config of [defaultConfig, withStop]) {
      const result = runSimulation({ tokens: portfolioTokens(), config });
      assert.equal(result.openTradesAtEnd, 0);
      assert.equal(result.summary.openTrades, 0);
      assert.deepEqual(result.openPositions, []);
      assert.equal(result.summary.unrealizedPnlUsd, 0);
    }
  });

  test('positions stay open only when keeping them open is explicitly requested', () => {
    const result = runSimulation({ tokens: [tok('gradual-decline')], closeOpenAtEnd: false });
    assert.equal(result.closeOpenAtEnd, false);
    assert.equal(result.openTradesAtEnd, 1);
  });
});

describe('input safety', () => {
  const plain = (overrides = {}) => ({
    mock: true,
    symbol: 'MOCK-X',
    startTick: 0,
    prices: [1, 1.5],
    ...overrides,
  });

  test('rejects empty or malformed token lists', () => {
    assert.throws(() => runSimulation({ tokens: [] }), /non-empty/);
    assert.throws(() => runSimulation({}), /non-empty/);
    assert.throws(() => runSimulation({ tokens: [null] }), /object/);
  });

  test('only mock tokens are accepted', () => {
    assert.throws(() => runSimulation({ tokens: [plain({ mock: false })] }), /Only mock tokens/);
    assert.throws(() => runSimulation({ tokens: [{ symbol: 'SOL', startTick: 0, prices: [1, 2] }] }), /Only mock tokens/);
  });

  test('rejects duplicate symbols, bad start ticks and bad prices', () => {
    assert.throws(() => runSimulation({ tokens: [plain(), plain()] }), /Duplicate token symbol/);
    assert.throws(() => runSimulation({ tokens: [plain({ startTick: -1 })] }), /startTick/);
    assert.throws(() => runSimulation({ tokens: [plain({ prices: [1] })] }), /at least 2/);
    for (const bad of [-1, NaN, Infinity, '1']) {
      assert.throws(() => runSimulation({ tokens: [plain({ prices: [1, bad] })] }), /prices/);
    }
  });

  test('an invalid launch price is rejected by the ledger, not traded', () => {
    const result = runSimulation({ tokens: [plain({ prices: [0, 1, 2] })] });
    assert.equal(result.trades.length, 0);
    assert.equal(rejectionsOf(result)[0].reason, 'INVALID_PRICE');
    assert.equal(result.summary.balanceUsd, 10);
  });

  test('invalid configs are rejected before anything runs', () => {
    assert.throws(
      () => runSimulation({ tokens: [tok('rug-pull')], config: { ...defaultConfig, paperTradingOnly: false } }),
      /paperTradingOnly/
    );
  });

  test('results are flagged as simulated and use MOCK- symbols only', () => {
    const result = runSimulation({ tokens: portfolioTokens() });
    assert.equal(result.simulated, true);
    assert.ok(result.tokens.every((t) => t.symbol.startsWith('MOCK-')));
  });
});