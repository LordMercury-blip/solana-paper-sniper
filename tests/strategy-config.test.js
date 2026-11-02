import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_NAMES,
  DEFAULT_PROFILE,
  SIGNAL_COUNT,
  STRATEGY_PROFILES,
  STRATEGY_KEYS,
  validateStrategyConfig,
  resolveStrategyConfig,
  firstEligibleIndex,
} from '../src/strategy-config.js';
import { DEFAULT_PRELUDE_TICKS } from '../src/mock-attributes.js';

const [CONSERVATIVE, BALANCED, AGGRESSIVE] = PROFILE_NAMES.map((n) => STRATEGY_PROFILES[n]);

describe('profile defaults (placeholders, documented in the README)', () => {
  test('there are exactly three profiles and Balanced is the default', () => {
    assert.deepEqual(PROFILE_NAMES, ['conservative', 'balanced', 'aggressive']);
    assert.equal(DEFAULT_PROFILE, 'balanced');
    assert.equal(SIGNAL_COUNT, 2);
  });

  test('conservative defaults', () => {
    assert.deepEqual({ ...CONSERVATIVE }, {
      requireMintAuthorityRevoked: true,
      requireFreezeAuthorityRevoked: true,
      requireSellable: true,
      allowedPermissionFlags: [],
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
    });
  });

  test('balanced defaults', () => {
    assert.deepEqual({ ...BALANCED }, {
      requireMintAuthorityRevoked: true,
      requireFreezeAuthorityRevoked: true,
      requireSellable: true,
      allowedPermissionFlags: [],
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
    });
  });

  test('aggressive defaults', () => {
    assert.deepEqual({ ...AGGRESSIVE }, {
      requireMintAuthorityRevoked: true,
      requireFreezeAuthorityRevoked: true,
      requireSellable: true,
      allowedPermissionFlags: [],
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
    });
  });

  test('profiles are ordered from strict to loose on every threshold', () => {
    for (const key of STRATEGY_KEYS) {
      const [c, b, a] = [CONSERVATIVE[key], BALANCED[key], AGGRESSIVE[key]];
      if (typeof c !== 'number') continue;
      if (key.startsWith('max')) {
        assert.ok(c <= b && b <= a, `${key}: max-style limits should loosen`);
      } else {
        assert.ok(c >= b && b >= a, `${key}: min-style requirements should loosen`);
      }
    }
  });

  test('no profile relaxes the authority, permission or sellability requirements', () => {
    for (const p of [CONSERVATIVE, BALANCED, AGGRESSIVE]) {
      assert.equal(p.requireMintAuthorityRevoked, true);
      assert.equal(p.requireFreezeAuthorityRevoked, true);
      assert.equal(p.requireSellable, true);
      assert.deepEqual([...p.allowedPermissionFlags], []);
    }
  });

  test('every default profile passes validation', () => {
    for (const name of PROFILE_NAMES) {
      assert.doesNotThrow(() => validateStrategyConfig({ ...STRATEGY_PROFILES[name], profile: name }));
    }
  });
});

describe('resolveStrategyConfig', () => {
  test('returns a frozen, validated config tagged with the profile name', () => {
    const cfg = resolveStrategyConfig('aggressive');
    assert.equal(cfg.profile, 'aggressive');
    assert.equal(cfg.observationTicks, 2);
    assert.ok(Object.isFrozen(cfg));
  });

  test('defaults to balanced', () => {
    assert.equal(resolveStrategyConfig().profile, 'balanced');
  });

  test('overrides apply on top of the profile', () => {
    const cfg = resolveStrategyConfig('balanced', { minLiquidityUsd: 123, allowedPermissionFlags: ['TRANSFER_FEE'] });
    assert.equal(cfg.minLiquidityUsd, 123);
    assert.deepEqual(cfg.allowedPermissionFlags, ['TRANSFER_FEE']);
    assert.equal(cfg.maxTopHolderPct, 20); // untouched
  });

  test('rejects unknown profiles and unknown override names (typos)', () => {
    assert.throws(() => resolveStrategyConfig('reckless'), /Unknown profile/);
    assert.throws(() => resolveStrategyConfig('balanced', { minLiquidty: 5 }), /unknown setting "minLiquidty"/);
  });

  test('invalid overrides are rejected', () => {
    assert.throws(() => resolveStrategyConfig('balanced', { observationTicks: 0 }), /observationTicks/);
    assert.throws(() => resolveStrategyConfig('balanced', { maxTopHolderPct: 90, maxTop10HolderPct: 50 }), /top 10 include the top holder/);
    assert.throws(() => resolveStrategyConfig('balanced', { minSignalsPassed: 3 }), /minSignalsPassed/);
  });
});

