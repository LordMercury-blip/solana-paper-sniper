// Shared money and outcome helpers.
// Paper trading only: nothing here touches wallets, keys, or networks.

const USD_PRECISION = 1e8;

// Rounds simulated USD amounts to 8 decimals to avoid floating point drift.
// Also normalizes -0 to 0 so zero amounts always compare equal.
export function roundUsd(value) {
  const rounded = Math.round(value * USD_PRECISION) / USD_PRECISION;
  return rounded === 0 ? 0 : rounded;
}

export const TRADE_OUTCOME = Object.freeze({
  WIN: 'WIN',
  LOSS: 'LOSS',
  BREAK_EVEN: 'BREAK_EVEN',
});

/**
 * Classifies a CLOSED trade by the sign of its realized PnL, which must already
 * include simulated trading costs. There is no percentage threshold: any positive
 * amount is a WIN and any negative amount is a LOSS. Amounts smaller than
 * $0.00000001 are treated as zero (floating point dust).
 *
 * Never call this for an open position. Open positions have unrealized PnL
 * and no outcome yet.
 */
export function classifyOutcome(realizedPnlUsd) {
  if (typeof realizedPnlUsd !== 'number' || !Number.isFinite(realizedPnlUsd)) {
    throw new Error('realizedPnlUsd must be a finite number');
  }

  const pnl = roundUsd(realizedPnlUsd);
  if (pnl > 0) return TRADE_OUTCOME.WIN;
  if (pnl < 0) return TRADE_OUTCOME.LOSS;
  return TRADE_OUTCOME.BREAK_EVEN;
}