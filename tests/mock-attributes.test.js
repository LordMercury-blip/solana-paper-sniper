import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrices, DEFAULT_BASE_PRICE } from '../src/mock-feed.js';
import {
  DATA_SOURCE,
  DEFAULT_PRELUDE_TICKS,
  ARCHETYPE_NAMES,
  SHOWCASE_TOKENS,
  SHOWCASE_IDS,
  createStrategyToken,
  createShowcaseToken,
  listArchetypes,
} from '../src/mock-attributes.js';

const BASE = DEFAULT_BASE_PRICE;
const P = DEFAULT_PRELUDE_TICKS;
const SEEDS = [0, 1, 2, 7, 42, 99, 1234, 2024];

describe('determinism', () => {
  test('the same inputs always give exactly the same token', () => {
    for (const archetype of ARCHETYPE_NAMES) {
      const a = createStrategyToken('take-profit-run', { archetype, seed: 5 });
      const b = createStrategyToken('take-profit-run', { archetype, seed: 5 });
      assert.deepEqual(a, b, archetype);
    }
  });

  test('different seeds give different data', () => {
    const a = createStrategyToken('take-profit-run', { seed: 1 });
    const b = createStrategyToken('take-profit-run', { seed: 2 });
    assert.notDeepEqual(a.attributes, b.attributes);
    assert.notDeepEqual(a.prices.slice(0, P), b.prices.slice(0, P));
    assert.notDeepEqual(a.buys, b.buys);
  });

  test('different symbols with the same seed give different data (streams are mixed with the symbol)', () => {
    const a = createStrategyToken('rug-pull', { seed: 1, symbol: 'MOCK-A' });
    const b = createStrategyToken('rug-pull', { seed: 1, symbol: 'MOCK-B' });
    assert.notDeepEqual(a.attributes, b.attributes);
  });

  test('the observation phase, attributes and early activity do not depend on the later scenario', () => {
    const symbol = 'MOCK-SAME';
    const runner = createStrategyToken('take-profit-run', { seed: 3, symbol });
    for (const scenario of ['rug-pull', 'gradual-decline', 'sideways-then-pump', 'random-walk']) {
      const other = createStrategyToken(scenario, { seed: 3, symbol });
      assert.deepEqual(other.attributes, runner.attributes, scenario);
      assert.deepEqual(other.prices.slice(0, P), runner.prices.slice(0, P), scenario);
      assert.deepEqual(other.buys.slice(0, P), runner.buys.slice(0, P), scenario);
      assert.deepEqual(other.sells.slice(0, P), runner.sells.slice(0, P), scenario);
    }
  });
});

describe('fabricated-data labelling', () => {
  test('every token and its attributes are tagged as fabricated, with a MOCK- symbol', () => {
    for (const archetype of ARCHETYPE_NAMES) {
      const token = createStrategyToken('rug-pull', { archetype });
      assert.equal(token.mock, true);
      assert.equal(token.dataSource, DATA_SOURCE);
      assert.equal(token.attributes.dataSource, 'FABRICATED_MOCK_DATA');
      assert.ok(token.symbol.startsWith('MOCK-'), token.symbol);
    }
  });

  test('custom symbols must start with MOCK-', () => {
    assert.equal(createStrategyToken('rug-pull', { symbol: 'MOCK-X' }).symbol, 'MOCK-X');
    assert.throws(() => createStrategyToken('rug-pull', { symbol: 'BONK' }), /MOCK-/);
  });
});

