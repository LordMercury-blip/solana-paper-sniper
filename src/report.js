// Plain-text reports for simulation results. Pure formatting: no I/O, no randomness.

import { EVENT_TYPE } from './simulator.js';

export const SIMULATION_BANNER =
  '*** SIMULATED PRICES AND PAPER TRADES ONLY: mock tokens, fake prices, no real market data, no real money ***';

function usd(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const text = abs.toFixed(2);
  return `${sign}$${text === '0.00' && abs !== 0 ? abs.toFixed(4) : text}`;
}

function pnl(value) {
  return value > 0 ? `+${usd(value)}` : usd(value);
}

function price(value) {
  return value.toFixed(8);
}

function pct(fraction) {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

function formatEvent(event, symbolWidth) {
  const head = `tick ${String(event.tick).padStart(3)} | ${event.symbol.padEnd(symbolWidth)} | `;

  switch (event.type) {
    case EVENT_TYPE.PRICE: {
      let position = 'no position';
      if (event.position === 'OPEN') {
        position = `position open, unrealized ${pnl(event.unrealizedPnlUsd)}`;
      } else if (event.position === 'CLOSED') {
        position = 'position closed';
      }
      return `${head}price ${price(event.price)} | ${position}`;
    }
    case EVENT_TYPE.ENTRY: {
      const stop = event.stopLossPrice === null ? 'OFF' : price(event.stopLossPrice);
      return (
        `${head}ENTRY paper trade #${event.tradeId}: size ${usd(event.sizeUsd)} at ${price(event.price)}` +
        ` | take-profit ${price(event.takeProfitPrice)} | stop-loss ${stop}`
      );
    }
    case EVENT_TYPE.ENTRY_REJECTED:
      return `${head}ENTRY REJECTED (${event.reason}): ${event.message}`;
    case EVENT_TYPE.EXIT: {
      const how = event.endOfFeed ? `${event.reason} (feed ended, manual close)` : event.reason;
      return (
        `${head}EXIT paper trade #${event.tradeId}: ${how} at ${price(event.exitPrice)}` +
        ` | realized ${pnl(event.realizedPnlUsd)} (${event.outcome})`
      );
    }
    default:
      return `${head}${event.type}`;
  }
}

/** Builds the full text report for one simulation result. */
export function formatReport(result, { showPrices = true } = {}) {
  const c = result.config;
  const s = result.summary;
  const rule = '='.repeat(78);
  const lines = [];

  lines.push(rule, ` SIMULATION: ${result.label}`, ` ${SIMULATION_BANNER}`, rule);

  const stop = c.stopLossEnabled ? `ON (exit after a ${pct(c.stopLossFraction)} loss)` : 'OFF';
  lines.push(
    `Settings: start ${usd(c.startingBalanceUsd)} | size ${usd(c.positionSizeUsd)} | max open ${c.maxOpenPositions}` +
      ` | take-profit ${c.takeProfitMultiplier}x | daily loss limit ${usd(c.dailyLossLimitUsd)}`
  );
  lines.push(
    `          stop-loss ${stop} | simulated costs ${pct(c.tradingFeeRate)} per side` +
      ` | at end of feed: ${result.closeOpenAtEnd ? 'close open positions' : 'leave positions open'}`
  );

  lines.push('', 'Mock tokens (fake):');
  for (const token of result.tokens) {
    const seed = token.scenario === 'random-walk' ? `, seed ${token.seed}` : '';
    lines.push(
      `  ${token.symbol}: scenario ${token.scenario ?? 'custom'}, ${token.priceCount} prices, launches at tick ${token.startTick}${seed}`
    );
  }

  const width = Math.max(...result.tokens.map((t) => t.symbol.length));
  lines.push('', 'Timeline (every price below is simulated):');
  for (const event of result.events) {
    if (event.type === EVENT_TYPE.PRICE && !showPrices) continue;
    lines.push(`  ${formatEvent(event, width)}`);
  }

  const symbolByTradeId = new Map();
  for (const event of result.events) {
    if (event.type === EVENT_TYPE.ENTRY) symbolByTradeId.set(event.tradeId, event.symbol);
  }
  const openById = new Map(result.openPositions.map((p) => [p.tradeId, p]));

  lines.push('', 'Paper trades:');
  if (result.trades.length === 0) {
    lines.push('  (none: no entry was accepted)');
  }
  for (const trade of result.trades) {
    const head = `  #${trade.id} ${symbolByTradeId.get(trade.id)} | entry ${price(trade.entryPrice)}`;
    if (trade.status === 'CLOSED') {
      lines.push(
        `${head} | CLOSED via ${trade.closeReason} at ${price(trade.exitPrice)}` +
          ` | realized ${pnl(trade.realizedPnlUsd)} (${trade.outcome})`
      );
    } else {
      const open = openById.get(trade.id);
      lines.push(
        `${head} | STILL OPEN at ${price(open.lastPrice)}` +
          ` | unrealized ${pnl(open.unrealizedPnlUsd)} (not realized, not counted toward the daily loss limit)`
      );
    }
  }

  lines.push(
    '',
    'Final results (simulated):',
    `  Realized PnL, all closed trades:  ${pnl(s.totalRealizedPnlUsd)}`,
    `  Unrealized PnL, open positions:   ${pnl(s.unrealizedPnlUsd)}`,
    `  Daily realized PnL:               ${pnl(s.dailyPnlUsd)}`,
    `  Balance (cash):                   ${usd(s.balanceUsd)}`,
    `  Equity (cash + open positions):   ${usd(s.equityUsd)}`,
    `  Open positions at end:            ${s.openTrades}`,
    `  Peak open positions:              ${result.peakOpenPositions} (max allowed ${c.maxOpenPositions})`,
    `  Closed trades:                    ${s.closedTrades} (${s.wins} won, ${s.losses} lost, ${s.breakEvens} break-even)`,
    `  Entries rejected by risk rules:   ${result.rejectedEntries}`,
    `  Ledger consistency check:         ${result.consistency.ok ? 'OK' : `FAILED: ${result.consistency.errors.join('; ')}`}`
  );

  return lines.join('\n');
}

function exitSummary(result) {
  const parts = result.events
    .filter((e) => e.type === EVENT_TYPE.EXIT)
    .map((e) => (e.endOfFeed ? `${e.reason} (feed ended)` : e.reason));
  if (result.openPositions.length > 0) parts.push(`${result.openPositions.length} still open`);
  if (parts.length === 0) return result.rejectedEntries > 0 ? 'entry rejected' : 'no trades';
  return parts.join(', ');
}

/** One-line-per-run comparison table for several simulation results. */
export function formatSummaryTable(results) {
  const headers = ['Run', 'Exit', 'Realized', 'Unrealized', 'Balance', 'Open'];
  const rows = results.map((r) => [
    r.label,
    exitSummary(r),
    pnl(r.summary.totalRealizedPnlUsd),
    pnl(r.summary.unrealizedPnlUsd),
    usd(r.summary.balanceUsd),
    String(r.summary.openTrades),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  return [
    'Summary of simulated runs:',
    `  ${fmt(headers)}`,
    `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`,
    ...rows.map((row) => `  ${fmt(row)}`),
  ].join('\n');
}