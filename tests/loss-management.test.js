import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import defaultConfig, { validateConfig } from '../src/config.js';
import { classifyOutcome, TRADE_OUTCOME } from '../src/accounting.js';
import { RiskManager, REJECT } from '../src/risk-manager.js';
import { TradeLedger, TRADE_STATUS, CLOSE_REASON } from '../src/trade-ledger.js';

const cfg = (overrides = {}) => ({ ...defaultConfig, ...overrides });
const newLedger = (overrides = {}) =>
  new TradeLedger(new RiskManager(cfg(overrides)), () => 1000);
const near = (actual, expected, label = '') =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label} expected ${actual} to be about ${expected}`
  );
const assertConsistent = (ledger) =>
  assert.deepEqual(ledger.verifyConsistency(), { ok: true, errors: [] });

describe('classifyOutcome', () => {
  test('positive is a WIN, negative is a LOSS, zero is BREAK_EVEN', () => {
    assert.equal(classifyOutcome(0.5), TRADE_OUTCOME.WIN);
    assert.equal(classifyOutcome(-0.5), TRADE_OUTCOME.LOSS);
    assert.equal(classifyOutcome(0), TRADE_OUTCOME.BREAK_EVEN);
    assert.equal(classifyOutcome(-0), TRADE_OUTCOME.BREAK_EVEN);
  });

  test('there is no percentage threshold: tiny wins and losses still count', () => {
    assert.equal(classifyOutcome(0.000001), TRADE_OUTCOME.WIN);
    assert.equal(classifyOutcome(-0.000001), TRADE_OUTCOME.LOSS);
  });

  test('floating point dust below 1e-8 dollars is break-even', () => {
    assert.equal(classifyOutcome(1e-10), TRADE_OUTCOME.BREAK_EVEN);
    assert.equal(classifyOutcome(-1e-10), TRADE_OUTCOME.BREAK_EVEN);
  });

  test('rejects values that are not finite numbers', () => {
    for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined]) {
      assert.throws(() => classifyOutcome(bad), /finite number/);
    }
  });
});

describe('realized outcomes on closed trades', () => {
  test('positive realized PnL is a WIN', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(1);
    const closed = ledger.closeTrade(id, 1.5);
    assert.equal(closed.realizedPnlUsd, 0.5);
    assert.equal(closed.outcome, TRADE_OUTCOME.WIN);
    assert.equal(ledger.getSummary().wins, 1);
  });

  test('negative realized PnL is a LOSS', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(1);
    const closed = ledger.closeTrade(id, 0.5);
    assert.equal(closed.realizedPnlUsd, -0.5);
    assert.equal(closed.outcome, TRADE_OUTCOME.LOSS);
    assert.equal(ledger.getSummary().losses, 1);
  });

  test('zero realized PnL is BREAK_EVEN and leaves the balance unchanged', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(1);
    const closed = ledger.closeTrade(id, 1);
    assert.ok(closed.realizedPnlUsd === 0);
    assert.equal(closed.outcome, TRADE_OUTCOME.BREAK_EVEN);
    assert.equal(ledger.getSummary().balanceUsd, 10);
    assert.equal(ledger.getSummary().breakEvens, 1);
  });

  test('small price moves classify by sign, not by a percentage cutoff', () => {
    const up = newLedger();
    const upTrade = up.closeTrade(up.openTrade(1).id, 1.01);
    assert.equal(upTrade.outcome, TRADE_OUTCOME.WIN);

    const down = newLedger();
    const downTrade = down.closeTrade(down.openTrade(1).id, 0.99);
    assert.equal(downTrade.outcome, TRADE_OUTCOME.LOSS);
  });

  test('an open trade has no outcome and no realized PnL', () => {
    const ledger = newLedger();
    const trade = ledger.openTrade(1);
    assert.equal(trade.outcome, null);
    assert.equal(trade.realizedPnlUsd, null);
    assert.equal(trade.status, TRADE_STATUS.OPEN);
  });
});

describe('simulated trading costs', () => {
  test('take-profit with 1% costs: exact accounting', () => {
    const ledger = newLedger({ tradingFeeRate: 0.01 });
    const opened = ledger.openTrade(1);
    near(opened.entryFeeUsd, 0.01);
    near(ledger.getSummary().balanceUsd, 8.99);

    const { trade } = ledger.updatePrice(opened.id, 2);
    near(trade.grossProceedsUsd, 2);
    near(trade.exitFeeUsd, 0.02);
    near(trade.proceedsUsd, 1.98);
    near(trade.realizedPnlUsd, 0.97);
    assert.equal(trade.outcome, TRADE_OUTCOME.WIN);

    const summary = ledger.getSummary();
    near(summary.balanceUsd, 10.97);
    near(summary.dailyPnlUsd, 0.97);
    assertConsistent(ledger);
  });

  test('costs can turn a higher exit price into a LOSS', () => {
    const ledger = newLedger({ tradingFeeRate: 0.01 });
    const { id } = ledger.openTrade(1);
    const closed = ledger.closeTrade(id, 1.01); // price is up 1%, costs are about 2%
    near(closed.realizedPnlUsd, -0.0101);
    assert.equal(closed.outcome, TRADE_OUTCOME.LOSS);
  });

  test('exiting at the entry price loses the round-trip costs', () => {
    const ledger = newLedger({ tradingFeeRate: 0.01 });
    const { id } = ledger.openTrade(1);
    const closed = ledger.closeTrade(id, 1);
    near(closed.realizedPnlUsd, -0.02);
    assert.equal(closed.outcome, TRADE_OUTCOME.LOSS);
    near(ledger.getSummary().balanceUsd, 9.98);
  });

  test('entry costs count toward the balance check', () => {
    const ledger = newLedger({
      startingBalanceUsd: 1.005,
      positionSizeUsd: 1,
      dailyLossLimitUsd: 1,
      tradingFeeRate: 0.01,
    });
    const check = ledger.canOpenTrade(1); // needs $1.01, has $1.005
    assert.equal(check.allowed, false);
    assert.equal(check.reason, REJECT.INSUFFICIENT_BALANCE);
  });
});

describe('unrealized versus realized losses', () => {
  test('a price below entry is an unrealized loss, not a realized one', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(1);
    const { closed, trade } = ledger.updatePrice(id, 0.5);

    assert.equal(closed, false);
    assert.equal(trade.status, TRADE_STATUS.OPEN);
    assert.equal(trade.realizedPnlUsd, null);
    assert.equal(trade.outcome, null);
    near(ledger.getUnrealizedPnlUsd(id), -0.5);

    const summary = ledger.getSummary();
    near(summary.unrealizedPnlUsd, -0.5);
    assert.equal(summary.totalRealizedPnlUsd, 0);
    assert.equal(summary.dailyPnlUsd, 0);
    assert.equal(summary.losses, 0);
    near(summary.balanceUsd, 9);
    near(summary.equityUsd, 9.5);
    assertConsistent(ledger);
  });

  test('unrealized losses do not count toward the daily loss limit', () => {
    // Three slots so two open positions can sit at -$1 each (-$2 unrealized = the limit).
    const ledger = newLedger({ maxOpenPositions: 3 });
    const a = ledger.openTrade(1);
    const b = ledger.openTrade(1);
    ledger.updatePrice(a.id, 0);
    ledger.updatePrice(b.id, 0);

    const summary = ledger.getSummary();
    near(summary.unrealizedPnlUsd, -2);
    assert.equal(summary.dailyPnlUsd, 0);
    assert.equal(ledger.canOpenTrade(1).allowed, true);
    assert.doesNotThrow(() => ledger.openTrade(1));
    assertConsistent(ledger);
  });

  test('the loss only becomes realized, and counts daily, once the trade closes', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(1);
    ledger.updatePrice(id, 0.5);
    assert.equal(ledger.getSummary().dailyPnlUsd, 0);

    const closed = ledger.closeTrade(id, 0.5);
    assert.equal(closed.outcome, TRADE_OUTCOME.LOSS);
    near(ledger.getSummary().dailyPnlUsd, -0.5);
    assert.equal(ledger.getSummary().unrealizedPnlUsd, 0);
    assert.equal(ledger.getUnrealizedPnlUsd(id), 0);
  });
});

describe('stop-loss configuration', () => {
  test('stop-loss is disabled by default and the 40% value is stored separately', () => {
    assert.equal(defaultConfig.stopLossEnabled, false);
    assert.equal(defaultConfig.stopLossFraction, 0.4);
  });

  test('validates stop-loss and cost settings', () => {
    for (const bad of ['yes', 1, 0, null, undefined]) {
      assert.throws(
        () => validateConfig(cfg({ stopLossEnabled: bad })),
        /stopLossEnabled/
      );
    }
    for (const bad of [0, 1, -0.1, 1.5, NaN, Infinity, '0.4', null]) {
      assert.throws(
        () => validateConfig(cfg({ stopLossFraction: bad })),
        /stopLossFraction/
      );
    }
    for (const bad of [-0.01, 1, 2, NaN, Infinity, '0.01', null]) {
      assert.throws(
        () => validateConfig(cfg({ tradingFeeRate: bad })),
        /tradingFeeRate/
      );
    }
    assert.doesNotThrow(() => validateConfig(cfg({ stopLossEnabled: true })));
    assert.doesNotThrow(() => validateConfig(cfg({ tradingFeeRate: 0.02 })));
  });
});

describe('stop-loss disabled (default)', () => {
  test('a 40% decline does not close the position', () => {
    const ledger = newLedger();
    const opened = ledger.openTrade(1);
    assert.equal(opened.stopLossPrice, null);

    for (const price of [0.6, 0.5, 0.01, 0]) {
      const { closed, trade } = ledger.updatePrice(opened.id, price);
      assert.equal(closed, false);
      assert.equal(trade.status, TRADE_STATUS.OPEN);
      assert.equal(trade.outcome, null);
    }

    assert.equal(ledger.getSummary().openTrades, 1);
    assert.equal(ledger.getSummary().dailyPnlUsd, 0);
    assert.equal(ledger.getSummary().balanceUsd, 9);
  });

  test('loss classification is separate from the stop-loss trigger', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(1);
    const closed = ledger.closeTrade(id, 0.6); // down 40%, closed by hand
    assert.equal(closed.closeReason, CLOSE_REASON.MANUAL);
    assert.equal(closed.outcome, TRADE_OUTCOME.LOSS);
    near(closed.realizedPnlUsd, -0.4);
  });
});

describe('stop-loss enabled', () => {
  test('trigger price is 60% of entry and the position closes at the trigger', () => {
    const ledger = newLedger({ stopLossEnabled: true });
    const opened = ledger.openTrade(1);
    assert.equal(opened.stopLossPrice, 0.6);

    const above = ledger.updatePrice(opened.id, 0.61);
    assert.equal(above.closed, false);

    const hit = ledger.updatePrice(opened.id, 0.6);
    assert.equal(hit.closed, true);
    assert.equal(hit.trade.closeReason, CLOSE_REASON.STOP_LOSS);
    assert.equal(hit.trade.exitPrice, 0.6);
    near(hit.trade.realizedPnlUsd, -0.4);
    assert.equal(hit.trade.outcome, TRADE_OUTCOME.LOSS);

    const summary = ledger.getSummary();
    near(summary.balanceUsd, 9.6);
    near(summary.dailyPnlUsd, -0.4);
    assert.equal(summary.openTrades, 0);
    assertConsistent(ledger);
  });

  test('a gap below the trigger fills at the observed (lower) price', () => {
    const ledger = newLedger({ stopLossEnabled: true });
    const { id } = ledger.openTrade(1);
    const { closed, trade } = ledger.updatePrice(id, 0.2);

    assert.equal(closed, true);
    assert.equal(trade.closeReason, CLOSE_REASON.STOP_LOSS);
    assert.equal(trade.exitPrice, 0.2);
    near(trade.realizedPnlUsd, -0.8);
  });

  test('take-profit still triggers at 2x and prices in between do nothing', () => {
    const ledger = newLedger({ stopLossEnabled: true });
    const { id } = ledger.openTrade(1);

    assert.equal(ledger.updatePrice(id, 1.5).closed, false);
    assert.equal(ledger.updatePrice(id, 0.8).closed, false);

    const { closed, trade } = ledger.updatePrice(id, 2);
    assert.equal(closed, true);
    assert.equal(trade.closeReason, CLOSE_REASON.TAKE_PROFIT);
    assert.equal(trade.outcome, TRADE_OUTCOME.WIN);
  });

  test('stop-loss losses are realized and count toward the daily loss limit', () => {
    const ledger = newLedger({ stopLossEnabled: true });

    for (let i = 1; i <= 4; i += 1) {
      const { id } = ledger.openTrade(1);
      ledger.updatePrice(id, 0.6); // -$0.40 each
      assert.equal(ledger.canOpenTrade(1).allowed, true, `still allowed after ${i} stops`);
    }
    near(ledger.getSummary().dailyPnlUsd, -1.6);

    const { id } = ledger.openTrade(1);
    ledger.updatePrice(id, 0.6); // fifth stop: -$2.00 total

    near(ledger.getSummary().dailyPnlUsd, -2);
    const check = ledger.canOpenTrade(1);
    assert.equal(check.allowed, false);
    assert.equal(check.reason, REJECT.DAILY_LOSS_LIMIT);
    near(ledger.getSummary().balanceUsd, 8);
    assertConsistent(ledger);
  });
});

describe('take-profit at 2x entry', () => {
  test('closes at exactly 2x as a WIN', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    const { closed, trade } = ledger.updatePrice(id, 1);

    assert.equal(closed, true);
    assert.equal(trade.closeReason, CLOSE_REASON.TAKE_PROFIT);
    assert.equal(trade.exitPrice, 1);
    assert.equal(trade.realizedPnlUsd, 1);
    assert.equal(trade.outcome, TRADE_OUTCOME.WIN);
    assert.equal(ledger.getSummary().balanceUsd, 11);
  });

  test('does not close just below 2x', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    assert.equal(ledger.updatePrice(id, 0.9999).closed, false);
  });
});

describe('position slots', () => {
  const exits = [
    ['win', 1.5],
    ['loss', 0.5],
    ['break-even', 1],
  ];

  for (const [name, exitPrice] of exits) {
    test(`closing at a ${name} frees the slot immediately`, () => {
      const ledger = newLedger();
      const a = ledger.openTrade(1);
      ledger.openTrade(1);
      assert.equal(ledger.canOpenTrade(1).reason, REJECT.MAX_OPEN_POSITIONS);

      ledger.closeTrade(a.id, exitPrice);

      assert.equal(ledger.getSummary().openTrades, 1);
      assert.equal(ledger.canOpenTrade(1).allowed, true);
      assert.doesNotThrow(() => ledger.openTrade(1));
      assert.equal(ledger.getSummary().openTrades, 2);
      assertConsistent(ledger);
    });
  }

  test('open positions keep their slots whatever their unrealized PnL is', () => {
    const ledger = newLedger();
    const a = ledger.openTrade(1);
    const b = ledger.openTrade(1);
    ledger.updatePrice(a.id, 0.01); // deep unrealized loss
    ledger.updatePrice(b.id, 1.9); // large unrealized gain

    assert.ok(ledger.getUnrealizedPnlUsd(a.id) < 0);
    assert.ok(ledger.getUnrealizedPnlUsd(b.id) > 0);
    assert.equal(ledger.getSummary().openTrades, 2);
    assert.equal(ledger.canOpenTrade(1).reason, REJECT.MAX_OPEN_POSITIONS);
    assert.throws(() => ledger.openTrade(1), /MAX_OPEN_POSITIONS/);
    assert.equal(ledger.getTrades().length, 2);
  });

  test('two open positions block a third, even with plenty of cash', () => {
    const ledger = newLedger();
    ledger.openTrade(1);
    ledger.openTrade(1);
    assert.ok(ledger.getSummary().availableFundsUsd >= 8);
    assert.throws(() => ledger.openTrade(1), /MAX_OPEN_POSITIONS/);
  });
});

describe('realized daily loss limit', () => {
  test('two $1 realized losses stop new entries', () => {
    const ledger = newLedger();
    ledger.closeTrade(ledger.openTrade(1).id, 0);
    assert.equal(ledger.canOpenTrade(1).allowed, true);
    ledger.closeTrade(ledger.openTrade(1).id, 0);

    const check = ledger.canOpenTrade(1);
    assert.equal(check.allowed, false);
    assert.equal(check.reason, REJECT.DAILY_LOSS_LIMIT);
    assert.throws(() => ledger.openTrade(1), /DAILY_LOSS_LIMIT/);
  });

  test('the limit is on NET realized PnL, so wins offset losses', () => {
    const ledger = newLedger();
    ledger.closeTrade(ledger.openTrade(1).id, 0); // -1
    ledger.closeTrade(ledger.openTrade(1).id, 2); // +1
    ledger.closeTrade(ledger.openTrade(1).id, 0); // -1
    near(ledger.getSummary().dailyPnlUsd, -1);
    assert.equal(ledger.canOpenTrade(1).allowed, true);
  });

  test('break-even trades do not move the daily total', () => {
    const ledger = newLedger();
    ledger.closeTrade(ledger.openTrade(1).id, 1);
    assert.equal(ledger.getSummary().dailyPnlUsd, 0);
  });

  test('simulated costs count toward the realized daily loss', () => {
    const ledger = newLedger({ tradingFeeRate: 0.01 });
    ledger.closeTrade(ledger.openTrade(1).id, 0); // -(1 + 0.01)
    near(ledger.getSummary().dailyPnlUsd, -1.01);
    assert.equal(ledger.canOpenTrade(1).allowed, true);

    ledger.closeTrade(ledger.openTrade(1).id, 0);
    near(ledger.getSummary().dailyPnlUsd, -2.02);
    assert.equal(ledger.canOpenTrade(1).reason, REJECT.DAILY_LOSS_LIMIT);
    near(ledger.getSummary().balanceUsd, 7.98);
    assertConsistent(ledger);
  });
});

describe('balance and ledger consistency', () => {
  test('balance, equity, realized and unrealized PnL stay consistent step by step', () => {
    const ledger = newLedger({ tradingFeeRate: 0.01 });

    // Open A at 0.5 and B at 2, each $1 plus a $0.01 entry fee.
    const a = ledger.openTrade(0.5);
    const b = ledger.openTrade(2);
    let s = ledger.getSummary();
    near(s.balanceUsd, 7.98);
    near(s.openCostBasisUsd, 2.02);
    assert.equal(s.openTrades, 2);
    assertConsistent(ledger);

    // B falls 50%. It stays open, so the loss is unrealized.
    ledger.updatePrice(b.id, 1);
    near(ledger.getUnrealizedPnlUsd(b.id), -0.515);
    near(ledger.getUnrealizedPnlUsd(a.id), -0.02); // only the costs, price unchanged
    s = ledger.getSummary();
    near(s.unrealizedPnlUsd, -0.535);
    near(s.equityUsd, 9.465);
    assert.equal(s.dailyPnlUsd, 0);
    assert.equal(s.totalRealizedPnlUsd, 0);
    assertConsistent(ledger);

    // A hits take-profit: +$0.97 after costs. B is untouched and still open.
    ledger.updatePrice(a.id, 1);
    s = ledger.getSummary();
    near(s.balanceUsd, 9.96);
    near(s.totalRealizedPnlUsd, 0.97);
    near(s.dailyPnlUsd, 0.97);
    near(s.unrealizedPnlUsd, -0.515);
    near(s.equityUsd, 10.455);
    assert.equal(s.openTrades, 1);
    assert.equal(ledger.getTrade(b.id).status, TRADE_STATUS.OPEN);
    assertConsistent(ledger);

    // B closes at a loss: -$0.515 realized.
    const closedB = ledger.closeTrade(b.id, 1);
    near(closedB.realizedPnlUsd, -0.515);
    s = ledger.getSummary();
    near(s.balanceUsd, 10.455);
    near(s.totalRealizedPnlUsd, 0.455);
    near(s.dailyPnlUsd, 0.455);
    assert.equal(s.unrealizedPnlUsd, 0);
    near(s.equityUsd, 10.455);
    assert.equal(s.openTrades, 0);
    assert.equal(s.closedTrades, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
    assertConsistent(ledger);
  });

  test('ledger summary and risk manager state always agree', () => {
    const ledger = newLedger();
    const a = ledger.openTrade(1);
    ledger.openTrade(1);
    ledger.closeTrade(a.id, 0.5);

    const state = ledger.riskManager.getState();
    const summary = ledger.getSummary();
    assert.equal(state.balanceUsd, summary.balanceUsd);
    assert.equal(state.dailyPnlUsd, summary.dailyPnlUsd);
    assert.equal(state.openPositions, summary.openTrades);
    assert.equal(summary.openTrades, ledger.getOpenTrades().length);
    assertConsistent(ledger);
  });
});

describe('duplicate closure protection', () => {
  const closers = {
    'take-profit': (ledger, id) => ledger.updatePrice(id, 2),
    'stop-loss': (ledger, id) => ledger.updatePrice(id, 0.6),
    manual: (ledger, id) => ledger.closeTrade(id, 0.8),
  };

  for (const [name, close] of Object.entries(closers)) {
    test(`a trade closed by ${name} cannot be closed or updated again`, () => {
      const ledger = newLedger({ stopLossEnabled: true });
      const { id } = ledger.openTrade(1);
      close(ledger, id);

      const summary = ledger.getSummary();
      const record = ledger.getTrade(id);
      assert.equal(record.status, TRADE_STATUS.CLOSED);

      assert.throws(() => ledger.closeTrade(id, 0), /already closed/);
      assert.throws(() => ledger.updatePrice(id, 0), /already closed/);
      assert.throws(() => ledger.updatePrice(id, 5), /already closed/);

      assert.deepEqual(ledger.getSummary(), summary);
      assert.deepEqual(ledger.getTrade(id), record);
      assertConsistent(ledger);
    });
  }

  test('PnL is counted exactly once', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(1);
    ledger.closeTrade(id, 0.5);
    assert.throws(() => ledger.closeTrade(id, 0.5), /already closed/);
    near(ledger.getSummary().dailyPnlUsd, -0.5);
    near(ledger.getSummary().totalRealizedPnlUsd, -0.5);
    near(ledger.getSummary().balanceUsd, 9.5);
  });
});

describe('every position goes through the ledger', () => {
  test('a bound risk manager rejects direct open and close calls', () => {
    const rm = new RiskManager();
    const ledger = new TradeLedger(rm, () => 1000);
    const { id } = ledger.openTrade(1);

    assert.throws(() => rm.openPosition(), /LEDGER_REQUIRED/);
    assert.throws(() => rm.closePosition(id, 2), /LEDGER_REQUIRED/);

    assert.equal(ledger.getTrade(id).status, TRADE_STATUS.OPEN);
    assert.equal(rm.getState().openPositions, 1);
    assert.equal(rm.getState().balanceUsd, 9);
    assertConsistent(ledger);
  });

  test('a risk manager cannot be shared between two ledgers', () => {
    const rm = new RiskManager();
    new TradeLedger(rm);
    assert.throws(() => new TradeLedger(rm), /already bound/);
  });

  test('a risk manager that already has positions cannot be bound', () => {
    const rm = new RiskManager();
    rm.openPosition();
    assert.throws(() => new TradeLedger(rm), /already been used/);
  });

  test('a failed ledger construction does not consume the risk manager', () => {
    const rm = new RiskManager();
    assert.throws(() => new TradeLedger(rm, 'not a function'), /now must be a function/);
    assert.doesNotThrow(() => new TradeLedger(rm));
  });

  test('balance and daily PnL cannot be assigned from outside', () => {
    const rm = new RiskManager();
    assert.throws(() => {
      rm.balanceUsd = 1000;
    }, TypeError);
    assert.throws(() => {
      rm.dailyPnlUsd = -100;
    }, TypeError);
    assert.equal(rm.balanceUsd, 10);
    assert.equal(rm.dailyPnlUsd, 0);
  });
});