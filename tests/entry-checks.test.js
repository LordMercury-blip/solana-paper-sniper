import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_STATUS,
  DECISION,
  FUTURE_REAL_DATA,
  evaluateEntry,
  estimateBuyImpactBps,
  estimateSellImpactBps,
} from '../src/entry-checks.js';
import { resolveStrategyConfig } from '../src/strategy-config.js';

const { PASS, FAIL, UNKNOWN } = CHECK_STATUS;
const BALANCED = resolveStrategyConfig('balanced');
const ORDER = { sizeUsd: 1, takeProfitMultiplier: 2 };

const goodAttributes = () => ({
  mintAuthority: 'REVOKED',
  freezeAuthority: 'REVOKED',
  permissionFlags: [],
  topHolderPct: 8,
  top10HolderPct: 30,
  liquidityUsd: 50000,
  quoteReserveUsd: 25000,
  sellSimulation: 'SUCCEEDED',
  ageAtFirstSeenTicks: 0,
});

// 6 prices (decision index 5): gently rising, buy-heavy. Passes every Balanced check.
const goodHistory = (n = 6) => ({
  prices: Array.from({ length: n }, (_, i) => 1 + 0.02 * i),
  buys: Array(n).fill(7),
  sells: Array(n).fill(3),
});

function evaluate({ history = goodHistory(), attributes = {}, strategy = BALANCED, order = ORDER } = {}) {
  return evaluateEntry({ history, attributes: { ...goodAttributes(), ...attributes }, strategy, order });
}
const check = (result, id) => result.checks.find((c) => c.id === id);

describe('baseline', () => {
  test('a clean token with good signals is APPROVED and every check passes', () => {
    const result = evaluate();
    assert.equal(result.decision, DECISION.APPROVED);
    assert.equal(result.mandatoryStatus, PASS);
    assert.equal(result.signalsPassed, 2);
    assert.deepEqual(result.reasons, []);
    assert.ok(result.checks.every((c) => c.status === PASS), JSON.stringify(result.checks.filter((c) => c.status !== PASS)));
  });

  test('all thirteen checks are present, in order, and labelled simulated', () => {
    const result = evaluate();
    assert.deepEqual(
      result.checks.map((c) => c.id),
      [
        'observationWindow', 'tokenAge', 'mintAuthority', 'freezeAuthority', 'suspiciousPermissions',
        'holderConcentration', 'minLiquidity', 'priceImpact', 'sellability', 'priceSpike',
        'priceCollapse', 'momentum', 'buySellActivity',
      ]
    );
    for (const c of result.checks) {
      assert.equal(c.simulated, true, c.id);
      assert.equal(typeof c.futureRealCheck, 'string', c.id);
      assert.equal(c.futureRealCheck, FUTURE_REAL_DATA[c.id], c.id);
      assert.ok(['MANDATORY', 'SIGNAL'].includes(c.category), c.id);
    }
  });

  test('momentum and buy/sell activity are signals; everything else is mandatory', () => {
    const result = evaluate();
    assert.deepEqual(result.checks.filter((c) => c.category === 'SIGNAL').map((c) => c.id), ['momentum', 'buySellActivity']);
    assert.equal(result.checks.filter((c) => c.category === 'MANDATORY').length, 11);
  });

  test('the decision index is the last price the strategy was given', () => {
    assert.equal(evaluate({ history: goodHistory(6) }).decisionIndex, 5);
    assert.equal(evaluate({ history: goodHistory(9) }).decisionIndex, 8);
  });
});

