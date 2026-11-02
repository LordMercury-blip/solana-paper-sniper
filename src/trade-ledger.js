import { RiskManager } from './risk-manager.js';
import { roundUsd, classifyOutcome, TRADE_OUTCOME } from './accounting.js';

// Paper trading only: this module never touches wallets, keys, or networks.

export { TRADE_OUTCOME };

export const TRADE_STATUS = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
});

// WHY a trade closed. This is separate from the outcome (WIN/LOSS/BREAK_EVEN),
// which only says how much money the trade made or lost after costs.
export const CLOSE_REASON = Object.freeze({
  TAKE_PROFIT: 'TAKE_PROFIT',
  STOP_LOSS: 'STOP_LOSS',
  MANUAL: 'MANUAL',
  // A forced close because the price feed ended. Not a trading decision.
  FEED_ENDED: 'FEED_ENDED',
});

// Reasons a caller may pass to closeTrade(). TAKE_PROFIT and STOP_LOSS are only ever
// set by updatePrice(), so they cannot be passed in.
const CLOSE_TRADE_REASONS = Object.freeze([CLOSE_REASON.MANUAL, CLOSE_REASON.FEED_ENDED]);

export const LEDGER_REJECT = Object.freeze({
  INVALID_PRICE: 'INVALID_PRICE',
});

const CONSISTENCY_TOLERANCE = 1e-6;