describe('validateStrategyConfig', () => {
  const base = () => ({ ...STRATEGY_PROFILES.balanced });

  test('rejects non-objects', () => {
    assert.throws(() => validateStrategyConfig(null), /expected an object/);
  });

  test('rejects bad numbers and flags, listing every problem', () => {
    for (const [key, bad] of [
      ['observationTicks', 1.5],
      ['minAgeTicks', -1],
      ['requireSellable', 'yes'],
      ['allowedPermissionFlags', 'none'],
      ['allowedPermissionFlags', ['']],
      ['maxTopHolderPct', 0],
      ['maxTopHolderPct', 101],
      ['maxTop10HolderPct', NaN],
      ['minLiquidityUsd', -1],
      ['maxPriceImpactBps', 0],
      ['maxSingleTickRisePct', -5],
      ['maxRiseSinceLaunchPct', Infinity],
      ['maxSingleTickDropPct', 0],
      ['maxDrawdownFromHighPct', 150],
      ['minMomentumPct', '1'],
      ['minBuySharePct', 101],
      ['minTradesInWindow', 1.5],
      ['minSignalsPassed', -1],
    ]) {
      assert.throws(() => validateStrategyConfig({ ...base(), [key]: bad }), new RegExp(key), `${key}=${String(bad)}`);
    }
    assert.throws(
      () => validateStrategyConfig({ ...base(), observationTicks: 0, minLiquidityUsd: -1 }),
      /observationTicks.*minLiquidityUsd/
    );
  });

  test('negative momentum thresholds and zero signals are allowed', () => {
    assert.doesNotThrow(() => validateStrategyConfig({ ...base(), minMomentumPct: -3, minSignalsPassed: 0 }));
  });
});

describe('timing: observation period and minimum age are reconciled', () => {
  test('a brand-new token (age 0) becomes eligible at max(observation, min age)', () => {
    assert.equal(firstEligibleIndex(CONSERVATIVE, 0), 10);
    assert.equal(firstEligibleIndex(BALANCED, 0), 5);
    assert.equal(firstEligibleIndex(AGGRESSIVE, 0), 2);
  });

  test('every profile can satisfy both conditions at its first eligible tick', () => {
    for (const p of [CONSERVATIVE, BALANCED, AGGRESSIVE]) {
      const d = firstEligibleIndex(p, 0);
      assert.ok(d >= p.observationTicks, 'enough history');
      assert.ok(0 + d >= p.minAgeTicks, 'old enough');
      // and it is the EARLIEST such tick
      assert.ok(d - 1 < p.observationTicks || d - 1 < p.minAgeTicks);
    }
  });

  test('the entry (d + 1) lands inside the default observation phase for every profile', () => {
    for (const p of [CONSERVATIVE, BALANCED, AGGRESSIVE]) {
      assert.ok(firstEligibleIndex(p, 0) + 1 <= DEFAULT_PRELUDE_TICKS - 1);
    }
  });

  test('a token that already has some age waits less, never less than the observation period', () => {
    assert.equal(firstEligibleIndex(BALANCED, 3), 3); // age needs 2 more, observation needs 3
    assert.equal(firstEligibleIndex(CONSERVATIVE, 8), 5); // age needs 2 more, observation needs 5
    assert.equal(firstEligibleIndex(CONSERVATIVE, 4), 6); // age needs 6 more, observation needs 5
    assert.equal(firstEligibleIndex(BALANCED, 100), 3); // old enough already: observation only
  });

  test('unknown age cannot shorten the wait', () => {
    assert.equal(firstEligibleIndex(BALANCED, null), 3);
    assert.equal(firstEligibleIndex(BALANCED, undefined), 3);
  });

  test('custom configs: age can be the longer or the shorter condition', () => {
    const longObservation = resolveStrategyConfig('balanced', { observationTicks: 8, minAgeTicks: 2 });
    assert.equal(firstEligibleIndex(longObservation, 0), 8);
    const longAge = resolveStrategyConfig('balanced', { observationTicks: 2, minAgeTicks: 9 });
    assert.equal(firstEligibleIndex(longAge, 0), 9);
  });
});