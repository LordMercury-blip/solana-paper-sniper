import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import defaultConfig from '../src/config.js';
import { RiskManager, REJECT } from '../src/risk-manager.js';
import {
  TradeLedger,
  TRADE_STATUS,
  CLOSE_REASON,
  LEDGER_REJECT,
} from '../src/trade-ledger.js';

const cfg = (overrides = {}) => ({ ...defaultConfig, ...overrides });
const newLedger = () => new TradeLedger(new RiskManager(), () => 1000);

describe('opening trades', () => {
  test('records a new trade with all fields', () => {
    const ledger = newLedger();
    const trade = ledger.openTrade(0.5);
    assert.deepEqual(trade, {
      id: 1,
      entryPrice: 0.5,
      sizeUsd: 1,
      entryFeeUsd: 0,
      takeProfitPrice: 1,
      stopLossPrice: null,
      exitPrice: null,
      grossProceedsUsd: null,
      exitFeeUsd: null,
      proceedsUsd: null,
      realizedPnlUsd: null,
      outcome: null,
      status: TRADE_STATUS.OPEN,
      closeReason: null,
      lastPrice: 0.5,
      openedAt: 1000,
      closedAt: null,
    });
  });

  test('opening a trade reserves funds from the simulated balance', () => {
    const ledger = newLedger();
    ledger.openTrade(0.5);
    assert.equal(ledger.getSummary().balanceUsd, 9);
    assert.equal(ledger.getSummary().openTrades, 1);
  });

  test('rejects invalid entry prices and changes nothing', () => {
    const ledger = newLedger();
    for (const bad of [0, -1, NaN, Infinity, '1', null, undefined]) {
      const check = ledger.canOpenTrade(bad);
      assert.equal(check.allowed, false);
      assert.equal(check.reason, LEDGER_REJECT.INVALID_PRICE);
      assert.throws(() => ledger.openTrade(bad), /INVALID_PRICE/);
    }
    assert.equal(ledger.getSummary().balanceUsd, 10);
    assert.equal(ledger.getSummary().openTrades, 0);
    assert.equal(ledger.getTrades().length, 0);
  });

  test('rejects entry prices whose take-profit price would overflow', () => {
    const ledger = newLedger();
    const check = ledger.canOpenTrade(Number.MAX_VALUE);
    assert.equal(check.allowed, false);
    assert.equal(check.reason, LEDGER_REJECT.INVALID_PRICE);
    assert.throws(() => ledger.openTrade(Number.MAX_VALUE), /INVALID_PRICE/);
  });

  test('rejects invalid position sizes through the risk manager', () => {
    const ledger = newLedger();
    assert.throws(() => ledger.openTrade(0.5, -1), /INVALID_POSITION_SIZE/);
    assert.throws(() => ledger.openTrade(0.5, 2), /INVALID_POSITION_SIZE/);
    assert.equal(ledger.getSummary().balanceUsd, 10);
    assert.equal(ledger.getTrades().length, 0);
  });

  test('constructor requires a RiskManager', () => {
    assert.throws(() => new TradeLedger({}), /RiskManager/);
  });
});

describe('manual closes: winning and losing trades', () => {
  test('winning trade below take-profit updates balance and daily PnL', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(4); // take-profit at 8
    const closed = ledger.closeTrade(id, 6); // 1.5x

    assert.equal(closed.status, TRADE_STATUS.CLOSED);
    assert.equal(closed.closeReason, CLOSE_REASON.MANUAL);
    assert.equal(closed.exitPrice, 6);
    assert.equal(closed.proceedsUsd, 1.5);
    assert.equal(closed.realizedPnlUsd, 0.5);
    assert.equal(closed.closedAt, 1000);

    const summary = ledger.getSummary();
    assert.equal(summary.balanceUsd, 10.5);
    assert.equal(summary.dailyPnlUsd, 0.5);
    assert.equal(summary.openTrades, 0);
  });

  test('losing trade reduces balance and daily PnL', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    const closed = ledger.closeTrade(id, 0.25); // -50%

    assert.equal(closed.proceedsUsd, 0.5);
    assert.equal(closed.realizedPnlUsd, -0.5);

    const summary = ledger.getSummary();
    assert.equal(summary.balanceUsd, 9.5);
    assert.equal(summary.dailyPnlUsd, -0.5);
  });

  test('total loss (exit price 0) loses the whole position size', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    const closed = ledger.closeTrade(id, 0);

    assert.equal(closed.proceedsUsd, 0);
    assert.equal(closed.realizedPnlUsd, -1);
    assert.equal(ledger.getSummary().balanceUsd, 9);
    assert.equal(ledger.getSummary().dailyPnlUsd, -1);
  });

  test('rejects invalid exit prices and leaves the trade open', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    for (const bad of [-1, NaN, Infinity, -Infinity, '1', null, undefined, Number.MAX_VALUE]) {
      assert.throws(() => ledger.closeTrade(id, bad), /INVALID_PRICE/);
    }
    assert.equal(ledger.getTrade(id).status, TRADE_STATUS.OPEN);
    assert.equal(ledger.getSummary().balanceUsd, 9);
    assert.equal(ledger.getSummary().dailyPnlUsd, 0);
  });

  test('unknown trade ids are rejected', () => {
    const ledger = newLedger();
    assert.throws(() => ledger.closeTrade(999, 1), /Unknown trade id/);
    assert.throws(() => ledger.updatePrice(999, 1), /Unknown trade id/);
  });
});