// Entry prices must be strictly positive.
function isValidEntryPrice(price) {
  return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

// Market/exit prices may be 0 (a token that rugged to nothing is a total loss).
function isValidMarketPrice(price) {
  return typeof price === 'number' && Number.isFinite(price) && price >= 0;
}

export class TradeLedger {
  #token;
  #trades = new Map(); // id -> trade record (same id as the risk manager position)

  /**
   * @param {RiskManager} riskManager - owns the simulated balance and daily PnL.
   *   It is bound to this ledger: after this, positions can only be opened and
   *   closed through the ledger, so the two can never disagree.
   * @param {() => number} now - clock, injectable for tests
   */
  constructor(riskManager = new RiskManager(), now = () => Date.now()) {
    if (!(riskManager instanceof RiskManager)) {
      throw new Error('TradeLedger requires a RiskManager instance');
    }
    if (typeof now !== 'function') {
      throw new Error('now must be a function returning a timestamp');
    }
    this.#token = riskManager.claimForLedger();
    this.riskManager = riskManager;
    this.now = now;
  }

  /** Returns { allowed: boolean, reason?: string, message?: string } */
  canOpenTrade(entryPrice, sizeUsd = this.riskManager.config.positionSizeUsd) {
    if (!isValidEntryPrice(entryPrice)) {
      return {
        allowed: false,
        reason: LEDGER_REJECT.INVALID_PRICE,
        message: 'Entry price must be a positive finite number',
      };
    }

    const takeProfitPrice = this.riskManager.takeProfitPrice(entryPrice);
    if (!Number.isFinite(takeProfitPrice)) {
      return {
        allowed: false,
        reason: LEDGER_REJECT.INVALID_PRICE,
        message: 'Entry price is too large to compute a take-profit price',
      };
    }

    return this.riskManager.canOpenPosition(sizeUsd);
  }

  /** Opens a simulated trade. Throws if any risk rule rejects it. Returns a copy of the record. */
  openTrade(entryPrice, sizeUsd = this.riskManager.config.positionSizeUsd) {
    const check = this.canOpenTrade(entryPrice, sizeUsd);
    if (!check.allowed) {
      throw new Error(`${check.reason}: ${check.message}`);
    }

    const takeProfitPrice = this.riskManager.takeProfitPrice(entryPrice);
    const stopLossPrice = this.riskManager.stopLossPrice(entryPrice); // null when disabled
    const id = this.riskManager.openPosition(sizeUsd, this.#token);
    const { entryFeeUsd } = this.riskManager.getPosition(id);

    const trade = {
      id,
      entryPrice,
      sizeUsd,
      entryFeeUsd,
      takeProfitPrice,
      stopLossPrice,
      exitPrice: null,
      grossProceedsUsd: null,
      exitFeeUsd: null,
      proceedsUsd: null, // NET proceeds after the exit fee
      realizedPnlUsd: null, // null while open: an open trade has no realized PnL
      outcome: null, // WIN / LOSS / BREAK_EVEN, set only when the trade closes
      status: TRADE_STATUS.OPEN,
      closeReason: null,
      lastPrice: entryPrice,
      openedAt: this.now(),
      closedAt: null,
    };
    this.#trades.set(id, trade);
    return { ...trade };
  }

  /**
   * Feeds a new price for an open trade.
   *  1. Take-profit: price >= take-profit price closes the trade at exactly the
   *     take-profit price, even if the price gapped higher (conservative).
   *  2. Stop-loss: only if enabled in the config. price <= stop-loss price closes
   *     the trade at the observed price, so a gap below the trigger fills at the
   *     lower price (conservative).
   *  3. Otherwise the trade stays open, however far the price has fallen. A price
   *     below entry is an unrealized loss, not a realized one.
   * Returns { closed: boolean, trade: <copy of record> }.
   */
  updatePrice(id, price) {
    const trade = this.#getOpenTrade(id);
    if (!isValidMarketPrice(price)) {
      throw new Error(
        `${LEDGER_REJECT.INVALID_PRICE}: price must be a finite number >= 0`
      );
    }

    if (price >= trade.takeProfitPrice) {
      const grossProceedsUsd = roundUsd(
        trade.sizeUsd * this.riskManager.config.takeProfitMultiplier
      );
      this.#finalize(trade, trade.takeProfitPrice, grossProceedsUsd, CLOSE_REASON.TAKE_PROFIT);
      trade.lastPrice = price;
      return { closed: true, trade: { ...trade } };
    }

    if (trade.stopLossPrice !== null && price <= trade.stopLossPrice) {
      const grossProceedsUsd = roundUsd(trade.sizeUsd * (price / trade.entryPrice));
      this.#finalize(trade, price, grossProceedsUsd, CLOSE_REASON.STOP_LOSS);
      trade.lastPrice = price;
      return { closed: true, trade: { ...trade } };
    }

    trade.lastPrice = price;
    return { closed: false, trade: { ...trade } };
  }

  /**
   * Closes an open trade at exitPrice. reason defaults to MANUAL (an early exit chosen by
   * the caller); pass FEED_ENDED to label a forced close at the end of a price feed.
   */
  closeTrade(id, exitPrice, reason = CLOSE_REASON.MANUAL) {
    if (!CLOSE_TRADE_REASONS.includes(reason)) {
      throw new Error(`closeTrade reason must be one of: ${CLOSE_TRADE_REASONS.join(', ')}`);
    }
    const trade = this.#getOpenTrade(id);
    if (!isValidMarketPrice(exitPrice)) {
      throw new Error(
        `${LEDGER_REJECT.INVALID_PRICE}: exit price must be a finite number >= 0`
      );
    }

    const grossProceedsUsd = roundUsd(trade.sizeUsd * (exitPrice / trade.entryPrice));
    if (!Number.isFinite(grossProceedsUsd)) {
      throw new Error(
        `${LEDGER_REJECT.INVALID_PRICE}: exit price is too large to compute proceeds`
      );
    }

    this.#finalize(trade, exitPrice, grossProceedsUsd, reason);
    trade.lastPrice = exitPrice;
    return { ...trade };
  }

  /**
   * Unrealized PnL of one trade: what it would realize if closed right now at
   * its last price, after the entry fee already paid and the exit fee that would
   * apply. Returns 0 for a closed trade (its PnL is fully realized).
   */
  getUnrealizedPnlUsd(id) {
    const trade = this.#trades.get(id);
    if (!trade) {
      throw new Error(`Unknown trade id: ${id}`);
    }
    if (trade.status !== TRADE_STATUS.OPEN) {
      return 0;
    }
    return this.#markToMarket(trade).realizedPnlUsd;
  }

  /** Returns a copy of one trade record, or null if the id is unknown. */
  getTrade(id) {
    const trade = this.#trades.get(id);
    return trade ? { ...trade } : null;
  }

  getTrades() {
    return [...this.#trades.values()].map((trade) => ({ ...trade }));
  }

  getOpenTrades() {
    return this.getTrades().filter((trade) => trade.status === TRADE_STATUS.OPEN);
  }

  /**
   * balanceUsd / availableFundsUsd: cash not tied up in open positions.
   * dailyPnlUsd: REALIZED net PnL since the last resetDaily() (drives the daily loss limit).
   * totalRealizedPnlUsd: realized PnL of every closed trade, all time.
   * unrealizedPnlUsd: open trades marked at their last price (never counted as realized).
   * openCostBasisUsd: position size plus entry fees of open trades.
   * equityUsd: cash plus what the open trades would return net of the exit fee.
   */
  getSummary() {
    const state = this.riskManager.getState();
    let closedTrades = 0;
    let wins = 0;
    let losses = 0;
    let breakEvens = 0;
    let totalRealizedPnlUsd = 0;
    let unrealizedPnlUsd = 0;
    let openCostBasisUsd = 0;
    let openMarketValueUsd = 0;

    for (const trade of this.#trades.values()) {
      if (trade.status === TRADE_STATUS.CLOSED) {
        closedTrades += 1;
        totalRealizedPnlUsd += trade.realizedPnlUsd;
        if (trade.outcome === TRADE_OUTCOME.WIN) wins += 1;
        else if (trade.outcome === TRADE_OUTCOME.LOSS) losses += 1;
        else breakEvens += 1;
      } else {
        const mark = this.#markToMarket(trade);
        unrealizedPnlUsd += mark.realizedPnlUsd;
        openMarketValueUsd += mark.netProceedsUsd;
        openCostBasisUsd += trade.sizeUsd + trade.entryFeeUsd;
      }
    }

    return {
      balanceUsd: state.balanceUsd,
      availableFundsUsd: state.balanceUsd,
      dailyPnlUsd: state.dailyPnlUsd,
      totalRealizedPnlUsd: roundUsd(totalRealizedPnlUsd),
      unrealizedPnlUsd: roundUsd(unrealizedPnlUsd),
      openCostBasisUsd: roundUsd(openCostBasisUsd),
      equityUsd: roundUsd(state.balanceUsd + openMarketValueUsd),
      openTrades: state.openPositions,
      closedTrades,
      wins,
      losses,
      breakEvens,
    };
  }

  /**
   * Cross-checks the ledger against the risk manager. Returns { ok, errors }.
   *  - cash = starting balance + realized PnL - cost basis of open trades
   *  - equity = starting balance + realized PnL + unrealized PnL
   *  - open trades in the ledger = open positions in the risk manager
   *  - every OPEN trade has a risk manager position, and no CLOSED trade does
   */
  verifyConsistency() {
    const errors = [];
    const summary = this.getSummary();
    const start = this.riskManager.config.startingBalanceUsd;
    const near = (a, b) => Math.abs(a - b) <= CONSISTENCY_TOLERANCE;

    const expectedCash = start + summary.totalRealizedPnlUsd - summary.openCostBasisUsd;
    if (!near(summary.availableFundsUsd, expectedCash)) {
      errors.push(
        'available funds do not equal starting balance + realized PnL - open cost basis'
      );
    }

    const expectedEquity = start + summary.totalRealizedPnlUsd + summary.unrealizedPnlUsd;
    if (!near(summary.equityUsd, expectedEquity)) {
      errors.push('equity does not equal starting balance + realized PnL + unrealized PnL');
    }

    let openInLedger = 0;
    for (const trade of this.#trades.values()) {
      const isOpen = trade.status === TRADE_STATUS.OPEN;
      if (isOpen) openInLedger += 1;
      const hasPosition = this.riskManager.getPosition(trade.id) !== null;
      if (isOpen !== hasPosition) {
        errors.push(`trade ${trade.id}: ledger status and risk manager position disagree`);
      }
    }
    if (openInLedger !== this.riskManager.openPositionCount) {
      errors.push('open trades in the ledger do not match open positions in the risk manager');
    }

    return { ok: errors.length === 0, errors };
  }

  /** Call at the start of a new trading day. */
  resetDaily() {
    this.riskManager.resetDaily();
  }

  // --- internal helpers ---

  #getOpenTrade(id) {
    const trade = this.#trades.get(id);
    if (!trade) {
      throw new Error(`Unknown trade id: ${id}`);
    }
    if (trade.status !== TRADE_STATUS.OPEN) {
      throw new Error(`Trade ${id} is already closed`);
    }
    return trade;
  }

  #markToMarket(trade) {
    const grossProceedsUsd = roundUsd(trade.sizeUsd * (trade.lastPrice / trade.entryPrice));
    return this.riskManager.previewClose(trade.id, grossProceedsUsd);
  }

  // The risk manager is updated first. If it throws, the record is left untouched,
  // so the ledger and the simulated balance can never disagree.
  #finalize(trade, exitPrice, grossProceedsUsd, reason) {
    const settlement = this.riskManager.previewClose(trade.id, grossProceedsUsd);
    const realizedPnlUsd = this.riskManager.closePosition(
      trade.id,
      grossProceedsUsd,
      this.#token
    );

    trade.exitPrice = exitPrice;
    trade.grossProceedsUsd = settlement.grossProceedsUsd;
    trade.exitFeeUsd = settlement.exitFeeUsd;
    trade.proceedsUsd = settlement.netProceedsUsd;
    trade.realizedPnlUsd = realizedPnlUsd;
    trade.outcome = classifyOutcome(realizedPnlUsd);
    trade.status = TRADE_STATUS.CLOSED;
    trade.closeReason = reason;
    trade.closedAt = this.now();
  }
}

export default TradeLedger;