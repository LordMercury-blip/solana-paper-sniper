// Fabricated token attributes for the strategy layer.
//
// EVERYTHING produced here is INVENTED for testing. None of it is a blockchain observation:
// not the authorities, holder shares, liquidity, trade counts or prices. It is generated
// locally from a seed, with no network access, so the same inputs always give the same data.
//
// A strategy token's price path is built from two parts:
//   1. an observation phase ("prelude") shaped by the archetype, ending at the anchor price
//   2. an existing Stage 3 scenario path, anchored at that price and unchanged
// The path never depends on the strategy, so no profile can change what the feed shows.

import { createRng, generatePrices, SCENARIO_NAMES, DEFAULT_BASE_PRICE } from './mock-feed.js';

export const DATA_SOURCE = 'FABRICATED_MOCK_DATA';
export const DEFAULT_PRELUDE_TICKS = 12;

function hashString(text) {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Independent seeded streams per token, so attribute, price and activity data never share draws.
const stream = (seed, symbol, label) => createRng((seed + hashString(`${symbol}|${label}`)) >>> 0);
const round = (value, decimals) => Number(value.toFixed(decimals));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Shape of the observation phase, as a multiple of the anchor price. i is the index in the
// phase, P its length; the last point (i = P - 1) is always exactly the anchor price.
const PATTERNS = Object.freeze({
  'steady-rise': (i, P) => 1 - 0.0182 * (P - 1 - i),
  'drifting-down': (i, P) => 1 + 0.005 * (P - 1 - i),
  pumped: (i, P) => (i === 0 ? 0.5 : 0.95 + (0.05 * (i - 1)) / (P - 2)),
  collapsing: (i, P) => (i < 2 ? 2.2 : 1.0 - 0.01 * ((P - 1 - i) % 3)),
});

function healthyAttributes(u) {
  const liquidityUsd = round(40000 + u[2] * 20000, 0);
  return {
    mintAuthority: 'REVOKED',
    freezeAuthority: 'REVOKED',
    permissionFlags: [],
    topHolderPct: round(6 + u[0] * 3, 1),
    top10HolderPct: round(28 + u[1] * 8, 1),
    liquidityUsd,
    quoteReserveUsd: round(liquidityUsd * (0.48 + u[3] * 0.04), 0),
    sellSimulation: 'SUCCEEDED',
    ageAtFirstSeenTicks: 0,
  };
}

const NORMAL_TRADES = Object.freeze({ base: 10, range: 5 });

const ARCHETYPES = Object.freeze({
  'healthy-momentum': {
    description: 'Clean fabricated attributes, steady rise and buy-heavy trading. Passes every profile.',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: healthyAttributes,
  },
  'no-momentum': {
    description: 'Clean attributes, but the price drifts down and sellers clearly outnumber buyers.',
    pattern: 'drifting-down',
    buyShare: 0.35,
    trades: NORMAL_TRADES,
    attributes: healthyAttributes,
  },
  'quiet-token': {
    description: 'Clean attributes and a rising price, but almost no trades (too few to judge buying vs selling).',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: { base: 0, range: 3 },
    attributes: healthyAttributes,
  },
  'unsafe-authority': {
    description: 'Mint and freeze authorities are still active.',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: (u) => ({ ...healthyAttributes(u), mintAuthority: 'ACTIVE', freezeAuthority: 'ACTIVE' }),
  },
  'unsafe-honeypot': {
    description: 'The simulated sell FAILED (a honeypot-style token).',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: (u) => ({ ...healthyAttributes(u), sellSimulation: 'FAILED' }),
  },
  'unsafe-permissions': {
    description: 'Carries suspicious permission flags (permanent delegate, transfer hook).',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: (u) => ({ ...healthyAttributes(u), permissionFlags: ['PERMANENT_DELEGATE', 'TRANSFER_HOOK'] }),
  },
  'whale-concentrated': {
    description: 'One holder owns most of the supply.',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: (u) => ({ ...healthyAttributes(u), topHolderPct: round(55 + u[4] * 10, 1), top10HolderPct: round(88 + u[5] * 6, 1) }),
  },
  'thin-liquidity': {
    description: 'Very little liquidity overall.',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: (u) => {
      const liquidityUsd = round(1200 + u[2] * 600, 0);
      return { ...healthyAttributes(u), liquidityUsd, quoteReserveUsd: round(liquidityUsd * (0.48 + u[3] * 0.04), 0) };
    },
  },
  'thin-depth': {
    description: 'Headline liquidity looks large, but the quote-side reserve an order trades against is tiny (fails only the price impact check).',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: (u) => ({
      ...healthyAttributes(u),
      liquidityUsd: round(55000 + u[2] * 10000, 0),
      quoteReserveUsd: round(120 + u[3] * 60, 0),
    }),
  },
  'unknown-data': {
    description: 'Critical safety data is missing (authorities, permissions, sell simulation). Must be blocked.',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: (u) => ({
      ...healthyAttributes(u),
      mintAuthority: null,
      freezeAuthority: null,
      permissionFlags: null,
      sellSimulation: null,
    }),
  },
  pumped: {
    description: 'Clean attributes, but the price nearly doubled in a single tick during observation.',
    pattern: 'pumped',
    buyShare: 0.75,
    trades: NORMAL_TRADES,
    attributes: healthyAttributes,
  },
  collapsing: {
    description: 'Clean attributes, but the price fell by more than half in a single tick during observation.',
    pattern: 'collapsing',
    buyShare: 0.25,
    trades: NORMAL_TRADES,
    attributes: healthyAttributes,
  },
  'short-history': {
    description: 'The feed ends after 2 ticks: not enough history for any profile to decide.',
    pattern: 'steady-rise',
    buyShare: 0.68,
    trades: NORMAL_TRADES,
    attributes: healthyAttributes,
    historyTicks: 2,
  },
});

export const ARCHETYPE_NAMES = Object.freeze(Object.keys(ARCHETYPES));

export function listArchetypes() {
  return ARCHETYPE_NAMES.map((name) => ({ name, description: ARCHETYPES[name].description }));
}

/**
 * Builds a fabricated strategy token.
 * Options: archetype, seed, startTick, symbol, basePrice (the anchor price), preludeTicks
 * (length of the observation phase), historyTicks (truncate the feed), and for random-walk
 * the usual ticks / volatility.
 */
export function createStrategyToken(scenario, options = {}) {
  const {
    archetype = 'healthy-momentum',
    seed = 1,
    startTick = 0,
    symbol,
    basePrice = DEFAULT_BASE_PRICE,
    preludeTicks = DEFAULT_PRELUDE_TICKS,
    historyTicks,
    ...priceOptions
  } = options;

  if (!Object.prototype.hasOwnProperty.call(ARCHETYPES, archetype)) {
    throw new Error(`Unknown archetype: ${archetype}. Valid archetypes: ${ARCHETYPE_NAMES.join(', ')}`);
  }
  if (!Number.isInteger(startTick) || startTick < 0) {
    throw new Error('startTick must be a non-negative integer');
  }
  if (!Number.isInteger(preludeTicks) || preludeTicks < 3 || preludeTicks > 200) {
    throw new Error('preludeTicks must be an integer from 3 to 200');
  }
  const spec = ARCHETYPES[archetype];
  const limit = historyTicks ?? spec.historyTicks;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('historyTicks must be a positive integer');
  }

  // The scenario path is generated first so unknown scenarios and bad options fail early.
  const path = generatePrices(scenario, { basePrice, seed, ...priceOptions });

  const tokenSymbol = symbol ?? `MOCK-${archetype}-${scenario}`.toUpperCase();
  if (typeof tokenSymbol !== 'string' || !tokenSymbol.startsWith('MOCK-')) {
    throw new Error('Mock token symbols must start with "MOCK-"');
  }

  const attrRng = stream(seed, tokenSymbol, 'attributes');
  const priceRng = stream(seed, tokenSymbol, 'prelude');
  const flowRng = stream(seed, tokenSymbol, 'activity');

  const u = Array.from({ length: 8 }, () => attrRng());
  const attributes = { ...spec.attributes(u), dataSource: DATA_SOURCE };

  // Observation phase: ends exactly at the anchor price, with +/-0.1% seeded noise elsewhere.
  const shape = PATTERNS[spec.pattern];
  const prelude = [];
  for (let i = 0; i < preludeTicks; i += 1) {
    const noise = i < preludeTicks - 1 ? 1 + (priceRng() - 0.5) * 0.002 : 1;
    prelude.push(i === preludeTicks - 1 ? basePrice : basePrice * shape(i, preludeTicks) * noise);
  }
  // path[0] equals the anchor price, which is already the last prelude price.
  let prices = [...prelude, ...path.slice(1)];

  // Fabricated per-tick trade counts. Two draws per tick keep the stream aligned.
  let buys = [];
  let sells = [];
  for (let i = 0; i < prices.length; i += 1) {
    const total = spec.trades.base + Math.floor(flowRng() * spec.trades.range);
    const jitter = (flowRng() - 0.5) * 0.06;
    let share = spec.buyShare + jitter;
    if (i >= preludeTicks) {
      const ret = prices[i - 1] > 0 ? prices[i] / prices[i - 1] - 1 : 0;
      share = clamp(0.5 + 3 * ret + jitter, 0.1, 0.9);
    }
    const b = Math.round(total * clamp(share, 0, 1));
    buys.push(b);
    sells.push(total - b);
  }

  if (limit !== undefined && limit < prices.length) {
    prices = prices.slice(0, limit);
    buys = buys.slice(0, limit);
    sells = sells.slice(0, limit);
  }

  return {
    mock: true,
    dataSource: DATA_SOURCE,
    symbol: tokenSymbol,
    scenario,
    archetype,
    seed,
    basePrice,
    startTick,
    preludeTicks,
    prices,
    buys,
    sells,
    attributes,
  };
}