describe('price path structure', () => {
  test('observation phase + the existing Stage 3 path, anchored at the base price, unchanged', () => {
    for (const scenario of ['take-profit-run', 'rug-pull', 'gradual-decline', 'sideways-then-pump', 'sideways-then-dump']) {
      const token = createStrategyToken(scenario, { archetype: 'healthy-momentum', seed: 4 });
      const stage3 = generatePrices(scenario);
      assert.equal(token.prices.length, P - 1 + stage3.length, scenario);
      assert.equal(token.prices[P - 1], BASE, 'the observation phase ends exactly at the anchor price');
      assert.deepEqual(token.prices.slice(P - 1), stage3, `${scenario}: Stage 3 path is unchanged from the anchor onward`);
    }
  });

  test('the anchor price and prelude length are configurable', () => {
    const token = createStrategyToken('take-profit-run', { basePrice: 2, preludeTicks: 6 });
    assert.equal(token.prices[5], 2);
    assert.deepEqual(token.prices.slice(5), generatePrices('take-profit-run', { basePrice: 2 }));
    assert.equal(token.preludeTicks, 6);
  });

  test('random-walk scenarios work and are seed-deterministic', () => {
    const a = createStrategyToken('random-walk', { seed: 9, ticks: 20 });
    const b = createStrategyToken('random-walk', { seed: 9, ticks: 20 });
    assert.deepEqual(a, b);
    assert.equal(a.prices.length, P - 1 + 20);
  });

  test('prices are finite, non-negative, and activity arrays line up with prices', () => {
    for (const archetype of ARCHETYPE_NAMES) {
      const t = createStrategyToken('rug-pull', { archetype });
      assert.ok(t.prices.every((p) => Number.isFinite(p) && p >= 0), archetype);
      assert.equal(t.buys.length, t.prices.length, archetype);
      assert.equal(t.sells.length, t.prices.length, archetype);
      assert.ok([...t.buys, ...t.sells].every((n) => Number.isInteger(n) && n >= 0), archetype);
    }
  });

  test('observation shapes: steady rise, spike, collapse, drift down', () => {
    const rise = createStrategyToken('take-profit-run', { archetype: 'healthy-momentum' }).prices.slice(0, P);
    assert.ok(rise[P - 1] / rise[0] > 1.2 && rise[P - 1] / rise[0] < 1.3, 'about +25% over the observation phase');

    const pumped = createStrategyToken('take-profit-run', { archetype: 'pumped' }).prices;
    assert.ok(pumped[1] / pumped[0] > 1.8, 'a near-doubling in one tick');

    const collapsing = createStrategyToken('take-profit-run', { archetype: 'collapsing' }).prices;
    assert.ok(collapsing[2] / collapsing[1] < 0.5, 'more than halves in one tick');

    const drift = createStrategyToken('take-profit-run', { archetype: 'no-momentum' }).prices.slice(0, P);
    assert.ok(drift[P - 1] < drift[0], 'drifts down');
  });
});

describe('archetype attributes (stable across seeds)', () => {
  const forAllSeeds = (archetype, fn) => {
    for (const seed of SEEDS) fn(createStrategyToken('rug-pull', { archetype, seed }).attributes, seed);
  };

  test('healthy: authorities revoked, no flags, modest concentration, deep liquidity, sellable, age 0', () => {
    forAllSeeds('healthy-momentum', (a, seed) => {
      assert.equal(a.mintAuthority, 'REVOKED', seed);
      assert.equal(a.freezeAuthority, 'REVOKED', seed);
      assert.deepEqual(a.permissionFlags, [], seed);
      assert.ok(a.topHolderPct >= 6 && a.topHolderPct <= 9, seed);
      assert.ok(a.top10HolderPct >= 28 && a.top10HolderPct <= 36, seed);
      assert.ok(a.liquidityUsd >= 40000 && a.liquidityUsd <= 60000, seed);
      assert.ok(a.quoteReserveUsd >= 19000 && a.quoteReserveUsd <= 31000, seed);
      assert.equal(a.sellSimulation, 'SUCCEEDED', seed);
      assert.equal(a.ageAtFirstSeenTicks, 0, seed);
    });
  });

  test('unsafe archetypes carry their specific defect', () => {
    forAllSeeds('unsafe-authority', (a) => {
      assert.equal(a.mintAuthority, 'ACTIVE');
      assert.equal(a.freezeAuthority, 'ACTIVE');
    });
    forAllSeeds('unsafe-honeypot', (a) => assert.equal(a.sellSimulation, 'FAILED'));
    forAllSeeds('unsafe-permissions', (a) => assert.deepEqual(a.permissionFlags, ['PERMANENT_DELEGATE', 'TRANSFER_HOOK']));
    forAllSeeds('whale-concentrated', (a) => {
      assert.ok(a.topHolderPct >= 55 && a.top10HolderPct >= 88);
    });
  });

  test('thin-liquidity is shallow overall; thin-depth has big headline liquidity but a tiny quote-side reserve', () => {
    forAllSeeds('thin-liquidity', (a) => assert.ok(a.liquidityUsd < 3000, 'below even the Aggressive floor'));
    forAllSeeds('thin-depth', (a) => {
      assert.ok(a.liquidityUsd >= 55000, 'passes every liquidity floor');
      assert.ok(a.quoteReserveUsd <= 180, 'but the order would trade against almost nothing');
    });
  });

  test('unknown-data has missing critical safety fields but still has market data', () => {
    forAllSeeds('unknown-data', (a) => {
      assert.equal(a.mintAuthority, null);
      assert.equal(a.freezeAuthority, null);
      assert.equal(a.permissionFlags, null);
      assert.equal(a.sellSimulation, null);
      assert.equal(typeof a.liquidityUsd, 'number');
    });
  });

  test('quiet-token trades almost never; healthy tokens trade steadily', () => {
    const quiet = createStrategyToken('rug-pull', { archetype: 'quiet-token' });
    const healthy = createStrategyToken('rug-pull', { archetype: 'healthy-momentum' });
    const perTick = (t, i) => t.buys[i] + t.sells[i];
    for (let i = 0; i < P; i += 1) {
      assert.ok(perTick(quiet, i) <= 2, `quiet tick ${i}`);
      assert.ok(perTick(healthy, i) >= 10, `healthy tick ${i}`);
    }
  });

  test('buy shares: healthy leans to buyers, no-momentum clearly to sellers', () => {
    const share = (archetype) => {
      const t = createStrategyToken('rug-pull', { archetype });
      const buys = t.buys.slice(0, P).reduce((a, b) => a + b, 0);
      const sells = t.sells.slice(0, P).reduce((a, b) => a + b, 0);
      return buys / (buys + sells);
    };
    assert.ok(share('healthy-momentum') > 0.62);
    assert.ok(share('no-momentum') < 0.40);
  });

  test('short-history is truncated to 2 ticks; historyTicks can truncate any token', () => {
    const short = createStrategyToken('take-profit-run', { archetype: 'short-history' });
    assert.equal(short.prices.length, 2);
    assert.equal(short.buys.length, 2);
    assert.equal(short.sells.length, 2);
    assert.equal(createStrategyToken('take-profit-run', { historyTicks: 5 }).prices.length, 5);
    assert.equal(createStrategyToken('take-profit-run', { historyTicks: 5000 }).prices.length, P - 1 + generatePrices('take-profit-run').length);
  });

  test('every archetype has a description', () => {
    assert.equal(listArchetypes().length, ARCHETYPE_NAMES.length);
    assert.ok(listArchetypes().every((a) => a.description.length > 10));
  });
});

