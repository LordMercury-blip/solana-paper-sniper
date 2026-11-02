// Strategy-driven paper-trading simulation on FABRICATED mock tokens.
//
// TIMING (all indices are LOCAL to a token: 0 is the first tick it appears in the feed):
//   1. The bot records price and activity from local index 0.
//   2. A token becomes eligible at index d = firstEligibleIndex(strategy, age): the later of
//      "observationTicks of history" and "minimum age reached" (see strategy-config.js).
//   3. At tick d the strategy decides using ONLY history up to and including index d.
//   4. If APPROVED, the order executes at the NEXT tick, d + 1, at that tick's price. The
//      strategy never saw that price, so there is no look-ahead. One tick is the latency.
//   5. At tick d + 1 the entry is requested through ledger.canOpenTrade() and then
//      ledger.openTrade(). The risk manager is the final authority: it can still reject the
//      entry, and a rejection creates no position and leaves the balance untouched.
//   6. Take-profit and stop-loss levels come from the actual entry price (d + 1), never from
//      the token's earlier launch price.
//
// Within one tick, tokens are processed in list order. For each token: (a) execute a pending
// entry, or update the open position, (b) evaluate if eligible, (c) handle end of feed.
//
// Safety: mock tokens only; the risk manager is bound to the ledger so nothing here can open
// or close a position any other way; stop-loss only runs if the config enables it; the clock
// is the simulation tick, so identical inputs give identical results.

import defaultConfig from './config.js';
import { RiskManager } from './risk-manager.js';
import { TradeLedger, TRADE_STATUS, CLOSE_REASON } from './trade-ledger.js';
import { evaluateEntry, DECISION } from './entry-checks.js';
import { firstEligibleIndex, validateStrategyConfig } from './strategy-config.js';
import { DATA_SOURCE } from './mock-attributes.js';

export const STRATEGY_EVENT = Object.freeze({
  PRICE: 'PRICE',
  DECISION: 'DECISION',
  ENTRY: 'ENTRY',
  ENTRY_REJECTED: 'ENTRY_REJECTED',
  NO_EXECUTION: 'NO_EXECUTION',
  EXIT: 'EXIT',
});

function validateStrategyTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('tokens must be a non-empty array of strategy tokens');
  }
  const seen = new Set();
  for (const token of tokens) {
    if (token === null || typeof token !== 'object') throw new Error('each token must be an object');
    if (token.mock !== true || token.dataSource !== DATA_SOURCE) {
      throw new Error('Only fabricated mock tokens are supported (use createStrategyToken)');
    }
    if (typeof token.symbol !== 'string' || !token.symbol.startsWith('MOCK-')) {
      throw new Error('token symbols must start with "MOCK-"');
    }
    if (seen.has(token.symbol)) throw new Error(`Duplicate token symbol: ${token.symbol}`);
    seen.add(token.symbol);
    if (!Number.isInteger(token.startTick) || token.startTick < 0) {
      throw new Error(`${token.symbol}: startTick must be a non-negative integer`);
    }
    if (!Array.isArray(token.prices) || token.prices.length < 2) {
      throw new Error(`${token.symbol}: prices must be an array with at least 2 prices`);
    }
    if (!token.prices.every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0)) {
      throw new Error(`${token.symbol}: prices must be finite numbers >= 0`);
    }
    for (const key of ['buys', 'sells']) {
      if (token[key] !== null && (!Array.isArray(token[key]) || token[key].length !== token.prices.length)) {
        throw new Error(`${token.symbol}: ${key} must be null or an array as long as prices`);
      }
    }
    if (token.attributes === null || typeof token.attributes !== 'object') {
      throw new Error(`${token.symbol}: attributes must be an object`);
    }
  }
}

/**
 * Runs one strategy simulation on a fresh ledger and returns plain data (no functions).
 *
 * closeOpenAtEnd (default true): when a token's feed ends, a still-open trade is closed at the
 * last price with the explicit reason FEED_ENDED. Set false to leave positions open and show
 * their unrealized PnL. An open position is never silently counted as a closed loss.
 */
