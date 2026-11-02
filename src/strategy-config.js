// Strategy configuration: profiles, validation, and the timing rule.
//
// IMPORTANT: every threshold below is a PLACEHOLDER chosen so that fabricated mock tokens
// behave sensibly in demos and tests. None of them is a validated safety or profit
// threshold, and none of them has been checked against real tokens.
//
// Units used everywhere in the strategy layer:
//   tick      one abstract simulation step (no mapping to wall-clock time)
//   Pct       percent, so 20 means 20%
//   Bps       basis points, so 25 means 0.25%
//   Usd       simulated US dollars

export const PROFILE_NAMES = Object.freeze(['conservative', 'balanced', 'aggressive']);
export const DEFAULT_PROFILE = 'balanced';

// Number of strategy signals (momentum and buy/sell activity). minSignalsPassed is out of this.
export const SIGNAL_COUNT = 2;

const COMMON = {
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  requireSellable: true,
  allowedPermissionFlags: [],
};

function profile(values) {
  return Object.freeze({
    ...values,
    allowedPermissionFlags: Object.freeze([...values.allowedPermissionFlags]),
  });
}

export const STRATEGY_PROFILES = Object.freeze({
  conservative: profile({
    ...COMMON,
    observationTicks: 5,
    minAgeTicks: 10,
    maxTopHolderPct: 10,
    maxTop10HolderPct: 40,
    minLiquidityUsd: 25000,
    maxPriceImpactBps: 25,
    maxSingleTickRisePct: 25,
    maxRiseSinceLaunchPct: 60,
    maxSingleTickDropPct: 15,
    maxDrawdownFromHighPct: 25,
    minMomentumPct: 5,
    minBuySharePct: 60,
    minTradesInWindow: 20,
    minSignalsPassed: 2,
  }),
  balanced: profile({
    ...COMMON,
    observationTicks: 3,
    minAgeTicks: 5,
    maxTopHolderPct: 20,
    maxTop10HolderPct: 60,
    minLiquidityUsd: 10000,
    maxPriceImpactBps: 50,
    maxSingleTickRisePct: 40,
    maxRiseSinceLaunchPct: 100,
    maxSingleTickDropPct: 25,
    maxDrawdownFromHighPct: 40,
    minMomentumPct: 2,
    minBuySharePct: 55,
    minTradesInWindow: 10,
    minSignalsPassed: 2,
  }),
  aggressive: profile({
    ...COMMON,
    observationTicks: 2,
    minAgeTicks: 2,
    maxTopHolderPct: 35,
    maxTop10HolderPct: 80,
    minLiquidityUsd: 3000,
    maxPriceImpactBps: 100,
    maxSingleTickRisePct: 75,
    maxRiseSinceLaunchPct: 200,
    maxSingleTickDropPct: 40,
    maxDrawdownFromHighPct: 60,
    minMomentumPct: 0,
    minBuySharePct: 50,
    minTradesInWindow: 5,
    minSignalsPassed: 1,
  }),
});

