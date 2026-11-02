// Plain-text reports for strategy simulations. Pure formatting: no I/O, no randomness.

import { STRATEGY_EVENT } from './strategy-simulator.js';
import { SIGNAL_COUNT } from './strategy-config.js';

export const STRATEGY_BANNER = [
  '*** FABRICATED MOCK DATA ONLY: every token, attribute, price and trade count below is invented for testing. ***',
  '*** Nothing here is real blockchain data. Passing these checks says nothing about the safety of any real token. ***',
];

function usd(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const text = abs.toFixed(2);
  return `${sign}$${text === '0.00' && abs !== 0 ? abs.toFixed(4) : text}`;
}
const pnl = (value) => (value > 0 ? `+${usd(value)}` : usd(value));
const price = (value) => value.toFixed(8);
const pctText = (fraction) => `${Number((fraction * 100).toFixed(4))}%`;
const money = (value) => (typeof value === 'number' ? `$${value.toLocaleString('en-US')}` : 'MISSING');
const show = (value) => (value === null || value === undefined ? 'MISSING' : String(value));

function formatAttributes(a) {
  const flags = Array.isArray(a.permissionFlags)
    ? a.permissionFlags.length === 0 ? 'none' : a.permissionFlags.join(', ')
    : 'MISSING';
  const holder = (v) => (typeof v === 'number' ? `${v}%` : 'MISSING');
  return [
    `  mint authority ${show(a.mintAuthority)} | freeze authority ${show(a.freezeAuthority)} | permission flags ${flags}`,
    `  top holder ${holder(a.topHolderPct)} | top-10 holders ${holder(a.top10HolderPct)} | liquidity ${money(a.liquidityUsd)} | quote-side reserve ${money(a.quoteReserveUsd)}`,
    `  simulated sell ${show(a.sellSimulation)} | age when first seen ${show(a.ageAtFirstSeenTicks)} ticks`,
  ];
}

function thresholdLines(s) {
  return [
    `  observation ${s.observationTicks} ticks | min age ${s.minAgeTicks} ticks | signals required ${s.minSignalsPassed} of ${SIGNAL_COUNT}`,
    `  mint/freeze revoked ${s.requireMintAuthorityRevoked}/${s.requireFreezeAuthorityRevoked} | sellable required ${s.requireSellable} | allowed permission flags ${s.allowedPermissionFlags.length === 0 ? 'none' : s.allowedPermissionFlags.join(', ')}`,
    `  max top holder ${s.maxTopHolderPct}% | max top-10 ${s.maxTop10HolderPct}% | min liquidity ${money(s.minLiquidityUsd)} | max price impact ${s.maxPriceImpactBps} bps`,
    `  max single-tick rise ${s.maxSingleTickRisePct}% | max rise since launch ${s.maxRiseSinceLaunchPct}% | max single-tick drop ${s.maxSingleTickDropPct}% | max drawdown ${s.maxDrawdownFromHighPct}%`,
    `  min momentum ${s.minMomentumPct}% | min buy share ${s.minBuySharePct}% | min trades in window ${s.minTradesInWindow}`,
  ];
}

function groupLabel(check) {
  if (check.category === 'SIGNAL') return 'SIGNAL';
  return check.group === 'PROCESS' ? 'MANDATORY-PROCESS' : check.group === 'TOKEN_SAFETY' ? 'MANDATORY-SAFETY' : 'MANDATORY-MARKET';
}