// A fixed set of fabricated demo tokens covering each situation the strategy must handle.
export const SHOWCASE_TOKENS = Object.freeze([
  { id: 'promising-runner', scenario: 'take-profit-run', archetype: 'healthy-momentum', description: 'Clean, strong momentum, then reaches 2x.' },
  { id: 'clean-looking-rug', scenario: 'rug-pull', archetype: 'healthy-momentum', description: 'Looks identical to the promising runner, then rugs: the filters cannot see that coming.' },
  { id: 'promising-then-fades', scenario: 'gradual-decline', archetype: 'healthy-momentum', description: 'Clean and promising at entry, then slides.' },
  { id: 'honeypot', scenario: 'sideways-then-pump', archetype: 'unsafe-honeypot', description: 'Simulated sell fails; would have risen, but is rejected.' },
  { id: 'authority-active', scenario: 'rug-pull', archetype: 'unsafe-authority', description: 'Mint and freeze authorities still active.' },
  { id: 'hidden-permissions', scenario: 'take-profit-run', archetype: 'unsafe-permissions', description: 'Suspicious permission flags; would have risen, but is rejected.' },
  { id: 'whale-heavy', scenario: 'gradual-decline', archetype: 'whale-concentrated', description: 'One holder owns most of the supply.' },
  { id: 'thin-liquidity', scenario: 'sideways-then-pump', archetype: 'thin-liquidity', description: 'Very little liquidity.' },
  { id: 'thin-depth', scenario: 'take-profit-run', archetype: 'thin-depth', description: 'Big headline liquidity, tiny quote-side reserve: rejected only on price impact.' },
  { id: 'unknown-safety-data', scenario: 'sideways-then-pump', archetype: 'unknown-data', description: 'Critical safety data missing: blocked, not passed.' },
  { id: 'pumped-first', scenario: 'sideways-then-dump', archetype: 'pumped', description: 'Nearly doubled in one tick during observation.' },
  { id: 'collapsed-first', scenario: 'sideways-then-pump', archetype: 'collapsing', description: 'Fell by more than half in one tick during observation.' },
  { id: 'no-momentum', scenario: 'sideways-then-dump', archetype: 'no-momentum', description: 'Clean, but no momentum and sell-heavy trading.' },
  { id: 'quiet-trading', scenario: 'sideways-then-pump', archetype: 'quiet-token', description: 'Too few trades to judge buying vs selling.' },
  { id: 'short-history', scenario: 'take-profit-run', archetype: 'short-history', description: 'Feed ends too soon for any profile to decide.' },
]);

export const SHOWCASE_IDS = Object.freeze(SHOWCASE_TOKENS.map((t) => t.id));

/** Builds one showcase token by id. */
export function createShowcaseToken(id, { seed = 1, startTick = 0 } = {}) {
  const entry = SHOWCASE_TOKENS.find((t) => t.id === id);
  if (!entry) {
    throw new Error(`Unknown showcase token: ${id}. Valid ids: ${SHOWCASE_IDS.join(', ')}`);
  }
  return createStrategyToken(entry.scenario, {
    archetype: entry.archetype,
    seed,
    startTick,
    symbol: `MOCK-${entry.id}`.toUpperCase(),
  });
}

export { SCENARIO_NAMES };