describe('automatic take-profit', () => {
  test('does not close while the price is below 2x entry', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5); // take-profit at 1
    const result = ledger.updatePrice(id, 0.75);

    assert.equal(result.closed, false);
    assert.equal(result.trade.status, TRADE_STATUS.OPEN);
    assert.equal(result.trade.lastPrice, 0.75);
    assert.equal(ledger.getSummary().balanceUsd, 9);
  });

  test('closes automatically when the price reaches exactly 2x entry', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    const result = ledger.updatePrice(id, 1);

    assert.equal(result.closed, true);
    assert.equal(result.trade.status, TRADE_STATUS.CLOSED);
    assert.equal(result.trade.closeReason, CLOSE_REASON.TAKE_PROFIT);
    assert.equal(result.trade.exitPrice, 1);
    assert.equal(result.trade.proceedsUsd, 2);
    assert.equal(result.trade.realizedPnlUsd, 1);
    assert.equal(result.trade.lastPrice, 1);

    const summary = ledger.getSummary();
    assert.equal(summary.balanceUsd, 11);
    assert.equal(summary.dailyPnlUsd, 1);
    assert.equal(summary.openTrades, 0);
  });

  test('a price gap above 2x still fills at the take-profit price', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    const result = ledger.updatePrice(id, 5);

    assert.equal(result.closed, true);
    assert.equal(result.trade.exitPrice, 1);
    assert.equal(result.trade.realizedPnlUsd, 1);
    assert.equal(result.trade.lastPrice, 5);
    assert.equal(ledger.getSummary().balanceUsd, 11);
  });

  test('rejects invalid prices without changing the trade', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    for (const bad of [-1, NaN, Infinity, '1', null, undefined]) {
      assert.throws(() => ledger.updatePrice(id, bad), /INVALID_PRICE/);
    }
    const trade = ledger.getTrade(id);
    assert.equal(trade.status, TRADE_STATUS.OPEN);
    assert.equal(trade.lastPrice, 0.5);
    assert.equal(ledger.getSummary().balanceUsd, 9);
  });
});

describe('duplicate closures', () => {
  test('a manually closed trade cannot be closed again', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    ledger.closeTrade(id, 0.25);
    const before = ledger.getSummary();

    assert.throws(() => ledger.closeTrade(id, 0.25), /already closed/);
    assert.throws(() => ledger.updatePrice(id, 5), /already closed/);
    assert.deepEqual(ledger.getSummary(), before);
  });

  test('a take-profit trade cannot be closed or triggered again', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(0.5);
    ledger.updatePrice(id, 1);
    const before = ledger.getSummary();

    assert.throws(() => ledger.updatePrice(id, 2), /already closed/);
    assert.throws(() => ledger.closeTrade(id, 0), /already closed/);
    assert.deepEqual(ledger.getSummary(), before);
    assert.equal(before.balanceUsd, 11);
    assert.equal(before.dailyPnlUsd, 1);
  });
});

