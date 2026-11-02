import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIO_NAMES,
  SCRIPTED_SCENARIO_NAMES,
  DEFAULT_BASE_PRICE,
  listScenarios,
  createRng,
  generatePrices,
  createMockToken,
} from '../src/mock-feed.js';

const BASE = DEFAULT_BASE_PRICE;
const approx = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to be about ${expected}`);

describe('scenario catalog', () => {
  test('lists the five scripted scenarios plus a seeded random walk', () => {
    assert.deepEqual(SCRIPTED_SCENARIO_NAMES, [
      'take-profit-run',
      'gradual-decline',
      'rug-pull',
      'sideways-then-pump',
      'sideways-then-dump',
    ]);
    assert.deepEqual(SCENARIO_NAMES, [...SCRIPTED_SCENARIO_NAMES, 'random-walk']);

    const catalog = listScenarios();
    assert.equal(catalog.length, 6);
    for (const entry of catalog) {
      assert.ok(entry.description.length > 0);
      assert.ok(['scripted', 'seeded'].includes(entry.kind));
    }
  });
});

describe('scripted scenarios', () => {
  test('every scripted scenario starts at the base price with valid prices', () => {
    for (const name of SCRIPTED_SCENARIO_NAMES) {
      const prices = generatePrices(name);
      assert.ok(prices.length >= 2, name);
      assert.equal(prices[0], BASE, name);
      assert.ok(prices.every((p) => Number.isFinite(p) && p >= 0), name);
    }
  });

  test('take-profit-run rises steadily and reaches exactly 2x', () => {
    const prices = generatePrices('take-profit-run');
    for (let i = 1; i < prices.length; i += 1) {
      assert.ok(prices[i] > prices[i - 1], `tick ${i} should be higher`);
    }
    assert.ok(prices.includes(BASE * 2));
  });

  test('gradual-decline falls in small steps down to half of entry', () => {
    const prices = generatePrices('gradual-decline');
    for (let i = 1; i < prices.length; i += 1) {
      assert.ok(prices[i] < prices[i - 1], `tick ${i} should be lower`);
      assert.ok(prices[i] / prices[i - 1] >= 0.9, `tick ${i} should be a small step`);
    }
    approx(prices.at(-1), BASE * 0.5);
  });

  test('rug-pull collapses instantly and stays collapsed', () => {
    const prices = generatePrices('rug-pull');
    let worstStep = Infinity;
    for (let i = 1; i < prices.length; i += 1) {
      worstStep = Math.min(worstStep, prices[i] / prices[i - 1]);
    }
    assert.ok(worstStep <= 0.1, 'one tick should lose at least 90%');
    assert.ok(prices.at(-1) < BASE * 0.05);
  });

  test('sideways-then-pump stays near entry, then rises through 2x', () => {
    const prices = generatePrices('sideways-then-pump');
    for (const p of prices.slice(0, 6)) {
      assert.ok(Math.abs(p / BASE - 1) <= 0.05);
    }
    assert.ok(prices.at(-1) >= BASE * 2);
  });

  test('sideways-then-dump stays near entry, then falls to 30% of entry', () => {
    const prices = generatePrices('sideways-then-dump');
    for (const p of prices.slice(0, 6)) {
      assert.ok(Math.abs(p / BASE - 1) <= 0.05);
    }
    approx(prices.at(-1), BASE * 0.3);
  });

  test('scripted scenarios ignore the seed', () => {
    for (const name of SCRIPTED_SCENARIO_NAMES) {
      assert.deepEqual(generatePrices(name, { seed: 1 }), generatePrices(name, { seed: 999 }));
    }
  });

  test('prices scale with the base price', () => {
    const prices = generatePrices('take-profit-run', { basePrice: 2 });
    assert.equal(prices[0], 2);
    assert.equal(Math.max(...prices), 2 * 2.3);
  });

  test('each call returns a fresh array', () => {
    const first = generatePrices('rug-pull');
    first[0] = 999;
    assert.equal(generatePrices('rug-pull')[0], BASE);
  });
});

describe('random-walk (seeded)', () => {
  test('the same seed gives exactly the same prices', () => {
    assert.deepEqual(generatePrices('random-walk', { seed: 42 }), generatePrices('random-walk', { seed: 42 }));
  });

  test('different seeds give different prices', () => {
    assert.notDeepEqual(generatePrices('random-walk', { seed: 1 }), generatePrices('random-walk', { seed: 2 }));
  });

  test('has the requested length, starts at base, and stays positive', () => {
    assert.equal(generatePrices('random-walk').length, 40);
    const prices = generatePrices('random-walk', { seed: 7, ticks: 12 });
    assert.equal(prices.length, 12);
    assert.equal(prices[0], BASE);
    assert.ok(prices.every((p) => Number.isFinite(p) && p > 0));
  });

  test('every step stays within the volatility band', () => {
    const prices = generatePrices('random-walk', { seed: 5, ticks: 200, volatility: 0.1 });
    for (let i = 1; i < prices.length; i += 1) {
      const ratio = prices[i] / prices[i - 1];
      assert.ok(ratio >= 0.9 - 1e-9 && ratio <= 1.1 + 1e-9, `step ${i}: ${ratio}`);
    }
  });

  test('seed 0 is allowed', () => {
    assert.doesNotThrow(() => generatePrices('random-walk', { seed: 0 }));
  });
});

describe('createRng', () => {
  test('is repeatable for a seed and stays in [0, 1)', () => {
    const a = createRng(123);
    const b = createRng(123);
    for (let i = 0; i < 50; i += 1) {
      const value = a();
      assert.equal(value, b());
      assert.ok(value >= 0 && value < 1);
    }
  });

  test('different seeds give different sequences', () => {
    assert.notEqual(createRng(1)(), createRng(2)());
  });

  test('rejects invalid seeds', () => {
    for (const bad of [-1, 1.5, NaN, '1', null, undefined]) {
      assert.throws(() => createRng(bad), /seed/);
    }
  });
});

describe('input validation', () => {
  test('unknown scenarios are rejected and the valid names are listed', () => {
    assert.throws(() => generatePrices('moon-shot'), /Unknown scenario: moon-shot.*rug-pull/);
  });

  test('rejects bad base prices, seeds, ticks and volatility', () => {
    for (const bad of [0, -1, NaN, Infinity, '1']) {
      assert.throws(() => generatePrices('rug-pull', { basePrice: bad }), /basePrice/);
    }
    for (const bad of [-1, 1.5, NaN, '1']) {
      assert.throws(() => generatePrices('rug-pull', { seed: bad }), /seed/);
    }
    for (const bad of [1, 2.5, 10001]) {
      assert.throws(() => generatePrices('random-walk', { ticks: bad }), /ticks/);
    }
    for (const bad of [0, 1, -0.1, NaN]) {
      assert.throws(() => generatePrices('random-walk', { volatility: bad }), /volatility/);
    }
  });
});

describe('createMockToken', () => {
  test('builds a clearly fake token', () => {
    const token = createMockToken('rug-pull');
    assert.equal(token.mock, true);
    assert.equal(token.symbol, 'MOCK-RUG-PULL');
    assert.equal(token.scenario, 'rug-pull');
    assert.equal(token.startTick, 0);
    assert.deepEqual(token.prices, generatePrices('rug-pull'));
  });

  test('custom symbols must start with MOCK-', () => {
    assert.equal(createMockToken('rug-pull', { symbol: 'MOCK-A' }).symbol, 'MOCK-A');
    assert.throws(() => createMockToken('rug-pull', { symbol: 'SOL' }), /MOCK-/);
  });

  test('validates startTick', () => {
    assert.equal(createMockToken('rug-pull', { startTick: 5 }).startTick, 5);
    for (const bad of [-1, 1.5, NaN, '2']) {
      assert.throws(() => createMockToken('rug-pull', { startTick: bad }), /startTick/);
    }
  });

  test('passes the seed through to random-walk', () => {
    const a = createMockToken('random-walk', { seed: 9 });
    const b = createMockToken('random-walk', { seed: 9 });
    assert.deepEqual(a, b);
    assert.equal(a.seed, 9);
  });
});