describe('observation window and token age', () => {
  test('too little history is UNKNOWN and blocks the entry', () => {
    const result = evaluate({ history: goodHistory(3) }); // 2 ticks of history, need 3
    assert.equal(check(result, 'observationWindow').status, UNKNOWN);
    assert.equal(result.decision, DECISION.BLOCKED);
  });

  test('exactly the required history passes', () => {
    const result = evaluate({ history: goodHistory(4), strategy: resolveStrategyConfig('balanced', { minAgeTicks: 0 }) }); // idx 3 = N
    assert.equal(check(result, 'observationWindow').status, PASS);
  });

  test('history-based checks are UNKNOWN until the observation period is complete', () => {
    const result = evaluate({ history: goodHistory(3) });
    for (const id of ['priceSpike', 'priceCollapse', 'momentum', 'buySellActivity']) {
      assert.equal(check(result, id).status, UNKNOWN, id);
    }
  });

  test('token age: reached passes; not reached is UNKNOWN (a wait, not a verdict); missing is UNKNOWN', () => {
    assert.equal(check(evaluate({ attributes: { ageAtFirstSeenTicks: 0 } }), 'tokenAge').status, PASS); // age 5, min 5
    assert.equal(check(evaluate({ attributes: { ageAtFirstSeenTicks: 100 } }), 'tokenAge').status, PASS);
    const young = evaluate({ strategy: resolveStrategyConfig('balanced', { minAgeTicks: 10 }) });
    assert.equal(check(young, 'tokenAge').status, UNKNOWN);
    assert.match(check(young, 'tokenAge').detail, /not old enough yet/);
    assert.equal(young.decision, DECISION.BLOCKED);
    assert.equal(check(evaluate({ attributes: { ageAtFirstSeenTicks: null } }), 'tokenAge').status, UNKNOWN);
  });
});

describe('mint and freeze authority', () => {
  for (const [id, field, requireKey] of [
    ['mintAuthority', 'mintAuthority', 'requireMintAuthorityRevoked'],
    ['freezeAuthority', 'freezeAuthority', 'requireFreezeAuthorityRevoked'],
  ]) {
    test(`${id}: REVOKED passes, ACTIVE fails, missing or unrecognized is UNKNOWN`, () => {
      assert.equal(check(evaluate({ attributes: { [field]: 'REVOKED' } }), id).status, PASS);
      const active = evaluate({ attributes: { [field]: 'ACTIVE' } });
      assert.equal(check(active, id).status, FAIL);
      assert.equal(active.decision, DECISION.REJECTED);
      assert.deepEqual(active.reasons, [id]);
      for (const missing of [null, undefined, 'WHO KNOWS', 7]) {
        const result = evaluate({ attributes: { [field]: missing } });
        assert.equal(check(result, id).status, UNKNOWN, String(missing));
        assert.equal(result.decision, DECISION.BLOCKED, String(missing));
      }
    });

    test(`${id}: an ACTIVE authority is tolerated only if the config says so; missing data still blocks`, () => {
      const tolerant = resolveStrategyConfig('balanced', { [requireKey]: false });
      assert.equal(check(evaluate({ attributes: { [field]: 'ACTIVE' }, strategy: tolerant }), id).status, PASS);
      assert.equal(check(evaluate({ attributes: { [field]: null }, strategy: tolerant }), id).status, UNKNOWN);
    });
  }
});

describe('suspicious permissions', () => {
  test('no flags pass; an unexpected flag fails; missing data is UNKNOWN', () => {
    assert.equal(check(evaluate({ attributes: { permissionFlags: [] } }), 'suspiciousPermissions').status, PASS);
    const bad = evaluate({ attributes: { permissionFlags: ['TRANSFER_HOOK', 'PERMANENT_DELEGATE'] } });
    assert.equal(check(bad, 'suspiciousPermissions').status, FAIL); // PERMANENT_DELEGATE is high-risk
    assert.match(check(bad, 'suspiciousPermissions').detail, /PERMANENT_DELEGATE/);
    assert.match(check(bad, 'suspiciousPermissions').detail, /also needs inspection: TRANSFER_HOOK/);
    assert.equal(bad.decision, DECISION.REJECTED);
    for (const missing of [null, undefined, 'none']) {
      assert.equal(check(evaluate({ attributes: { permissionFlags: missing } }), 'suspiciousPermissions').status, UNKNOWN);
    }
  });

  test('a flag in the allow-list is accepted explicitly; every other flag is still judged by its tier', () => {
    const allowed = resolveStrategyConfig('balanced', { allowedPermissionFlags: ['TRANSFER_FEE'] });
    assert.equal(check(evaluate({ attributes: { permissionFlags: ['TRANSFER_FEE'] }, strategy: allowed }), 'suspiciousPermissions').status, PASS);
    // TRANSFER_HOOK needs inspection (UNKNOWN), PERMANENT_DELEGATE is high-risk (FAIL)
    assert.equal(check(evaluate({ attributes: { permissionFlags: ['TRANSFER_FEE', 'TRANSFER_HOOK'] }, strategy: allowed }), 'suspiciousPermissions').status, UNKNOWN);
    assert.equal(check(evaluate({ attributes: { permissionFlags: ['TRANSFER_FEE', 'PERMANENT_DELEGATE'] }, strategy: allowed }), 'suspiciousPermissions').status, FAIL);
  });
});