function formatDecisionBlock(result, decision, tokenInfo, trade, open, { quiet, explain }) {
  const lines = [];
  lines.push(`--- ${tokenInfo.symbol} (scenario ${tokenInfo.scenario ?? 'custom'}, archetype ${tokenInfo.archetype ?? 'custom'}) ---`);
  lines.push('FABRICATED attributes (not blockchain data):', ...formatAttributes(tokenInfo.attributes));

  const d = decision;
  const eligibleTick = tokenInfo.startTick + d.firstEligibleIndex;
  lines.push(
    `Timing: launches at tick ${tokenInfo.startTick}; first eligible tick ${eligibleTick} (local index ${d.firstEligibleIndex});` +
      ` decision uses data up to that tick only; an approved entry would execute at tick ${eligibleTick + 1} at that tick's price`
  );
  if (d.status === 'NOT_ELIGIBLE_BEFORE_FEED_END') {
    lines.push(`  The feed ended at tick ${d.decisionTick} before the token became eligible, so the checks below ran on the history that existed.`);
  }

  const nonPass = d.checks.filter((c) => c.status !== 'PASS');
  const shown = quiet ? nonPass : d.checks;
  lines.push(`Checks at tick ${d.decisionTick} (SIMULATED from fabricated data${quiet ? `; ${d.checks.length - nonPass.length} passing checks hidden` : ''}):`);
  for (const check of shown) {
    lines.push(`  [${groupLabel(check).padEnd(17)}] ${check.id.padEnd(22)} ${check.status.padEnd(7)} ${check.detail}`);
    if (explain) lines.push(`      real version would need: ${check.futureRealCheck}`);
  }

  const reasons = d.reasons.length > 0 ? ` (${d.reasons.join(', ')})` : '';
  const signalsText =
    d.mandatoryStatus === 'PASS'
      ? `signals ${d.signalsPassed} of ${d.signalsRequired} required passed`
      : `signals: ${d.signalsPassed} passing, not counted because a mandatory check did not pass`;
  lines.push(`Strategy decision: ${d.strategyDecision}${reasons} | mandatory ${d.mandatoryStatus} | ${signalsText}`);

  if (d.riskDecision === 'ACCEPTED') {
    lines.push(`Risk manager: ACCEPTED the entry at tick ${d.executionTick}`);
  } else if (d.riskDecision === 'REJECTED') {
    lines.push(`Risk manager: REJECTED the entry at tick ${d.executionTick}: ${d.riskReason} (${d.riskMessage}). No position was created and the balance is unchanged.`);
  } else if (d.noExecutionReason) {
    lines.push(`Risk manager: not asked. The feed had no price after the decision tick (${d.noExecutionReason}), so no entry was attempted.`);
  } else {
    lines.push('Risk manager: not asked (the strategy did not approve an entry)');
  }

  if (trade) {
    const stop = trade.stopLossPrice === null ? 'OFF' : price(trade.stopLossPrice);
    lines.push(
      `Trade #${trade.id}: entry ${price(trade.entryPrice)} at tick ${trade.openedAt} (launch price was ${price(tokenInfo.launchPrice)})` +
        ` | take-profit ${price(trade.takeProfitPrice)} | stop-loss ${stop}`
    );
    if (trade.status === 'CLOSED') {
      const forced = trade.closeReason === 'FEED_ENDED' ? ' (FORCED close because the feed ended, not a strategy exit)' : '';
      lines.push(
        `  EXIT ${trade.closeReason}${forced} at ${price(trade.exitPrice)} at tick ${trade.closedAt}` +
          ` | realized ${pnl(trade.realizedPnlUsd)} (${trade.outcome})`
      );
    } else {
      lines.push(`  STILL OPEN at ${price(open.lastPrice)} | unrealized ${pnl(open.unrealizedPnlUsd)} (not realized, not counted toward the daily loss limit)`);
    }
  }
  return lines;
}

/** Full text report for one strategy simulation result. */
export function formatStrategyReport(result, { timeline = false, quiet = false, explain = false } = {}) {
  const c = result.config;
  const s = result.summary;
  const n = result.counts;
  const rule = '='.repeat(100);
  const lines = [rule, ` STRATEGY SIMULATION: ${result.label}`, ...STRATEGY_BANNER.map((b) => ` ${b}`), rule];

  lines.push(`Strategy profile: ${result.strategy.profile ?? 'custom'}`, ...thresholdLines(result.strategy));
  lines.push(
    `Ledger: start ${usd(c.startingBalanceUsd)} | size ${usd(c.positionSizeUsd)} | max open ${c.maxOpenPositions}` +
      ` | take-profit ${c.takeProfitMultiplier}x | daily loss limit ${usd(c.dailyLossLimitUsd)}` +
      ` | stop-loss ${c.stopLossEnabled ? `ON (${pctText(c.stopLossFraction)} loss)` : 'OFF'}` +
      ` | simulated costs ${pctText(c.tradingFeeRate)} per side` +
      ` | end of feed: ${result.closeOpenAtEnd ? 'force-close open positions (FEED_ENDED)' : 'leave positions open'}`
  );

  const tradeById = new Map(result.trades.map((t) => [t.id, t]));
  const openById = new Map(result.openPositions.map((p) => [p.tradeId, p]));
  result.tokens.forEach((tokenInfo, i) => {
    const decision = result.decisions[i];
    const trade = decision.tradeId === null ? null : tradeById.get(decision.tradeId);
    const open = trade ? openById.get(trade.id) : null;
    lines.push('', ...formatDecisionBlock(result, decision, tokenInfo, trade, open, { quiet, explain }));
  });

  if (timeline) {
    lines.push('', 'Timeline (every price below is simulated):');
    const width = Math.max(...result.tokens.map((t) => t.symbol.length));
    for (const e of result.events) {
      const head = `  tick ${String(e.tick).padStart(3)} | ${e.symbol.padEnd(width)} | `;
      if (e.type === STRATEGY_EVENT.PRICE) {
        const where = e.position === 'OPEN' ? `position open, unrealized ${pnl(e.unrealizedPnlUsd)}` : e.position === 'CLOSED' ? 'position closed' : 'no position';
        lines.push(`${head}price ${price(e.price)} | ${where}`);
      } else if (e.type === STRATEGY_EVENT.DECISION) {
        lines.push(`${head}DECISION ${e.strategyDecision}${e.reasons.length ? ` (${e.reasons.join(', ')})` : ''}`);
      } else if (e.type === STRATEGY_EVENT.ENTRY) {
        lines.push(`${head}ENTRY paper trade #${e.tradeId} at ${price(e.price)}`);
      } else if (e.type === STRATEGY_EVENT.ENTRY_REJECTED) {
        lines.push(`${head}ENTRY REJECTED by risk manager (${e.reason})`);
      } else if (e.type === STRATEGY_EVENT.NO_EXECUTION) {
        lines.push(`${head}NO ENTRY (${e.reason})`);
      } else if (e.type === STRATEGY_EVENT.EXIT) {
        lines.push(`${head}EXIT paper trade #${e.tradeId} ${e.reason}${e.forced ? ' (forced, feed ended)' : ''} at ${price(e.exitPrice)} | realized ${pnl(e.realizedPnlUsd)} (${e.outcome})`);
      }
    }
  }

  lines.push(
    '',
    'Run results (simulated):',
    `  Strategy decisions:   ${n.strategyApproved} approved | ${n.strategyRejected} rejected by filters | ${n.strategyBlocked} blocked (unknown critical data) | ${n.strategyNoSignal} no signal`,
    `  Risk manager:         ${n.entriesAccepted} entries accepted | ${n.entriesRejectedByRisk} entries rejected | ${n.noExecutionPrice} with no execution price`,
    `  Closed positions:     ${n.closedTrades} (${n.wins} won, ${n.losses} lost, ${n.breakEvens} break-even) | forced end-of-feed closures: ${n.forcedFeedEndClosures}`,
    `  Net realized PnL:     ${pnl(s.totalRealizedPnlUsd)}`,
    `  Unrealized PnL:       ${pnl(s.unrealizedPnlUsd)} (open positions only)`,
    `  Balance (cash):       ${usd(s.balanceUsd)} | equity ${usd(s.equityUsd)}`,
    `  Open positions:       ${s.openTrades} at end | peak ${result.peakOpenPositions} (max allowed ${c.maxOpenPositions})`,
    `  Ledger consistency:   ${result.consistency.ok ? 'OK' : `FAILED: ${result.consistency.errors.join('; ')}`}`
  );
  return lines.join('\n');
}

