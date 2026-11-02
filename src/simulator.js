// Paper-trading simulator: feeds MOCK token prices into the existing TradeLedger.
//
// Safety properties:
//  - Mock tokens only (fake symbols, fake prices). Nothing here reads real market data.
//  - Every entry goes through ledger.canOpenTrade() and ledger.openTrade(), so the risk
//    manager always has the final say. A rejected entry is logged and never retried.
//  - The risk manager is bound to the ledger, so nothing in this file can open or close
//    a position behind the ledger's back.
//  - Stop-loss only runs if the config enables it. This file never turns it on.
//  - The clock is the simulation tick, so identical inputs give identical results.

import defaultConfig from './config.js';
import { RiskManager } from './risk-manager.js';
import { TradeLedger, TRADE_STATUS } from './trade-ledger.js';

export const EVENT_TYPE = Object.freeze({
  PRICE: 'PRICE',
  ENTRY: 'ENTRY',
  ENTRY_REJECTED: 'ENTRY_REJECTED',
  EXIT: 'EXIT',
});

function validateTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('tokens must be a non-empty array of mock tokens');
  }

  const seen = new Set();
  for (const token of tokens) {
    if (token === null || typeof token !== 'object') {
      throw new Error('each token must be an object');
    }
    if (token.mock !== true) {
      throw new Error('Only mock tokens are supported (use createMockToken)');
    }
    if (typeof token.symbol !== 'string' || token.symbol.length === 0) {
      throw new Error('each token needs a symbol');
    }
    if (seen.has(token.symbol)) {
      throw new Error(`Duplicate token symbol: ${token.symbol}`);
    }
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
  }
}

/**
 * Runs one simulation on a fresh ledger and returns plain data (no functions).
 *
 * Each token launches at its startTick. At its first price the "sniper" tries to
 * enter once; the ledger and risk manager accept or reject it. Later prices are fed
 * to ledger.updatePrice() for open trades. A token whose entry was rejected is never
 * traded afterwards.
 *
 * closeOpenAtEnd (default true): when a token's feed ends, any still-open trade is
 * closed manually at the last price. Set it to false to leave positions open and see
 * their unrealized PnL.
 */
export function runSimulation({
  tokens,
  config = defaultConfig,
  closeOpenAtEnd = true,
  label = 'simulation',
} = {}) {
  validateTokens(tokens);

  let tick = 0;
  const ledger = new TradeLedger(new RiskManager(config), () => tick);
  const events = [];
  const tradeIdBySymbol = new Map();
  let peakOpenPositions = 0;
  let rejectedEntries = 0;

  const lastTick = Math.max(...tokens.map((t) => t.startTick + t.prices.length - 1));

  const exitEvent = (symbol, trade, endOfFeed) => ({
    tick,
    type: EVENT_TYPE.EXIT,
    symbol,
    tradeId: trade.id,
    reason: trade.closeReason,
    endOfFeed,
    exitPrice: trade.exitPrice,
    realizedPnlUsd: trade.realizedPnlUsd,
    outcome: trade.outcome,
  });

  for (tick = 0; tick <= lastTick; tick += 1) {
    for (const token of tokens) {
      const local = tick - token.startTick;
      if (local < 0 || local >= token.prices.length) continue;

      const price = token.prices[local];
      const { symbol } = token;

      if (local === 0) {
        // Launch tick: one entry attempt, decided by the ledger and risk manager.
        events.push({ tick, type: EVENT_TYPE.PRICE, symbol, price, position: 'NONE', unrealizedPnlUsd: null });
        const check = ledger.canOpenTrade(price);
        if (!check.allowed) {
          rejectedEntries += 1;
          events.push({
            tick,
            type: EVENT_TYPE.ENTRY_REJECTED,
            symbol,
            price,
            reason: check.reason,
            message: check.message,
          });
        } else {
          const trade = ledger.openTrade(price);
          tradeIdBySymbol.set(symbol, trade.id);
          events.push({
            tick,
            type: EVENT_TYPE.ENTRY,
            symbol,
            tradeId: trade.id,
            price,
            sizeUsd: trade.sizeUsd,
            entryFeeUsd: trade.entryFeeUsd,
            takeProfitPrice: trade.takeProfitPrice,
            stopLossPrice: trade.stopLossPrice,
          });
        }
      } else {
        const tradeId = tradeIdBySymbol.get(symbol);
        const trade = tradeId === undefined ? null : ledger.getTrade(tradeId);

        if (trade === null) {
          events.push({ tick, type: EVENT_TYPE.PRICE, symbol, price, position: 'NONE', unrealizedPnlUsd: null });
        } else if (trade.status !== TRADE_STATUS.OPEN) {
          // Already closed: the price keeps moving but the ledger is never touched again.
          events.push({ tick, type: EVENT_TYPE.PRICE, symbol, price, position: 'CLOSED', unrealizedPnlUsd: null });
        } else {
          const update = ledger.updatePrice(tradeId, price);
          events.push({
            tick,
            type: EVENT_TYPE.PRICE,
            symbol,
            price,
            position: update.closed ? 'CLOSED' : 'OPEN',
            unrealizedPnlUsd: update.closed ? null : ledger.getUnrealizedPnlUsd(tradeId),
          });
          if (update.closed) {
            events.push(exitEvent(symbol, update.trade, false));
          }
        }
      }

      const isLastPrice = local === token.prices.length - 1;
      const openId = tradeIdBySymbol.get(symbol);
      if (
        isLastPrice &&
        closeOpenAtEnd &&
        openId !== undefined &&
        ledger.getTrade(openId).status === TRADE_STATUS.OPEN
      ) {
        events.push(exitEvent(symbol, ledger.closeTrade(openId, price), true));
      }

      peakOpenPositions = Math.max(peakOpenPositions, ledger.riskManager.openPositionCount);
    }
  }

  const symbolByTradeId = new Map();
  for (const [symbol, id] of tradeIdBySymbol) symbolByTradeId.set(id, symbol);

  const openPositions = ledger.getOpenTrades().map((trade) => ({
    tradeId: trade.id,
    symbol: symbolByTradeId.get(trade.id),
    entryPrice: trade.entryPrice,
    lastPrice: trade.lastPrice,
    unrealizedPnlUsd: ledger.getUnrealizedPnlUsd(trade.id),
  }));

  const cfg = ledger.riskManager.config;
  return {
    simulated: true,
    label,
    config: {
      startingBalanceUsd: cfg.startingBalanceUsd,
      positionSizeUsd: cfg.positionSizeUsd,
      maxOpenPositions: cfg.maxOpenPositions,
      takeProfitMultiplier: cfg.takeProfitMultiplier,
      dailyLossLimitUsd: cfg.dailyLossLimitUsd,
      stopLossEnabled: cfg.stopLossEnabled,
      stopLossFraction: cfg.stopLossFraction,
      tradingFeeRate: cfg.tradingFeeRate,
    },
    closeOpenAtEnd,
    tokens: tokens.map((token) => ({
      symbol: token.symbol,
      scenario: token.scenario ?? null,
      seed: token.seed ?? null,
      basePrice: token.basePrice ?? token.prices[0],
      startTick: token.startTick,
      priceCount: token.prices.length,
    })),
    lastTick,
    events,
    trades: ledger.getTrades(),
    openPositions,
    openTradesAtEnd: openPositions.length,
    peakOpenPositions,
    rejectedEntries,
    summary: ledger.getSummary(),
    consistency: ledger.verifyConsistency(),
  };
}