describe('holder concentration', () => {
  test('within limits passes', () => {
    assert.equal(check(evaluate({ attributes: { topHolderPct: 20, top10HolderPct: 60 } }), 'holderConcentration').status, PASS); // exactly at the limits
  });

  test('either measure over its limit fails', () => {
    assert.equal(check(evaluate({ attributes: { topHolderPct: 25 } }), 'holderConcentration').status, FAIL);
    assert.equal(check(evaluate({ attributes: { top10HolderPct: 70 } }), 'holderConcentration').status, FAIL);
    const both = evaluate({ attributes: { topHolderPct: 60, top10HolderPct: 90 } });
    assert.match(check(both, 'holderConcentration').detail, /top holder.*top-10/);
  });

  test('missing data is UNKNOWN, but a violation still wins over missing data', () => {
    assert.equal(check(evaluate({ attributes: { topHolderPct: null } }), 'holderConcentration').status, UNKNOWN);
    assert.equal(check(evaluate({ attributes: { top10HolderPct: undefined } }), 'holderConcentration').status, UNKNOWN);
    assert.equal(check(evaluate({ attributes: { topHolderPct: 90, top10HolderPct: null } }), 'holderConcentration').status, FAIL);
  });
});

describe('minimum liquidity', () => {
  test('at or above the minimum passes, below fails', () => {
    assert.equal(check(evaluate({ attributes: { liquidityUsd: 10000 } }), 'minLiquidity').status, PASS);
    assert.equal(check(evaluate({ attributes: { liquidityUsd: 9999 } }), 'minLiquidity').status, FAIL);
  });

  test('missing or invalid liquidity is UNKNOWN', () => {
    for (const bad of [null, undefined, NaN, -5, '50000']) {
      assert.equal(check(evaluate({ attributes: { liquidityUsd: bad } }), 'minLiquidity').status, UNKNOWN, String(bad));
    }
  });
});

describe('price impact', () => {
  test('the constant-product estimates are exact', () => {
    assert.equal(estimateBuyImpactBps(1000, 1), 10); // a / R
    assert.equal(estimateSellImpactBps(1000, 1), 10000 / 1001); // a / (R + a)
    assert.equal(estimateBuyImpactBps(500, 5), 100);
    assert.ok(estimateSellImpactBps(1000, 1) < estimateBuyImpactBps(1000, 1), 'a sell loses slightly less than a buy costs');
  });

  test('a deep reserve passes; the check reports both directions', () => {
    const result = evaluate();
    const c = check(result, 'priceImpact');
    assert.equal(c.status, PASS);
    assert.equal(c.measured.buyBps, 10000 / 25000);
    assert.equal(c.measured.sellBps, 20000 / 25002);
    assert.match(c.detail, /bps/);
  });

  test('the sell side is sized at the take-profit value of the position', () => {
    const c = check(evaluate({ attributes: { quoteReserveUsd: 1000 }, order: { sizeUsd: 1, takeProfitMultiplier: 3 } }), 'priceImpact');
    assert.equal(c.measured.sellBps, 30000 / 1003);
    assert.equal(c.measured.buyBps, 10);
  });

  test('a shallow reserve FAILS the price impact check on its own, even with large headline liquidity', () => {
    const result = evaluate({ attributes: { liquidityUsd: 60000, quoteReserveUsd: 100 } });
    assert.equal(check(result, 'minLiquidity').status, PASS);
    assert.equal(check(result, 'priceImpact').status, FAIL);
    assert.equal(result.decision, DECISION.REJECTED);
    assert.deepEqual(result.reasons, ['priceImpact']);
  });

  test('the limit is inclusive: exactly at the maximum passes, just beyond fails', () => {
    // Balanced max is 50 bps. Sell impact for a $2 order is 20000 / (R + 2).
    assert.equal(check(evaluate({ attributes: { quoteReserveUsd: 398 } }), 'priceImpact').status, PASS); // exactly 50.0
    assert.equal(check(evaluate({ attributes: { quoteReserveUsd: 397 } }), 'priceImpact').status, FAIL); // 50.125
  });

  test('no reserve data is UNKNOWN; a zero or negative reserve fails', () => {
    for (const missing of [null, undefined, NaN, '100']) {
      assert.equal(check(evaluate({ attributes: { quoteReserveUsd: missing } }), 'priceImpact').status, UNKNOWN, String(missing));
    }
    assert.equal(check(evaluate({ attributes: { quoteReserveUsd: 0 } }), 'priceImpact').status, FAIL);
    assert.equal(check(evaluate({ attributes: { quoteReserveUsd: -10 } }), 'priceImpact').status, FAIL);
  });

  test('raising the limit changes the verdict, so the threshold is what blocked it', () => {
    const loose = resolveStrategyConfig('balanced', { maxPriceImpactBps: 1000 });
    assert.equal(check(evaluate({ attributes: { quoteReserveUsd: 100 }, strategy: loose }), 'priceImpact').status, PASS);
  });
});

