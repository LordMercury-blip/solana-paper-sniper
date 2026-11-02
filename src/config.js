// Paper trading configuration. No wallet keys or real-trade settings belong here.

export const config = Object.freeze({
  paperTradingOnly: true,
  startingBalanceUsd: 10,
  positionSizeUsd: 1,
  maxOpenPositions: 2,
  takeProfitMultiplier: 2,
  dailyLossLimitUsd: 2,

  // Stop-loss is OFF unless explicitly enabled. stopLossFraction is the fraction of
  // the entry value lost at the trigger: 0.4 means the trigger is at 60% of the entry
  // price. While stopLossEnabled is false, this value has no effect on trading.
  stopLossEnabled: false,
  stopLossFraction: 0.4,

  // Simulated trading costs (fees + slippage) as a fraction of the amount traded,
  // charged once on entry and once on exit. 0 means no costs.
  tradingFeeRate: 0,
});

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validates a config object. Throws an Error listing every problem found.
 * Returns the same config object if valid.
 */
export function validateConfig(cfg) {
  const errors = [];

  if (cfg === null || typeof cfg !== 'object') {
    throw new Error('Invalid config: expected an object');
  }

  if (cfg.paperTradingOnly !== true) {
    errors.push('paperTradingOnly must be true (real trading is not supported)');
  }

  if (!isPositiveNumber(cfg.startingBalanceUsd)) {
    errors.push('startingBalanceUsd must be a positive number');
  }

  if (!isPositiveNumber(cfg.positionSizeUsd)) {
    errors.push('positionSizeUsd must be a positive number');
  } else if (
    isPositiveNumber(cfg.startingBalanceUsd) &&
    cfg.positionSizeUsd > cfg.startingBalanceUsd
  ) {
    errors.push('positionSizeUsd cannot exceed startingBalanceUsd');
  }

  if (!Number.isInteger(cfg.maxOpenPositions) || cfg.maxOpenPositions < 1) {
    errors.push('maxOpenPositions must be an integer of at least 1');
  }

  if (!isPositiveNumber(cfg.takeProfitMultiplier) || cfg.takeProfitMultiplier <= 1) {
    errors.push('takeProfitMultiplier must be a number greater than 1');
  }

  if (!isPositiveNumber(cfg.dailyLossLimitUsd)) {
    errors.push('dailyLossLimitUsd must be a positive number');
  } else if (
    isPositiveNumber(cfg.startingBalanceUsd) &&
    cfg.dailyLossLimitUsd > cfg.startingBalanceUsd
  ) {
    errors.push('dailyLossLimitUsd cannot exceed startingBalanceUsd');
  }

  if (typeof cfg.stopLossEnabled !== 'boolean') {
    errors.push('stopLossEnabled must be true or false');
  }

  if (
    typeof cfg.stopLossFraction !== 'number' ||
    !Number.isFinite(cfg.stopLossFraction) ||
    cfg.stopLossFraction <= 0 ||
    cfg.stopLossFraction >= 1
  ) {
    errors.push('stopLossFraction must be a number greater than 0 and less than 1');
  }

  if (
    typeof cfg.tradingFeeRate !== 'number' ||
    !Number.isFinite(cfg.tradingFeeRate) ||
    cfg.tradingFeeRate < 0 ||
    cfg.tradingFeeRate >= 1
  ) {
    errors.push('tradingFeeRate must be a number from 0 up to (but not including) 1');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }

  return cfg;
}

// Fail fast if the default config is ever edited into an invalid state.
validateConfig(config);

export default config;