export const STRATEGY_KEYS = Object.freeze(Object.keys(STRATEGY_PROFILES.balanced));

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validates a strategy config. Throws an Error listing every problem. Returns the config. */
export function validateStrategyConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object') {
    throw new Error('Invalid strategy config: expected an object');
  }

  const errors = [];

  for (const key of Object.keys(cfg)) {
    if (key !== 'profile' && !STRATEGY_KEYS.includes(key)) {
      errors.push(`unknown setting "${key}"`);
    }
  }

  const integerAtLeast = (key, min) => {
    if (!Number.isInteger(cfg[key]) || cfg[key] < min) {
      errors.push(`${key} must be an integer of at least ${min}`);
    }
  };
  const numberIn = (key, lowExclusive, high) => {
    if (!isNumber(cfg[key]) || cfg[key] <= lowExclusive || cfg[key] > high) {
      errors.push(`${key} must be a number greater than ${lowExclusive} and at most ${high}`);
    }
  };

  integerAtLeast('observationTicks', 1);
  integerAtLeast('minAgeTicks', 0);

  for (const key of ['requireMintAuthorityRevoked', 'requireFreezeAuthorityRevoked', 'requireSellable']) {
    if (typeof cfg[key] !== 'boolean') errors.push(`${key} must be true or false`);
  }
  if (
    !Array.isArray(cfg.allowedPermissionFlags) ||
    !cfg.allowedPermissionFlags.every((f) => typeof f === 'string' && f.length > 0)
  ) {
    errors.push('allowedPermissionFlags must be an array of non-empty strings');
  }

  numberIn('maxTopHolderPct', 0, 100);
  numberIn('maxTop10HolderPct', 0, 100);
  if (
    isNumber(cfg.maxTopHolderPct) &&
    isNumber(cfg.maxTop10HolderPct) &&
    cfg.maxTop10HolderPct < cfg.maxTopHolderPct
  ) {
    errors.push('maxTop10HolderPct cannot be below maxTopHolderPct (the top 10 include the top holder)');
  }

  if (!isNumber(cfg.minLiquidityUsd) || cfg.minLiquidityUsd < 0) {
    errors.push('minLiquidityUsd must be a number of at least 0');
  }
  if (!isNumber(cfg.maxPriceImpactBps) || cfg.maxPriceImpactBps <= 0) {
    errors.push('maxPriceImpactBps must be a positive number');
  }
  if (!isNumber(cfg.maxSingleTickRisePct) || cfg.maxSingleTickRisePct <= 0) {
    errors.push('maxSingleTickRisePct must be a positive number');
  }
  if (!isNumber(cfg.maxRiseSinceLaunchPct) || cfg.maxRiseSinceLaunchPct <= 0) {
    errors.push('maxRiseSinceLaunchPct must be a positive number');
  }
  numberIn('maxSingleTickDropPct', 0, 100);
  numberIn('maxDrawdownFromHighPct', 0, 100);

  if (!isNumber(cfg.minMomentumPct)) errors.push('minMomentumPct must be a number');
  if (!isNumber(cfg.minBuySharePct) || cfg.minBuySharePct < 0 || cfg.minBuySharePct > 100) {
    errors.push('minBuySharePct must be a number from 0 to 100');
  }
  integerAtLeast('minTradesInWindow', 0);

  if (!Number.isInteger(cfg.minSignalsPassed) || cfg.minSignalsPassed < 0 || cfg.minSignalsPassed > SIGNAL_COUNT) {
    errors.push(`minSignalsPassed must be an integer from 0 to ${SIGNAL_COUNT}`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid strategy config: ${errors.join('; ')}`);
  }
  return cfg;
}

/**
 * Builds a validated, frozen strategy config from a profile plus optional overrides.
 * Unknown override names are rejected so typos cannot silently do nothing.
 */
export function resolveStrategyConfig(profileName = DEFAULT_PROFILE, overrides = {}) {
  if (!PROFILE_NAMES.includes(profileName)) {
    throw new Error(`Unknown profile: ${profileName}. Valid profiles: ${PROFILE_NAMES.join(', ')}`);
  }
  const merged = { ...STRATEGY_PROFILES[profileName], ...overrides, profile: profileName };
  validateStrategyConfig(merged);
  return Object.freeze(merged);
}

/**
 * TIMING RULE: the first eligible tick.
 *
 * Indices here are LOCAL: index 0 is the first tick at which the token appears in the feed.
 * The bot records price and activity from index 0 (the observation window begins there).
 *
 * Age unit: ticks. The age of a token at local index i is ageAtFirstSeenTicks + i.
 *
 * A token becomes eligible at the smallest index i where BOTH hold:
 *   1. observation:  i >= observationTicks    (at least that many ticks of history)
 *   2. minimum age:  ageAtFirstSeenTicks + i >= minAgeTicks
 * so  firstEligibleIndex = max(observationTicks, minAgeTicks - ageAtFirstSeenTicks).
 * Because the bot simply waits for the later of the two, every profile can satisfy both.
 * Unknown age (null) cannot shorten the wait; the age check itself then reports UNKNOWN.
 */
export function firstEligibleIndex(strategy, ageAtFirstSeenTicks) {
  const ageWait = isNumber(ageAtFirstSeenTicks)
    ? Math.max(0, Math.ceil(strategy.minAgeTicks - ageAtFirstSeenTicks))
    : 0;
  return Math.max(strategy.observationTicks, ageWait);
}