export function runStrategySimulation({
  tokens,
  strategy,
  config = defaultConfig,
  closeOpenAtEnd = true,
  label = 'strategy simulation',
} = {}) {
  validateStrategyTokens(tokens);
  validateStrategyConfig(strategy);

  let tick = 0;
  const ledger = new TradeLedger(new RiskManager(config), () => tick);
  const rmConfig = ledger.riskManager.config;
  const order = { sizeUsd: rmConfig.positionSizeUsd, takeProfitMultiplier: rmConfig.takeProfitMultiplier };

  const events = [];
  let peakOpenPositions = 0;
  const states = new Map(
    tokens.map((t) => [
      t.symbol,
      {
        firstEligible: firstEligibleIndex(strategy, t.attributes.ageAtFirstSeenTicks),
        evaluated: false,
        pendingEntry: false,
        tradeId: null,
        decision: null,
      },
    ])
  );

  const lastTick = Math.max(...tokens.map((t) => t.startTick + t.prices.length - 1));

  const exitEvent = (symbol, trade) => ({
    tick,
    type: STRATEGY_EVENT.EXIT,
    symbol,
    tradeId: trade.id,
    reason: trade.closeReason,
    forced: trade.closeReason === CLOSE_REASON.FEED_ENDED,
    exitPrice: trade.exitPrice,
    realizedPnlUsd: trade.realizedPnlUsd,
    outcome: trade.outcome,
  });

  function evaluate(token, state, local, sub) {
    const history = {
      prices: token.prices.slice(0, local + 1),
      buys: token.buys === null ? null : token.buys.slice(0, local + 1),
      sells: token.sells === null ? null : token.sells.slice(0, local + 1),
    };
    const evaluation = evaluateEntry({ history, attributes: token.attributes, strategy, order });
    state.evaluated = true;
    state.decision = {
      symbol: token.symbol,
      scenario: token.scenario ?? null,
      archetype: token.archetype ?? null,
      status: local >= state.firstEligible ? 'EVALUATED' : 'NOT_ELIGIBLE_BEFORE_FEED_END',
      firstEligibleIndex: state.firstEligible,
      decisionTick: tick,
      decisionIndex: local,
      strategyDecision: evaluation.decision,
      mandatoryStatus: evaluation.mandatoryStatus,
      signalsPassed: evaluation.signalsPassed,
      signalsRequired: evaluation.signalsRequired,
      reasons: evaluation.reasons,
      checks: evaluation.checks,
      entryRequested: false,
      riskDecision: 'NOT_REQUESTED',
      riskReason: null,
      riskMessage: null,
      executionTick: null,
      entryPrice: null,
      tradeId: null,
      noExecutionReason: null,
    };
    sub.push({
      tick,
      type: STRATEGY_EVENT.DECISION,
      symbol: token.symbol,
      decisionIndex: local,
      strategyDecision: evaluation.decision,
      reasons: evaluation.reasons,
    });
    if (evaluation.decision === DECISION.APPROVED) {
      state.pendingEntry = true;
      state.decision.entryRequested = true;
      state.decision.riskDecision = 'PENDING';
    }
  }

  for (tick = 0; tick <= lastTick; tick += 1) {
    for (const token of tokens) {
      const local = tick - token.startTick;
      if (local < 0 || local >= token.prices.length) continue;

      const { symbol } = token;
      const state = states.get(symbol);
      const price = token.prices[local];
      const isLast = local === token.prices.length - 1;
      const sub = [];
      let position = 'NONE';
      let unrealizedPnlUsd = null;

      // (a) execute a pending entry, or update the open position
      if (state.pendingEntry) {
        state.pendingEntry = false;
        const check = ledger.canOpenTrade(price);
        state.decision.executionTick = tick;
        if (!check.allowed) {
          state.decision.riskDecision = 'REJECTED';
          state.decision.riskReason = check.reason;
          state.decision.riskMessage = check.message;
          sub.push({ tick, type: STRATEGY_EVENT.ENTRY_REJECTED, symbol, price, reason: check.reason, message: check.message });
        } else {
          const trade = ledger.openTrade(price);
          state.tradeId = trade.id;
          state.decision.riskDecision = 'ACCEPTED';
          state.decision.entryPrice = price;
          state.decision.tradeId = trade.id;
          position = 'OPEN';
          unrealizedPnlUsd = ledger.getUnrealizedPnlUsd(trade.id);
          sub.push({
            tick,
            type: STRATEGY_EVENT.ENTRY,
            symbol,
            tradeId: trade.id,
            price,
            launchPrice: token.prices[0],
            sizeUsd: trade.sizeUsd,
            entryFeeUsd: trade.entryFeeUsd,
            takeProfitPrice: trade.takeProfitPrice,
            stopLossPrice: trade.stopLossPrice,
          });
        }
      } else if (state.tradeId !== null) {
        if (ledger.getTrade(state.tradeId).status === TRADE_STATUS.OPEN) {
          const update = ledger.updatePrice(state.tradeId, price);
          position = update.closed ? 'CLOSED' : 'OPEN';
          unrealizedPnlUsd = update.closed ? null : ledger.getUnrealizedPnlUsd(state.tradeId);
          if (update.closed) sub.push(exitEvent(symbol, update.trade));
        } else {
          position = 'CLOSED'; // the price keeps moving; the ledger is never touched again
        }
      }

      // (b) evaluate once, at the first eligible tick, using history up to this tick only
      if (!state.evaluated && local >= state.firstEligible) {
        evaluate(token, state, local, sub);
      }

      // (c) end of this token's feed
      if (isLast) {
        if (!state.evaluated) {
          evaluate(token, state, local, sub); // never became eligible: recorded as such
        }
        if (state.pendingEntry) {
          state.pendingEntry = false;
          state.decision.riskDecision = 'NOT_REQUESTED';
          state.decision.noExecutionReason = 'NO_NEXT_PRICE';
          sub.push({ tick, type: STRATEGY_EVENT.NO_EXECUTION, symbol, reason: 'NO_NEXT_PRICE' });
        }
        if (
          closeOpenAtEnd &&
          state.tradeId !== null &&
          ledger.getTrade(state.tradeId).status === TRADE_STATUS.OPEN
        ) {
          const closed = ledger.closeTrade(state.tradeId, price, CLOSE_REASON.FEED_ENDED);
          position = 'CLOSED';
          unrealizedPnlUsd = null;
          sub.push(exitEvent(symbol, closed));
        }
      }

      events.push({ tick, type: STRATEGY_EVENT.PRICE, symbol, price, position, unrealizedPnlUsd }, ...sub);
      peakOpenPositions = Math.max(peakOpenPositions, ledger.riskManager.openPositionCount);
    }
  }

  const decisions = tokens.map((t) => states.get(t.symbol).decision);
  const summary = ledger.getSummary();
  const count = (fn) => decisions.filter(fn).length;
  const symbolByTradeId = new Map(decisions.filter((d) => d.tradeId !== null).map((d) => [d.tradeId, d.symbol]));

  const openPositions = ledger.getOpenTrades().map((trade) => ({
    tradeId: trade.id,
    symbol: symbolByTradeId.get(trade.id),
    entryPrice: trade.entryPrice,
    lastPrice: trade.lastPrice,
    unrealizedPnlUsd: ledger.getUnrealizedPnlUsd(trade.id),
  }));

  return {
    simulated: true,
    entryPolicy: 'strategy',
    dataSource: DATA_SOURCE,
    label,
    strategy: { ...strategy },
    config: {
      startingBalanceUsd: rmConfig.startingBalanceUsd,
      positionSizeUsd: rmConfig.positionSizeUsd,
      maxOpenPositions: rmConfig.maxOpenPositions,
      takeProfitMultiplier: rmConfig.takeProfitMultiplier,
      dailyLossLimitUsd: rmConfig.dailyLossLimitUsd,
      stopLossEnabled: rmConfig.stopLossEnabled,
      stopLossFraction: rmConfig.stopLossFraction,
      tradingFeeRate: rmConfig.tradingFeeRate,
    },
    closeOpenAtEnd,
    tokens: tokens.map((t) => ({
      symbol: t.symbol,
      scenario: t.scenario ?? null,
      archetype: t.archetype ?? null,
      seed: t.seed ?? null,
      startTick: t.startTick,
      priceCount: t.prices.length,
      launchPrice: t.prices[0],
      attributes: { ...t.attributes },
    })),
    lastTick,
    events,
    decisions,
    trades: ledger.getTrades(),
    openPositions,
    openTradesAtEnd: openPositions.length,
    peakOpenPositions,
    counts: {
      tokens: tokens.length,
      strategyApproved: count((d) => d.strategyDecision === DECISION.APPROVED),
      strategyRejected: count((d) => d.strategyDecision === DECISION.REJECTED),
      strategyBlocked: count((d) => d.strategyDecision === DECISION.BLOCKED),
      strategyNoSignal: count((d) => d.strategyDecision === DECISION.NO_SIGNAL),
      entriesAccepted: count((d) => d.riskDecision === 'ACCEPTED'),
      entriesRejectedByRisk: count((d) => d.riskDecision === 'REJECTED'),
      noExecutionPrice: count((d) => d.noExecutionReason === 'NO_NEXT_PRICE'),
      closedTrades: summary.closedTrades,
      wins: summary.wins,
      losses: summary.losses,
      breakEvens: summary.breakEvens,
      forcedFeedEndClosures: ledger
        .getTrades()
        .filter((t) => t.closeReason === CLOSE_REASON.FEED_ENDED).length,
      netRealizedPnlUsd: summary.totalRealizedPnlUsd,
    },
    summary,
    consistency: ledger.verifyConsistency(),
  };
}