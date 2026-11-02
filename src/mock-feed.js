// Offline mock token feed.
//
// Every price produced here is FAKE and generated locally. There are no network
// calls, no real market data and no real tokens. The same inputs always produce
// exactly the same prices, so any simulation built on it can be repeated.

export const DEFAULT_BASE_PRICE = 0.0005;
const DEFAULT_RANDOM_TICKS = 40;
const DEFAULT_VOLATILITY = 0.12;
const MAX_TICKS = 10000;

function scripted(description, multipliers) {
  return Object.freeze({ description, multipliers: Object.freeze(multipliers) });
}

// Scripted price paths, written as multipliers of the entry (base) price.
// Index 0 is the price the sniper would enter at.
const SCRIPTED = Object.freeze({
  'take-profit-run': scripted(
    'Rises steadily and reaches the 2x take-profit target, then keeps rising.',
    [1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.3]
  ),
  'gradual-decline': scripted(
    'Slides about 5% of entry per tick, down to half of the entry price.',
    [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5]
  ),
  'rug-pull': scripted(
    'Pumps a little, then collapses instantly to about 2% of entry (rug-like).',
    [1, 1.05, 1.1, 0.02, 0.01, 0.01]
  ),
  'sideways-then-pump': scripted(
    'Moves sideways within about 3% of entry, then rises through 2x.',
    [1, 1.02, 0.98, 1.01, 0.99, 1.03, 1.2, 1.5, 1.8, 2.1]
  ),
  'sideways-then-dump': scripted(
    'Moves sideways within about 2% of entry, then declines to 30% of entry.',
    [1, 1.02, 0.98, 1.01, 0.99, 1, 0.9, 0.75, 0.6, 0.45, 0.3]
  ),
});

export const SCRIPTED_SCENARIO_NAMES = Object.freeze(Object.keys(SCRIPTED));
export const SCENARIO_NAMES = Object.freeze([...SCRIPTED_SCENARIO_NAMES, 'random-walk']);

/** Describes every available scenario. */
export function listScenarios() {
  return [
    ...SCRIPTED_SCENARIO_NAMES.map((name) => ({
      name,
      kind: 'scripted',
      description: SCRIPTED[name].description,
    })),
    {
      name: 'random-walk',
      kind: 'seeded',
      description:
        'Seeded random walk of about +/-12% per tick. The same seed gives the same prices.',
    },
  ];
}

/**
 * Small seeded pseudo-random number generator (mulberry32).
 * Returns a function that yields numbers in [0, 1). Same seed, same sequence.
 */
export function createRng(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('seed must be a non-negative integer');
  }
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertPositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

/**
 * Returns a fresh array of simulated prices for a scenario.
 * Scripted scenarios ignore seed, ticks and volatility; random-walk uses them.
 */
export function generatePrices(name, options = {}) {
  const {
    basePrice = DEFAULT_BASE_PRICE,
    seed = 1,
    ticks = DEFAULT_RANDOM_TICKS,
    volatility = DEFAULT_VOLATILITY,
  } = options;

  const isScripted = Object.prototype.hasOwnProperty.call(SCRIPTED, name);
  if (!isScripted && name !== 'random-walk') {
    throw new Error(`Unknown scenario: ${name}. Valid scenarios: ${SCENARIO_NAMES.join(', ')}`);
  }

  assertPositiveNumber(basePrice, 'basePrice');
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('seed must be a non-negative integer');
  }

  if (isScripted) {
    return SCRIPTED[name].multipliers.map((multiplier) => basePrice * multiplier);
  }

  if (!Number.isInteger(ticks) || ticks < 2 || ticks > MAX_TICKS) {
    throw new Error(`ticks must be an integer from 2 to ${MAX_TICKS}`);
  }
  if (
    typeof volatility !== 'number' ||
    !Number.isFinite(volatility) ||
    volatility <= 0 ||
    volatility >= 1
  ) {
    throw new Error('volatility must be a number greater than 0 and less than 1');
  }

  const rng = createRng(seed);
  const prices = [basePrice];
  for (let i = 1; i < ticks; i += 1) {
    const step = (rng() - 0.5) * 2 * volatility; // between -volatility and +volatility
    prices.push(prices[i - 1] * (1 + step));
  }
  return prices;
}

/**
 * Builds a mock token: a fake symbol plus its simulated price path.
 * startTick is the simulation tick at which the token "launches".
 * Symbols always start with "MOCK-" so they cannot be mistaken for real tokens.
 */
export function createMockToken(name, options = {}) {
  const {
    symbol,
    startTick = 0,
    basePrice = DEFAULT_BASE_PRICE,
    seed = 1,
    ...priceOptions
  } = options;

  if (!Number.isInteger(startTick) || startTick < 0) {
    throw new Error('startTick must be a non-negative integer');
  }

  const prices = generatePrices(name, { basePrice, seed, ...priceOptions });

  const tokenSymbol = symbol === undefined ? `MOCK-${name.toUpperCase()}` : symbol;
  if (typeof tokenSymbol !== 'string' || !tokenSymbol.startsWith('MOCK-')) {
    throw new Error('Mock token symbols must start with "MOCK-"');
  }

  return { mock: true, symbol: tokenSymbol, scenario: name, seed, basePrice, startTick, prices };
}