describe('sellability', () => {
  test('SUCCEEDED passes, FAILED fails, missing is UNKNOWN', () => {
    assert.equal(check(evaluate({ attributes: { sellSimulation: 'SUCCEEDED' } }), 'sellability').status, PASS);
    const failed = evaluate({ attributes: { sellSimulation: 'FAILED' } });
    assert.equal(check(failed, 'sellability').status, FAIL);
    assert.equal(failed.decision, DECISION.REJECTED);
    for (const missing of [null, undefined, 'MAYBE']) {
      assert.equal(check(evaluate({ attributes: { sellSimulation: missing } }), 'sellability').status, UNKNOWN);
    }
  });

  test('a failed sell is tolerated only if the config says so; missing data still blocks', () => {
    const tolerant = resolveStrategyConfig('balanced', { requireSellable: false });
    assert.equal(check(evaluate({ attributes: { sellSimulation: 'FAILED' }, strategy: tolerant }), 'sellability').status, PASS);
    assert.equal(check(evaluate({ attributes: { sellSimulation: null }, strategy: tolerant }), 'sellability').status, UNKNOWN);
  });
});

describe('extreme price spike and sudden collapse', () => {
  const lenient = resolveStrategyConfig('balanced', { minAgeTicks: 0 });
  const withPrices = (prices) => ({
    history: { prices, buys: prices.map(() => 7), sells: prices.map(() => 3) },
    strategy: lenient,
  });

  test('a single-tick spike over the limit fails', () => {
    const result = evaluate(withPrices([1, 1.5, 1.52, 1.54])); // +50% in one tick, limit 40%
    assert.equal(check(result, 'priceSpike').status, FAIL);
    assert.match(check(result, 'priceSpike').detail, /single-tick rise/);
    assert.equal(result.decision, DECISION.REJECTED);
  });

  test('a steady climb that is too large since launch fails even if no single tick is extreme', () => {
    const result = evaluate(withPrices([1, 1.3, 1.69, 2.197])); // +30% each tick, +119.7% in total, limit 100%
    assert.equal(check(result, 'priceSpike').status, FAIL);
    assert.match(check(result, 'priceSpike').detail, /rise since launch/);
  });

  test('a single-tick collapse over the limit fails', () => {
    const result = evaluate(withPrices([1, 1, 0.7, 0.69])); // -30% in one tick, limit 25%
    assert.equal(check(result, 'priceCollapse').status, FAIL);
    assert.equal(result.decision, DECISION.REJECTED);
  });

  test('a slow bleed that is too deep from the high fails even if no single tick is extreme', () => {
    const result = evaluate(withPrices([1, 0.88, 0.77, 0.68, 0.6, 0.53])); // -12% per tick, -47% from high, limit 40%
    assert.equal(check(result, 'priceCollapse').status, FAIL);
    assert.match(check(result, 'priceCollapse').detail, /drawdown from high/);
  });

  test('a calm history passes both', () => {
    const result = evaluate(withPrices([1, 1.01, 1.02, 1.03, 1.04]));
    assert.equal(check(result, 'priceSpike').status, PASS);
    assert.equal(check(result, 'priceCollapse').status, PASS);
  });

  test('the whole history since launch is used, not only the recent window', () => {
    // The spike happens early; the last 3 ticks are calm.
    const result = evaluate(withPrices([1, 1.9, 1.91, 1.92, 1.93, 1.94]));
    assert.equal(check(result, 'priceSpike').status, FAIL);
  });

  test('a zero price in the history prevents a full calculation: UNKNOWN, or FAIL if a violation is visible', () => {
    const result = evaluate(withPrices([1, 1.01, 0, 0, 0, 0]));
    assert.equal(check(result, 'priceSpike').status, UNKNOWN);
    assert.equal(check(result, 'priceCollapse').status, FAIL); // the 100% drop is still visible
    assert.equal(result.decision, DECISION.REJECTED);
  });

  test('invalid prices are UNKNOWN', () => {
    const result = evaluate(withPrices([1, 1.01, NaN, 1.02, 1.03, 1.04]));
    assert.equal(check(result, 'priceSpike').status, UNKNOWN);
    assert.equal(check(result, 'priceCollapse').status, UNKNOWN);
    assert.equal(check(result, 'momentum').status, UNKNOWN);
  });
});

