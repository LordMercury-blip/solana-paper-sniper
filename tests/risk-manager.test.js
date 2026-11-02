import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import defaultConfig, { validateConfig } from '../src/config.js';
import { RiskManager, REJECT } from '../src/risk-manager.js';

const cfg = (overrides = {}) => ({ ...defaultConfig, ...overrides });

describe('config validation', () => {
  test('default config is valid', () => {
    assert.doesNotThrow(() => validateConfig(defaultConfig));
  });

  test('rejects non-object config', () => {
    assert.throws(() => validateConfig(null), /expected an object/);
  });

  test('rejects paperTradingOnly not true', () => {
    assert.throws(() => validateConfig(cfg({ paperTradingOnly: false })), /paperTradingOnly/);
  });

  test('rejects bad starting balance', () => {
    assert.throws(() => validateConfig(cfg({ startingBalanceUsd: 0 })), /startingBalanceUsd/);
    assert.throws(() => validateConfig(cfg({ startingBalanceUsd: -5 })), /startingBalanceUsd/);
    assert.throws(() => validateConfig(cfg({ startingBalanceUsd: NaN })), /startingBalanceUsd/);
    assert.throws(() => validateConfig(cfg({ startingBalanceUsd: '10' })), /startingBalanceUsd/);
  });

  test('rejects bad position size', () => {
    assert.throws(() => validateConfig(cfg({ positionSizeUsd: 0 })), /positionSizeUsd/);
    assert.throws(() => validateConfig(cfg({ positionSizeUsd: Infinity })), /positionSizeUsd/);
    assert.throws(() => validateConfig(cfg({ positionSizeUsd: 11 })), /cannot exceed/);
  });

  test('rejects bad max open positions', () => {
    assert.throws(() => validateConfig(cfg({ maxOpenPositions: 0 })), /maxOpenPositions/);
    assert.throws(() => validateConfig(cfg({ maxOpenPositions: 1.5 })), /maxOpenPositions/);
  });

  test('rejects take profit multiplier of 1 or less', () => {
    assert.throws(() => validateConfig(cfg({ takeProfitMultiplier: 1 })), /takeProfitMultiplier/);
    assert.throws(() => validateConfig(cfg({ takeProfitMultiplier: 0.5 })), /takeProfitMultiplier/);
  });

  test('rejects bad daily loss limit', () => {
    assert.throws(() => validateConfig(cfg({ dailyLossLimitUsd: 0 })), /dailyLossLimitUsd/);
    assert.throws(() => validateConfig(cfg({ dailyLossLimitUsd: 50 })), /cannot exceed/);
  });

  test('reports multiple errors at once', () => {
    assert.throws(
      () => validateConfig(cfg({ positionSizeUsd: -1, maxOpenPositions: 0 })),
      /positionSizeUsd.*maxOpenPositions/
    );
  });

  test('RiskManager constructor rejects invalid config', () => {
    assert.throws(() => new RiskManager(cfg({ maxOpenPositions: 0 })), /Invalid config/);
  });
});

describe('position size validation', () => {
  test('accepts the default position size', () => {
    const rm = new RiskManager();
    assert.deepEqual(rm.canOpenPosition(), { allowed: true });
  });

  test('rejects zero, negative, NaN, Infinity and non-number sizes', () => {
    const rm = new RiskManager();
    for (const bad of [0, -1, NaN, Infinity, '1', null]) {
      const result = rm.canOpenPosition(bad);
      assert.equal(result.allowed, false);
      assert.equal(result.reason, REJECT.INVALID_POSITION_SIZE);
    }
  });

  test('rejects sizes above the configured position size', () => {
    const rm = new RiskManager();
    const result = rm.canOpenPosition(1.5);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.INVALID_POSITION_SIZE);
  });

  test('openPosition throws on an invalid size and changes nothing', () => {
    const rm = new RiskManager();
    assert.throws(() => rm.openPosition(-1), /INVALID_POSITION_SIZE/);
    assert.equal(rm.getState().balanceUsd, 10);
    assert.equal(rm.openPositionCount, 0);
  });
});

