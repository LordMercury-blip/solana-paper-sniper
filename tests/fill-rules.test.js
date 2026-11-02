import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import defaultConfig from '../src/config.js';
import { RiskManager } from '../src/risk-manager.js';
import { TradeLedger, CLOSE_REASON, TRADE_STATUS } from '../src/trade-ledger.js';

const near = (actual, expected, label = '') =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label} expected ${actual} to be about ${expected}`);

const newLedger = (overrides = {}) =>
  new TradeLedger(new RiskManager({ ...defaultConfig, ...overrides }), () => 100);

// The actual simulated entry price is deliberately different from any "launch" price used elsewhere.
const ENTRY = 0.0004;

describe('take-profit fill rule: fills at the trigger price, never better', () => {
  test('the trigger is the multiplier times the ACTUAL entry price', () => {
    const ledger = newLedger();
    const trade = ledger.openTrade(ENTRY);
    assert.equal(trade.takeProfitPrice, ENTRY * 2);
  });

  test('a price exactly at the trigger fills at the trigger', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    const { closed, trade } = ledger.updatePrice(id, ENTRY * 2);
    assert.equal(closed, true);
    assert.equal(trade.exitPrice, ENTRY * 2);
    assert.equal(trade.closeReason, CLOSE_REASON.TAKE_PROFIT);
    near(trade.realizedPnlUsd, 1);
  });

  test('a price that crosses the trigger between updates still fills at the trigger', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    assert.equal(ledger.updatePrice(id, ENTRY * 1.9).closed, false);
    const { trade } = ledger.updatePrice(id, ENTRY * 2.4);
    assert.equal(trade.exitPrice, ENTRY * 2, 'filled at the trigger, not at the 2.4x observed');
    assert.equal(trade.lastPrice, ENTRY * 2.4, 'the observed price is still recorded');
    near(trade.realizedPnlUsd, 1);
  });

  test('a huge gap above the trigger is still capped at 2x', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    const { trade } = ledger.updatePrice(id, ENTRY * 50);
    assert.equal(trade.exitPrice, ENTRY * 2);
    near(trade.realizedPnlUsd, 1);
    near(ledger.getSummary().balanceUsd, 11);
  });

  test('just below the trigger does not close', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    assert.equal(ledger.updatePrice(id, ENTRY * 2 * 0.9999).closed, false);
  });

  test('with costs, the take-profit PnL is net of entry and exit fees', () => {
    const ledger = newLedger({ tradingFeeRate: 0.01 });
    const { id } = ledger.openTrade(ENTRY);
    const { trade } = ledger.updatePrice(id, ENTRY * 3);
    near(trade.realizedPnlUsd, 0.97);
  });
});

describe('stop-loss fill rule: fills at the observed price, so gaps hurt', () => {
  const stopOn = { stopLossEnabled: true };

  test('the trigger is 60% of the ACTUAL entry price', () => {
    const trade = newLedger(stopOn).openTrade(ENTRY);
    assert.equal(trade.stopLossPrice, ENTRY * (1 - 0.4));
  });

  test('a price exactly at the trigger fills at the trigger', () => {
    const ledger = newLedger(stopOn);
    const { id, stopLossPrice } = ledger.openTrade(ENTRY);
    const { closed, trade } = ledger.updatePrice(id, stopLossPrice);
    assert.equal(closed, true);
    assert.equal(trade.exitPrice, stopLossPrice);
    assert.equal(trade.closeReason, CLOSE_REASON.STOP_LOSS);
    near(trade.realizedPnlUsd, -0.4);
  });

  test('a gap below the trigger fills at the lower observed price, not at the trigger', () => {
    const ledger = newLedger(stopOn);
    const { id, stopLossPrice } = ledger.openTrade(ENTRY);
    assert.equal(ledger.updatePrice(id, ENTRY * 0.9).closed, false);
    const gapPrice = ENTRY * 0.2;
    const { closed, trade } = ledger.updatePrice(id, gapPrice);
    assert.equal(closed, true);
    assert.equal(trade.exitPrice, gapPrice);
    assert.ok(gapPrice < stopLossPrice);
    near(trade.realizedPnlUsd, -0.8);
  });

  test('a collapse to zero loses the entire position', () => {
    const ledger = newLedger(stopOn);
    const { id } = ledger.openTrade(ENTRY);
    const { trade } = ledger.updatePrice(id, 0);
    assert.equal(trade.exitPrice, 0);
    near(trade.realizedPnlUsd, -1);
  });

  test('just above the trigger does not close', () => {
    const ledger = newLedger(stopOn);
    const { id, stopLossPrice } = ledger.openTrade(ENTRY);
    assert.equal(ledger.updatePrice(id, stopLossPrice * 1.0001).closed, false);
  });

  test('the take-profit and the stop-loss levels straddle the entry, so only one can ever apply', () => {
    const trade = newLedger(stopOn).openTrade(ENTRY);
    assert.ok(trade.stopLossPrice < trade.entryPrice && trade.entryPrice < trade.takeProfitPrice);
  });

  test('with the stop-loss DISABLED, no fall (even to zero) closes the position', () => {
    const ledger = newLedger();
    const opened = ledger.openTrade(ENTRY);
    assert.equal(opened.stopLossPrice, null);
    for (const price of [ENTRY * 0.6, ENTRY * 0.3, ENTRY * 0.01, 0]) {
      const { closed, trade } = ledger.updatePrice(opened.id, price);
      assert.equal(closed, false);
      assert.equal(trade.status, TRADE_STATUS.OPEN);
      assert.equal(trade.realizedPnlUsd, null);
      assert.equal(trade.outcome, null);
    }
    assert.equal(ledger.getSummary().dailyPnlUsd, 0);
    assert.ok(ledger.getSummary().unrealizedPnlUsd < -0.99);
  });
});

describe('FEED_ENDED: an explicit forced-close reason', () => {
  test('is a distinct close reason from MANUAL, TAKE_PROFIT and STOP_LOSS', () => {
    assert.equal(CLOSE_REASON.FEED_ENDED, 'FEED_ENDED');
    assert.equal(new Set(Object.values(CLOSE_REASON)).size, 4);
  });

  test('closeTrade with FEED_ENDED closes at the given price and records the reason', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    const closed = ledger.closeTrade(id, ENTRY * 0.5, CLOSE_REASON.FEED_ENDED);
    assert.equal(closed.closeReason, 'FEED_ENDED');
    assert.equal(closed.exitPrice, ENTRY * 0.5);
    assert.equal(closed.outcome, 'LOSS');
    near(closed.realizedPnlUsd, -0.5);
    near(ledger.getSummary().balanceUsd, 9.5);
    assert.deepEqual(ledger.verifyConsistency(), { ok: true, errors: [] });
  });

  test('existing behavior is unchanged: closeTrade without a reason is still MANUAL', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    assert.equal(ledger.closeTrade(id, ENTRY).closeReason, 'MANUAL');
  });

  test('only MANUAL and FEED_ENDED can be passed; take-profit and stop-loss belong to updatePrice', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    for (const bad of ['TAKE_PROFIT', 'STOP_LOSS', 'WHATEVER', '', null, 7]) {
      assert.throws(() => ledger.closeTrade(id, ENTRY, bad), /closeTrade reason must be one of/, String(bad));
    }
    assert.equal(ledger.getTrade(id).status, TRADE_STATUS.OPEN, 'a rejected reason changes nothing');
    near(ledger.getSummary().balanceUsd, 9);
  });

  test('a trade closed with FEED_ENDED cannot be closed or updated again', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    ledger.closeTrade(id, ENTRY * 0.8, CLOSE_REASON.FEED_ENDED);
    const before = ledger.getSummary();
    const record = ledger.getTrade(id);

    assert.throws(() => ledger.closeTrade(id, ENTRY, CLOSE_REASON.FEED_ENDED), /already closed/);
    assert.throws(() => ledger.closeTrade(id, ENTRY), /already closed/);
    assert.throws(() => ledger.updatePrice(id, ENTRY * 3), /already closed/);
    assert.deepEqual(ledger.getSummary(), before);
    assert.deepEqual(ledger.getTrade(id), record);
  });

  test('a forced close frees the slot exactly once and counts its PnL exactly once', () => {
    const ledger = newLedger();
    const a = ledger.openTrade(ENTRY);
    ledger.openTrade(ENTRY);
    assert.equal(ledger.canOpenTrade(ENTRY).reason, 'MAX_OPEN_POSITIONS');

    ledger.closeTrade(a.id, ENTRY * 0.9, CLOSE_REASON.FEED_ENDED);
    assert.equal(ledger.getSummary().openTrades, 1);
    assert.equal(ledger.canOpenTrade(ENTRY).allowed, true);
    near(ledger.getSummary().dailyPnlUsd, -0.1);
    assert.throws(() => ledger.closeTrade(a.id, ENTRY * 0.9, CLOSE_REASON.FEED_ENDED), /already closed/);
    assert.equal(ledger.getSummary().openTrades, 1);
    near(ledger.getSummary().dailyPnlUsd, -0.1);
  });

  test('a forced close at a loss is a realized loss and counts toward the daily limit', () => {
    const ledger = newLedger();
    ledger.closeTrade(ledger.openTrade(ENTRY).id, 0, CLOSE_REASON.FEED_ENDED);
    ledger.closeTrade(ledger.openTrade(ENTRY).id, 0, CLOSE_REASON.FEED_ENDED);
    assert.equal(ledger.canOpenTrade(ENTRY).reason, 'DAILY_LOSS_LIMIT');
  });
});

describe('realized and unrealized PnL stay separate while a position is open', () => {
  test('an open position below entry has unrealized PnL only', () => {
    const ledger = newLedger();
    const { id } = ledger.openTrade(ENTRY);
    ledger.updatePrice(id, ENTRY * 0.5);
    const summary = ledger.getSummary();
    near(summary.unrealizedPnlUsd, -0.5);
    assert.equal(summary.totalRealizedPnlUsd, 0);
    assert.equal(summary.dailyPnlUsd, 0);
    assert.equal(summary.losses, 0);
    assert.equal(ledger.getTrade(id).realizedPnlUsd, null);
  });
});