function runSummary(result) {
  const d = result.decisions;
  if (result.tokens.length === 1) {
    const dec = d[0];
    const risk = dec.riskDecision === 'REJECTED' ? `REJECTED (${dec.riskReason})` : dec.riskDecision === 'ACCEPTED' ? 'ACCEPTED' : '-';
    const exit = result.trades.length === 0
      ? '-'
      : result.trades[0].status === 'CLOSED'
        ? result.trades[0].closeReason
        : 'STILL OPEN';
    const why = dec.reasons.length > 0 ? ` (${dec.reasons.join(',')})` : '';
    return [`${dec.strategyDecision}${why}`, risk, exit];
  }
  const n = result.counts;
  return [`${n.strategyApproved} approved of ${n.tokens}`, `${n.entriesAccepted} ok / ${n.entriesRejectedByRisk} rej`, `${n.closedTrades} closed`];
}

/** Comparison table, one row per run. */
export function formatStrategySummaryTable(results) {
  const headers = ['Run', 'Strategy decision', 'Risk manager', 'Exit', 'Realized', 'Unrealized', 'Balance', 'Open'];
  const rows = results.map((r) => {
    const [decision, risk, exit] = runSummary(r);
    return [r.label, decision, risk, exit, pnl(r.summary.totalRealizedPnlUsd), pnl(r.summary.unrealizedPnlUsd), usd(r.summary.balanceUsd), String(r.summary.openTrades)];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [
    'Summary of simulated runs (each on its own fresh $10 ledger unless stated):',
    `  ${fmt(headers)}`,
    `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`,
    ...rows.map((row) => `  ${fmt(row)}`),
  ].join('\n');
}

/** Totals across independent runs. Each run had its own ledger, so these are sums, not a portfolio. */
export function formatStrategyTotals(results) {
  const sum = (key) => results.reduce((total, r) => total + r.counts[key], 0);
  const pnlSum = results.reduce((total, r) => total + r.summary.totalRealizedPnlUsd, 0);
  const unrealized = results.reduce((total, r) => total + r.summary.unrealizedPnlUsd, 0);
  return [
    `Totals across ${results.length} independent runs (separate ledgers, so these are sums and not one portfolio):`,
    `  Strategy: ${sum('strategyApproved')} approved | ${sum('strategyRejected')} rejected by filters | ${sum('strategyBlocked')} blocked (unknown data) | ${sum('strategyNoSignal')} no signal`,
    `  Risk manager: ${sum('entriesAccepted')} entries accepted | ${sum('entriesRejectedByRisk')} entries rejected | ${sum('noExecutionPrice')} with no execution price`,
    `  Closed positions: ${sum('closedTrades')} (${sum('wins')} won, ${sum('losses')} lost, ${sum('breakEvens')} break-even) | forced end-of-feed closures: ${sum('forcedFeedEndClosures')}`,
    `  Net realized PnL: ${pnl(Number(pnlSum.toFixed(8)))} | unrealized PnL: ${pnl(Number(unrealized.toFixed(8)))}`,
  ].join('\n');
}