describe('validation', () => {
  test('rejects bad inputs', () => {
    assert.throws(() => createStrategyToken('moon-shot'), /Unknown scenario/);
    assert.throws(() => createStrategyToken('rug-pull', { archetype: 'legit' }), /Unknown archetype.*healthy-momentum/);
    assert.throws(() => createStrategyToken('rug-pull', { startTick: -1 }), /startTick/);
    assert.throws(() => createStrategyToken('rug-pull', { preludeTicks: 2 }), /preludeTicks/);
    assert.throws(() => createStrategyToken('rug-pull', { preludeTicks: 500 }), /preludeTicks/);
    assert.throws(() => createStrategyToken('rug-pull', { historyTicks: 0 }), /historyTicks/);
    assert.throws(() => createStrategyToken('rug-pull', { seed: -1 }), /seed/);
    assert.throws(() => createStrategyToken('rug-pull', { basePrice: 0 }), /basePrice/);
  });
});

describe('showcase tokens', () => {
  test('there are fifteen, with unique ids, covering every archetype', () => {
    assert.equal(SHOWCASE_TOKENS.length, 15);
    assert.equal(new Set(SHOWCASE_IDS).size, 15);
    const used = new Set(SHOWCASE_TOKENS.map((t) => t.archetype));
    for (const name of ARCHETYPE_NAMES) assert.ok(used.has(name), `showcase covers ${name}`);
  });

  test('the clean-looking rug is built from the same archetype as the promising runner', () => {
    const rug = SHOWCASE_TOKENS.find((t) => t.id === 'clean-looking-rug');
    const runner = SHOWCASE_TOKENS.find((t) => t.id === 'promising-runner');
    assert.equal(rug.archetype, runner.archetype);
    assert.equal(rug.scenario, 'rug-pull');
    assert.equal(runner.scenario, 'take-profit-run');
  });

  test('showcase tokens have MOCK- symbols and respect startTick and seed', () => {
    const token = createShowcaseToken('honeypot', { seed: 4, startTick: 3 });
    assert.equal(token.symbol, 'MOCK-HONEYPOT');
    assert.equal(token.startTick, 3);
    assert.equal(token.attributes.sellSimulation, 'FAILED');
    assert.deepEqual(token, createShowcaseToken('honeypot', { seed: 4, startTick: 3 }));
    assert.throws(() => createShowcaseToken('real-token'), /Unknown showcase token/);
  });
});