describe('momentum (signal)', () => {
  test('passes at or above the minimum, fails below', () => {
    assert.equal(check(evaluate(), 'momentum').status, PASS); // about +5.8%
    const flat = evaluate({ history: { prices: Array(6).fill(1), buys: Array(6).fill(7), sells: Array(6).fill(3) } });
    assert.equal(check(flat, 'momentum').status, FAIL);
    assert.equal(flat.decision, DECISION.NO_SIGNAL);
  });

  test('is measured over the last observationTicks ticks', () => {
    // Rises early, then flat from index 2: the window (index 2 to 5) shows no momentum.
    const prices = [1, 1.1, 1.3, 1.3, 1.3, 1.3];
    const result = evaluate({ history: { prices, buys: Array(6).fill(7), sells: Array(6).fill(3) } });
    assert.equal(check(result, 'momentum').status, FAIL);
    assert.equal(check(result, 'momentum').measured, 0);
  });

  test('a zero price at the start of the window cannot be used', () => {
    const prices = [1, 1.1, 0, 1.1, 1.1, 1.1];
    assert.equal(check(evaluate({ history: { prices, buys: Array(6).fill(7), sells: Array(6).fill(3) } }), 'momentum').status, UNKNOWN);
  });
});

describe('buy versus sell activity (signal)', () => {
  const withFlow = (buys, sells) => ({ history: { prices: goodHistory().prices, buys, sells } });

  test('a buy-heavy window passes; a sell-heavy window fails', () => {
    assert.equal(check(evaluate(withFlow(Array(6).fill(7), Array(6).fill(3))), 'buySellActivity').status, PASS);
    const sellHeavy = evaluate(withFlow(Array(6).fill(3), Array(6).fill(7)));
    assert.equal(check(sellHeavy, 'buySellActivity').status, FAIL);
    assert.equal(sellHeavy.decision, DECISION.NO_SIGNAL);
  });

  test('only the last observationTicks ticks count', () => {
    // Early buys are huge, but the last 3 ticks are sell-heavy.
    const result = evaluate(withFlow([50, 50, 50, 3, 3, 3], [1, 1, 1, 7, 7, 7]));
    const c = check(result, 'buySellActivity');
    assert.equal(c.status, FAIL);
    assert.deepEqual(c.measured, { buys: 9, sells: 21, total: 30, buySharePct: 30 });
  });

  test('missing, malformed or too-small samples are UNKNOWN, never a pass', () => {
    for (const [buys, sells] of [
      [null, null],
      [undefined, undefined],
      [Array(6).fill(7), null],
      [[7, 7, 7], [3, 3, 3]], // too short to cover the window
      [Array(6).fill(1.5), Array(6).fill(3)], // not integers
      [Array(6).fill(-1), Array(6).fill(3)],
      [Array(6).fill(1), Array(6).fill(2)], // 9 trades in the window, need 10
      [Array(6).fill(0), Array(6).fill(0)], // nothing traded
    ]) {
      const result = evaluate(withFlow(buys, sells));
      assert.equal(check(result, 'buySellActivity').status, UNKNOWN, JSON.stringify([buys, sells]));
    }
  });
});