describe('simultaneous open positions', () => {
  test('allows two open trades and rejects a third', () => {
    const ledger = newLedger();
    ledger.openTrade(0.5);
    ledger.openTrade(2);

    assert.equal(ledger.getOpenTrades().length, 2);
    assert.equal(ledger.getSummary().balanceUsd, 8);

    const check = ledger.canOpenTrade(1);
    assert.equal(check.allowed, false);
    assert.equal(check.reason, REJECT.MAX_OPEN_POSITIONS);
    assert.throws(() => ledger.openTrade(1), /MAX_OPEN_POSITIONS/);
    assert.equal(ledger.getTrades().length, 2);
  });

  test('closing one trade leaves the other untouched and frees a slot', () => {
    const ledger = newLedger();
    const a = ledger.openTrade(0.5);
    const b = ledger.openTrade(2);

    ledger.updatePrice(a.id, 1); // trade A hits take-profit

    assert.equal(ledger.getTrade(a.id).status, TRADE_STATUS.CLOSED);
    assert.equal(ledger.getTrade(b.id).status, TRADE_STATUS.OPEN);
    assert.equal(ledger.getTrade(b.id).lastPrice, 2);
    assert.equal(ledger.getSummary().balanceUsd, 10); // 8 + 2
    assert.equal(ledger.getSummary().openTrades, 1);
    assert.equal(ledger.canOpenTrade(1).allowed, true);
  });

  test('rejects an entry when the simulated balance is insufficient', () => {
    const ledger = new TradeLedger(
      new RiskManager(
        cfg({ startingBalanceUsd: 1.5, positionSizeUsd: 1, dailyLossLimitUsd: 1 })
      )
    );
    ledger.openTrade(0.5); // balance now 0.5

    const check = ledger.canOpenTrade(1);
    assert.equal(check.allowed, false);
    assert.equal(check.reason, REJECT.INSUFFICIENT_BALANCE);
    assert.throws(() => ledger.openTrade(1), /INSUFFICIENT_BALANCE/);
  });
});

describe('daily loss limit', () => {
  test('stops new entries once closed losses reach $2', () => {
    const ledger = newLedger();
    const a = ledger.openTrade(0.5);
    ledger.closeTrade(a.id, 0); // -$1
    assert.equal(ledger.canOpenTrade(0.5).allowed, true);

    const b = ledger.openTrade(0.5);
    ledger.closeTrade(b.id, 0); // -$2 total

    const check = ledger.canOpenTrade(0.5);
    assert.equal(check.allowed, false);
    assert.equal(check.reason, REJECT.DAILY_LOSS_LIMIT);
    assert.throws(() => ledger.openTrade(0.5), /DAILY_LOSS_LIMIT/);

    const summary = ledger.getSummary();
    assert.equal(summary.balanceUsd, 8);
    assert.equal(summary.dailyPnlUsd, -2);
  });

  test('already-open trades can still close after the limit is reached', () => {
    const ledger = newLedger();
    const a = ledger.openTrade(0.5); // stays open
    const b = ledger.openTrade(0.5);
    ledger.closeTrade(b.id, 0); // -$1
    const c = ledger.openTrade(0.5);
    ledger.closeTrade(c.id, 0); // -$2 total, limit reached

    assert.equal(ledger.canOpenTrade(0.5).reason, REJECT.DAILY_LOSS_LIMIT);

    const result = ledger.updatePrice(a.id, 1); // take-profit on A: +$1
    assert.equal(result.closed, true);

    const summary = ledger.getSummary();
    assert.equal(summary.dailyPnlUsd, -1);
    assert.equal(summary.balanceUsd, 9);
    assert.equal(ledger.canOpenTrade(0.5).allowed, true);
  });

  test('resetDaily re-enables entries without changing the balance', () => {
    const ledger = newLedger();
    ledger.closeTrade(ledger.openTrade(0.5).id, 0);
    ledger.closeTrade(ledger.openTrade(0.5).id, 0);
    assert.equal(ledger.canOpenTrade(0.5).allowed, false);

    ledger.resetDaily();
    assert.equal(ledger.canOpenTrade(0.5).allowed, true);
    assert.equal(ledger.getSummary().balanceUsd, 8);
  });
});

describe('records and summary', () => {
  test('returned records are copies and cannot corrupt the ledger', () => {
    const ledger = newLedger();
    const trade = ledger.openTrade(0.5);
    trade.status = TRADE_STATUS.CLOSED;
    trade.entryPrice = 999;

    const stored = ledger.getTrade(trade.id);
    assert.equal(stored.status, TRADE_STATUS.OPEN);
    assert.equal(stored.entryPrice, 0.5);
    assert.equal(ledger.getTrade(12345), null);
  });

  test('summary balance matches starting balance plus realized PnL', () => {
    const ledger = newLedger();
    const a = ledger.openTrade(0.5);
    ledger.updatePrice(a.id, 1); // +1 via take-profit
    const b = ledger.openTrade(0.5);
    ledger.closeTrade(b.id, 0.25); // -0.5 manual loss

    const summary = ledger.getSummary();
    assert.equal(summary.openTrades, 0);
    assert.equal(summary.closedTrades, 2);
    assert.equal(summary.totalRealizedPnlUsd, 0.5);
    assert.equal(summary.dailyPnlUsd, 0.5);
    assert.equal(summary.balanceUsd, 10 + summary.totalRealizedPnlUsd);
  });
});