describe('balance checks', () => {
  test('opening a position reserves funds', () => {
    const rm = new RiskManager();
    rm.openPosition();
    assert.equal(rm.getState().balanceUsd, 9);
  });

  test('rejects entry when balance is insufficient', () => {
    const rm = new RiskManager(
      cfg({ startingBalanceUsd: 1.5, positionSizeUsd: 1, dailyLossLimitUsd: 1 })
    );
    rm.openPosition(); // balance now 0.5
    const result = rm.canOpenPosition();
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.INSUFFICIENT_BALANCE);
    assert.throws(() => rm.openPosition(), /INSUFFICIENT_BALANCE/);
  });

  test('allows entry when balance exactly equals the position size', () => {
    const rm = new RiskManager(
      cfg({ startingBalanceUsd: 1, positionSizeUsd: 1, dailyLossLimitUsd: 1 })
    );
    assert.equal(rm.canOpenPosition().allowed, true);
  });
});

describe('maximum open positions', () => {
  test('rejects a third position when the max is 2', () => {
    const rm = new RiskManager();
    rm.openPosition();
    rm.openPosition();
    const result = rm.canOpenPosition();
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.MAX_OPEN_POSITIONS);
    assert.throws(() => rm.openPosition(), /MAX_OPEN_POSITIONS/);
  });

  test('closing a position frees a slot', () => {
    const rm = new RiskManager();
    const id = rm.openPosition();
    rm.openPosition();
    rm.closePosition(id, 1);
    assert.equal(rm.canOpenPosition().allowed, true);
  });
});

describe('daily loss limit', () => {
  test('stops new entries once losses reach the limit', () => {
    const rm = new RiskManager();
    const a = rm.openPosition();
    rm.closePosition(a, 0); // -$1
    assert.equal(rm.canOpenPosition().allowed, true);

    const b = rm.openPosition();
    rm.closePosition(b, 0); // -$2 total
    const result = rm.canOpenPosition();
    assert.equal(result.allowed, false);
    assert.equal(result.reason, REJECT.DAILY_LOSS_LIMIT);
    assert.throws(() => rm.openPosition(), /DAILY_LOSS_LIMIT/);
  });

  test('wins offset losses in the daily total', () => {
    const rm = new RiskManager();
    const a = rm.openPosition();
    rm.closePosition(a, 0); // -$1
    const b = rm.openPosition();
    rm.closePosition(b, 2); // +$1
    assert.equal(rm.getState().dailyPnlUsd, 0);
    assert.equal(rm.canOpenPosition().allowed, true);
  });

  test('resetDaily re-enables entries without changing the balance', () => {
    const rm = new RiskManager();
    rm.closePosition(rm.openPosition(), 0);
    rm.closePosition(rm.openPosition(), 0);
    assert.equal(rm.canOpenPosition().allowed, false);

    rm.resetDaily();
    assert.equal(rm.canOpenPosition().allowed, true);
    assert.equal(rm.getState().balanceUsd, 8);
  });
});

describe('closing positions and take profit', () => {
  test('closePosition returns pnl and updates the balance', () => {
    const rm = new RiskManager();
    const id = rm.openPosition();
    const pnl = rm.closePosition(id, 2);
    assert.equal(pnl, 1);
    assert.equal(rm.getState().balanceUsd, 11);
  });

  test('closePosition rejects unknown ids and bad proceeds', () => {
    const rm = new RiskManager();
    assert.throws(() => rm.closePosition(999, 1), /Unknown position/);
    const id = rm.openPosition();
    assert.throws(() => rm.closePosition(id, -1), /proceedsUsd/);
    assert.throws(() => rm.closePosition(id, NaN), /proceedsUsd/);
  });

  test('a position cannot be closed twice', () => {
    const rm = new RiskManager();
    const id = rm.openPosition();
    rm.closePosition(id, 1);
    assert.throws(() => rm.closePosition(id, 1), /Unknown position/);
  });

  test('takeProfitPrice is 2x entry by default', () => {
    const rm = new RiskManager();
    assert.equal(rm.takeProfitPrice(0.0005), 0.001);
    assert.throws(() => rm.takeProfitPrice(0), /entryPrice/);
  });
});