describe('decision rules', () => {
  test('a mandatory FAIL beats a mandatory UNKNOWN: REJECTED, not BLOCKED', () => {
    const result = evaluate({ attributes: { mintAuthority: 'ACTIVE', permissionFlags: null } });
    assert.equal(result.mandatoryStatus, FAIL);
    assert.equal(result.decision, DECISION.REJECTED);
    assert.deepEqual(result.reasons, ['mintAuthority']);
  });

  test('UNKNOWN critical safety data BLOCKS entry, even when every signal passes', () => {
    for (const field of ['mintAuthority', 'freezeAuthority', 'permissionFlags', 'sellSimulation', 'topHolderPct', 'top10HolderPct', 'liquidityUsd', 'quoteReserveUsd']) {
      const result = evaluate({ attributes: { [field]: null } });
      assert.equal(result.signalsPassed, 2, `${field}: signals are strong`);
      assert.equal(result.mandatoryStatus, UNKNOWN, field);
      assert.equal(result.decision, DECISION.BLOCKED, field);
      assert.notEqual(result.decision, DECISION.APPROVED, field);
    }
  });

  test('strong signals never override a failed mandatory check', () => {
    const result = evaluate({ attributes: { sellSimulation: 'FAILED' } });
    assert.equal(result.signalsPassed, 2);
    assert.equal(result.decision, DECISION.REJECTED);
  });

  test('with mandatory checks passing, the decision depends on how many signals pass', () => {
    const noMomentum = { prices: Array(6).fill(1), buys: Array(6).fill(7), sells: Array(6).fill(3) };
    const result = evaluate({ history: noMomentum }); // momentum FAIL, activity PASS: 1 of 2, Balanced needs 2
    assert.equal(result.signalsPassed, 1);
    assert.equal(result.decision, DECISION.NO_SIGNAL);
    assert.deepEqual(result.reasons, ['momentum']);

    const oneIsEnough = resolveStrategyConfig('balanced', { minSignalsPassed: 1 });
    assert.equal(evaluate({ history: noMomentum, strategy: oneIsEnough }).decision, DECISION.APPROVED);
  });

  test('UNKNOWN signals are not counted as passes', () => {
    const noFlow = { history: { ...goodHistory(), buys: null, sells: null } };
    const needTwo = evaluate({ ...noFlow }); // momentum PASS, activity UNKNOWN
    assert.equal(check(needTwo, 'buySellActivity').status, UNKNOWN);
    assert.equal(needTwo.signalsPassed, 1);
    assert.equal(needTwo.decision, DECISION.NO_SIGNAL);
    assert.deepEqual(needTwo.reasons, ['buySellActivity']);

    const needOne = evaluate({ ...noFlow, strategy: resolveStrategyConfig('balanced', { minSignalsPassed: 1 }) });
    assert.equal(needOne.signalsPassed, 1); // still only 1 real pass: the unknown one did not count
    assert.equal(needOne.decision, DECISION.APPROVED);

    const allUnknown = evaluate({ history: { prices: goodHistory().prices, buys: null, sells: null }, strategy: resolveStrategyConfig('balanced', { minSignalsPassed: 2, observationTicks: 3 }) });
    assert.notEqual(allUnknown.decision, DECISION.APPROVED);
  });

  test('requiring zero signals approves any token whose mandatory checks all pass', () => {
    const noSignalsNeeded = resolveStrategyConfig('balanced', { minSignalsPassed: 0 });
    const hopeless = { prices: Array(6).fill(1), buys: Array(6).fill(1), sells: Array(6).fill(9) };
    const result = evaluate({ history: hopeless, strategy: noSignalsNeeded });
    assert.equal(result.signalsPassed, 0);
    assert.equal(result.decision, DECISION.APPROVED);
  });

  test('all checks run even when an early one fails (the report can show everything)', () => {
    const result = evaluate({ attributes: { mintAuthority: 'ACTIVE', sellSimulation: 'FAILED', liquidityUsd: 1 } });
    assert.equal(result.checks.length, 13);
    assert.deepEqual(result.reasons, ['mintAuthority', 'minLiquidity', 'sellability']);
  });
});