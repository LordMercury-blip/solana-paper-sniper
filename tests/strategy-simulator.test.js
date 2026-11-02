import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import defaultConfig from '../src/config.js';
import { createMockToken, DEFAULT_BASE_PRICE } from '../src/mock-feed.js';
import {
  ARCHETYPE_NAMES,
  SHOWCASE_TOKENS,
  createStrategyToken,
  createShowcaseToken,
} from '../src/mock-attributes.js';
import { PROFILE_NAMES, resolveStrategyConfig } from '../src/strategy-config.js';
import { runStrategySimulation, STRATEGY_EVENT } from '../src/strategy-simulator.js';

const BASE = DEFAULT_BASE_PRICE;
const withStop = { ...defaultConfig, stopLossEnabled: true };
const FIRST_ELIGIBLE = { conservative: 10, balanced: 5, aggressive: 2 }; // for a token with age 0

const near = (actual, expected, label = '') =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label} expected ${actual} to be about ${expected}`);

function run(tokens, { profile = 'balanced', overrides = {}, config = defaultConfig, closeOpenAtEnd = true, label } = {}) {
  return runStrategySimulation({
    tokens: Array.isArray(tokens) ? tokens : [tokens],
    strategy: resolveStrategyConfig(profile, overrides),
    config,
    closeOpenAtEnd,
    label,
  });
}
const tok = (scenario, archetype = 'healthy-momentum', extra = {}) =>
  createStrategyToken(scenario, { archetype, ...extra });
const ofType = (result, type) => result.events.filter((e) => e.type === type);

function assertAccounting(result) {
  const s = result.summary;
  assert.deepEqual(result.consistency, { ok: true, errors: [] });
  near(s.balanceUsd, result.config.startingBalanceUsd + s.totalRealizedPnlUsd - s.openCostBasisUsd, 'cash identity');
  assert.equal(s.openTrades, result.openPositions.length);
  assert.ok(result.peakOpenPositions <= result.config.maxOpenPositions);
  assert.equal(result.trades.length, result.counts.entriesAccepted, 'every trade came from an accepted entry');
}

describe('timing: observation, eligibility, decision and execution', () => {
  for (const profile of PROFILE_NAMES) {
    const d = FIRST_ELIGIBLE[profile];

    test(`${profile}: decides at tick ${d}, enters at tick ${d + 1} at that tick's price (not the launch price)`, () => {
      const token = tok('take-profit-run');
      const result = run(token, { profile });
      const decision = result.decisions[0];

      assert.equal(decision.firstEligibleIndex, d);
      assert.equal(decision.decisionTick, d);
      assert.equal(decision.decisionIndex, d);
      assert.equal(decision.status, 'EVALUATED');
      assert.equal(decision.strategyDecision, 'APPROVED');
      assert.equal(decision.executionTick, d + 1);
      assert.equal(decision.entryPrice, token.prices[d + 1]);
      assert.notEqual(decision.entryPrice, token.prices[0]);
      assert.notEqual(decision.entryPrice, token.prices[d], 'not the price the strategy decided on either');

      const trade = result.trades[0];
      assert.equal(trade.entryPrice, token.prices[d + 1]);
      assert.equal(trade.openedAt, d + 1);
    });
  }

  test('the DECISION event comes first and no entry ever happens on the decision tick', () => {
    const result = run(tok('take-profit-run'));
    const decision = ofType(result, STRATEGY_EVENT.DECISION)[0];
    const entry = ofType(result, STRATEGY_EVENT.ENTRY)[0];
    assert.equal(decision.tick, 5);
    assert.equal(entry.tick, 6);
    assert.ok(result.events.indexOf(decision) < result.events.indexOf(entry));
    assert.ok(ofType(result, STRATEGY_EVENT.ENTRY).every((e) => e.tick > decision.tick));
  });

  test('the observation window begins at the first feed tick, and startTick shifts everything', () => {
    const result = run(tok('take-profit-run', 'healthy-momentum', { startTick: 7 }));
    const decision = result.decisions[0];
    assert.equal(decision.decisionTick, 7 + 5);
    assert.equal(decision.decisionIndex, 5);
    assert.equal(decision.executionTick, 7 + 6);
    assert.equal(result.trades[0].openedAt, 13);
    assert.match(decision.checks.find((c) => c.id === 'observationWindow').detail, /5 ticks of history/);
    assert.equal(ofType(result, STRATEGY_EVENT.PRICE)[0].tick, 7, 'nothing is recorded before the token appears');
  });

  test('a token that already has some age waits less, but never less than the observation period', () => {
    const base = tok('take-profit-run');
    const older = { ...base, attributes: { ...base.attributes, ageAtFirstSeenTicks: 4 } };
    const result = run(older); // Balanced: max(3, 5 - 4) = 3
    assert.equal(result.decisions[0].firstEligibleIndex, 3);
    assert.equal(result.decisions[0].decisionTick, 3);
    assert.equal(result.decisions[0].executionTick, 4);
    assert.equal(result.decisions[0].strategyDecision, 'APPROVED');
  });

  test('a longer minimum age than the observation period makes the bot wait for the age', () => {
    const result = run(tok('take-profit-run'), { overrides: { minAgeTicks: 9 } });
    assert.equal(result.decisions[0].decisionTick, 9);
    assert.equal(result.decisions[0].executionTick, 10);
    assert.equal(result.decisions[0].checks.find((c) => c.id === 'tokenAge').status, 'PASS');
  });

  test('an unknown age does not shorten the wait and blocks the entry', () => {
    const base = tok('take-profit-run');
    const unknownAge = { ...base, attributes: { ...base.attributes, ageAtFirstSeenTicks: null } };
    const result = run(unknownAge);
    assert.equal(result.decisions[0].firstEligibleIndex, 3);
    assert.equal(result.decisions[0].strategyDecision, 'BLOCKED');
    assert.deepEqual(result.decisions[0].reasons, ['tokenAge']);
    assert.equal(result.trades.length, 0);
  });

  test('take-profit and stop-loss are calculated from the ACTUAL entry price, not the launch price', () => {
    const token = tok('take-profit-run');
    const result = run(token, { config: withStop });
    const trade = result.trades[0];
    const entry = ofType(result, STRATEGY_EVENT.ENTRY)[0];

    assert.equal(trade.takeProfitPrice, trade.entryPrice * 2);
    assert.equal(trade.stopLossPrice, trade.entryPrice * (1 - 0.4));
    assert.notEqual(trade.takeProfitPrice, token.prices[0] * 2);
    assert.notEqual(trade.stopLossPrice, token.prices[0] * (1 - 0.4));
    assert.equal(entry.launchPrice, token.prices[0]);
    assert.notEqual(entry.price, entry.launchPrice);
  });
});

describe('no look-ahead bias', () => {
  test('decisions and entries are identical whatever the future price path does', () => {
    for (const profile of PROFILE_NAMES) {
      const runs = ['take-profit-run', 'rug-pull', 'gradual-decline', 'sideways-then-dump'].map((scenario) =>
        run(tok(scenario, 'healthy-momentum', { seed: 3, symbol: 'MOCK-SAME' }), { profile })
      );
      const first = runs[0].decisions[0];
      for (const r of runs) {
        const d = r.decisions[0];
        assert.deepEqual(d.checks, first.checks, profile);
        assert.equal(d.strategyDecision, first.strategyDecision, profile);
        assert.equal(d.decisionTick, first.decisionTick, profile);
        assert.equal(d.executionTick, first.executionTick, profile);
        assert.equal(d.entryPrice, first.entryPrice, profile);
      }
    }
  });

  test('poisoned data after the decision cannot change the decision or the entry price', () => {
    const token = tok('take-profit-run');
    const d = 5;
    const poisoned = {
      ...token,
      prices: token.prices.map((p, i) => (i >= d + 2 ? 1e9 : p)), // entry price (d + 1) stays real
      buys: token.buys.map((b, i) => (i > d ? 9999 : b)),
      sells: token.sells.map((s, i) => (i > d ? 0 : s)),
    };
    const clean = run(token).decisions[0];
    const dirty = run(poisoned).decisions[0];
    assert.deepEqual(dirty.checks, clean.checks);
    assert.equal(dirty.strategyDecision, clean.strategyDecision);
    assert.equal(dirty.entryPrice, clean.entryPrice);
  });

  test('a spike that happens after the decision is not seen: one tick of latency means the bot buys into it', () => {
    const token = tok('take-profit-run');
    const spiked = { ...token, prices: token.prices.map((p, i) => (i >= 6 ? p * 1.9 : p)) };
    const calm = run(token).decisions[0];
    const result = run(spiked);
    const decision = result.decisions[0];

    assert.equal(decision.strategyDecision, 'APPROVED', 'the strategy could not know about the future spike');
    assert.deepEqual(decision.checks, calm.checks);
    assert.equal(decision.entryPrice, spiked.prices[6]);
    assert.ok(decision.entryPrice / spiked.prices[5] > 1.9, 'it paid the spiked price');
  });

  test('a spike BEFORE the decision is seen and rejected by the profiles that observed it', () => {
    const result = run(tok('take-profit-run', 'pumped'));
    assert.equal(result.decisions[0].strategyDecision, 'REJECTED');
    assert.deepEqual(result.decisions[0].reasons, ['priceSpike']);
  });
});

describe('every profile against every fabricated archetype', () => {
  const R = 'REJECTED';
  const B = 'BLOCKED';
  // [conservative, balanced, aggressive]
  const EXPECTED = {
    'healthy-momentum': ['APPROVED', 'APPROVED', 'APPROVED'],
    'no-momentum': ['NO_SIGNAL', 'NO_SIGNAL', 'NO_SIGNAL'],
    'quiet-token': ['NO_SIGNAL', 'NO_SIGNAL', 'APPROVED'],
    'unsafe-authority': [R, R, R],
    'unsafe-honeypot': [R, R, R],
    'unsafe-permissions': [R, R, R],
    'whale-concentrated': [R, R, R],
    'thin-liquidity': [R, R, R],
    'thin-depth': [R, R, R],
    'unknown-data': [B, B, B],
    pumped: [R, R, R],
    collapsing: [R, R, R],
    'short-history': [B, B, B],
  };

  test('the table covers every archetype', () => {
    assert.deepEqual(Object.keys(EXPECTED).sort(), [...ARCHETYPE_NAMES].sort());
  });

  for (const archetype of ARCHETYPE_NAMES) {
    test(`${archetype}: decisions are ${EXPECTED[archetype].join(' / ')} and stable across seeds`, () => {
      for (const seed of [1, 7, 42]) {
        PROFILE_NAMES.forEach((profile, i) => {
          const result = run(tok('sideways-then-pump', archetype, { seed }), { profile });
          assert.equal(result.decisions[0].strategyDecision, EXPECTED[archetype][i], `${profile}, seed ${seed}`);
        });
      }
    });
  }

  test('the specific checks that fail or are unknown, per archetype', () => {
    const reasons = (archetype, profile = 'balanced') => run(tok('rug-pull', archetype), { profile }).decisions[0].reasons;
    for (const profile of PROFILE_NAMES) {
      assert.deepEqual(reasons('unsafe-authority', profile), ['mintAuthority', 'freezeAuthority']);
      assert.deepEqual(reasons('unsafe-honeypot', profile), ['sellability']);
      assert.deepEqual(reasons('unsafe-permissions', profile), ['suspiciousPermissions']);
      assert.deepEqual(reasons('whale-concentrated', profile), ['holderConcentration']);
      assert.deepEqual(reasons('thin-depth', profile), ['priceImpact']);
      assert.deepEqual(reasons('pumped', profile), ['priceSpike']);
      assert.deepEqual(reasons('collapsing', profile), ['priceCollapse']);
      assert.deepEqual(reasons('unknown-data', profile), ['mintAuthority', 'freezeAuthority', 'suspiciousPermissions', 'sellability']);
      assert.ok(reasons('thin-liquidity', profile).includes('minLiquidity'));
    }
    assert.deepEqual(reasons('thin-liquidity', 'balanced'), ['minLiquidity']);
    assert.deepEqual(reasons('no-momentum'), ['momentum', 'buySellActivity']);
    assert.deepEqual(reasons('quiet-token'), ['buySellActivity']);
  });

  test('quiet-token: the unknown signal is not counted, so Aggressive enters on momentum alone', () => {
    const aggressive = run(tok('take-profit-run', 'quiet-token'), { profile: 'aggressive' }).decisions[0];
    assert.equal(aggressive.checks.find((c) => c.id === 'buySellActivity').status, 'UNKNOWN');
    assert.equal(aggressive.checks.find((c) => c.id === 'momentum').status, 'PASS');
    assert.equal(aggressive.signalsPassed, 1);
    assert.equal(aggressive.strategyDecision, 'APPROVED');
    const balanced = run(tok('take-profit-run', 'quiet-token'), { profile: 'balanced' }).decisions[0];
    assert.equal(balanced.signalsPassed, 1);
    assert.equal(balanced.strategyDecision, 'NO_SIGNAL');
  });

  test('short-history: no profile ever becomes eligible, and that is recorded as such', () => {
    for (const profile of PROFILE_NAMES) {
      const result = run(tok('take-profit-run', 'short-history'), { profile });
      const d = result.decisions[0];
      assert.equal(d.status, 'NOT_ELIGIBLE_BEFORE_FEED_END');
      assert.equal(d.strategyDecision, 'BLOCKED');
      assert.ok(d.reasons.includes('observationWindow'));
      assert.equal(d.riskDecision, 'NOT_REQUESTED');
      assert.equal(result.trades.length, 0);
      assert.equal(result.summary.balanceUsd, 10);
    }
  });
});

describe('price impact genuinely triggers a rejection', () => {
  test('thin-depth passes the liquidity floor but is rejected on price impact alone, and nothing is traded', () => {
    const result = run(tok('take-profit-run', 'thin-depth'));
    const d = result.decisions[0];
    assert.equal(d.checks.find((c) => c.id === 'minLiquidity').status, 'PASS');
    assert.equal(d.checks.find((c) => c.id === 'priceImpact').status, 'FAIL');
    assert.equal(d.checks.filter((c) => c.status !== 'PASS').length, 1);
    assert.equal(d.strategyDecision, 'REJECTED');
    assert.equal(d.riskDecision, 'NOT_REQUESTED');
    assert.equal(result.trades.length, 0);
    assert.equal(result.summary.balanceUsd, 10);
  });

  test('loosening only the impact limit lets the same token through, so the impact check was the blocker', () => {
    const result = run(tok('take-profit-run', 'thin-depth'), { overrides: { maxPriceImpactBps: 1000 } });
    assert.equal(result.decisions[0].strategyDecision, 'APPROVED');
    assert.equal(result.trades.length, 1);
  });

  test('price impact is independent of the ledger fee: fees change PnL, never the strategy decision', () => {
    const free = run(tok('take-profit-run'), { config: { ...defaultConfig, tradingFeeRate: 0 } });
    const costly = run(tok('take-profit-run'), { config: { ...defaultConfig, tradingFeeRate: 0.01 } });
    assert.deepEqual(costly.decisions[0].checks, free.decisions[0].checks);
    assert.equal(costly.decisions[0].strategyDecision, 'APPROVED');
    near(free.summary.totalRealizedPnlUsd, 1);
    near(costly.summary.totalRealizedPnlUsd, 0.97);
    assertAccounting(costly);
  });
});

describe('the risk manager remains the final authority', () => {
  const healthyDecliners = (starts) =>
    starts.map((start, i) => tok('gradual-decline', 'healthy-momentum', { startTick: start, symbol: `MOCK-HOLD-${i + 1}` }));

  test('a strategy-approved token is rejected when both position slots are taken', () => {
    const result = run(healthyDecliners([0, 1, 2]), { closeOpenAtEnd: false });
    const third = result.decisions[2];

    assert.equal(third.strategyDecision, 'APPROVED');
    assert.equal(third.riskDecision, 'REJECTED');
    assert.equal(third.riskReason, 'MAX_OPEN_POSITIONS');
    assert.equal(third.executionTick, 8);
    assert.equal(third.tradeId, null);
    assert.equal(third.entryPrice, null);

    assert.equal(result.trades.length, 2);
    assert.equal(result.counts.strategyApproved, 3);
    assert.equal(result.counts.entriesAccepted, 2);
    assert.equal(result.counts.entriesRejectedByRisk, 1);
    assert.equal(result.peakOpenPositions, 2);
    assert.equal(result.summary.openTrades, 2);
    assertAccounting(result);
  });

  test('a rejected entry creates no position and leaves the balance exactly as it was', () => {
    const three = run(healthyDecliners([0, 1, 2]), { closeOpenAtEnd: false });
    const two = run(healthyDecliners([0, 1]), { closeOpenAtEnd: false });
    assert.equal(three.summary.balanceUsd, two.summary.balanceUsd);
    assert.equal(three.summary.balanceUsd, 8);
    assert.deepEqual(three.trades, two.trades);

    const rejected = three.decisions[2].symbol;
    const later = ofType(three, STRATEGY_EVENT.PRICE).filter((e) => e.symbol === rejected && e.tick > 8);
    assert.ok(later.length > 0 && later.every((e) => e.position === 'NONE'));
    assert.equal(ofType(three, STRATEGY_EVENT.ENTRY_REJECTED).length, 1);
    assert.equal(ofType(three, STRATEGY_EVENT.ENTRY).filter((e) => e.symbol === rejected).length, 0);
  });

  test('the strategy never retries a rejected entry, even after a slot frees up', () => {
    const tokens = [
      tok('take-profit-run', 'healthy-momentum', { startTick: 0, symbol: 'MOCK-A' }),
      tok('gradual-decline', 'healthy-momentum', { startTick: 1, symbol: 'MOCK-B' }),
      tok('sideways-then-pump', 'healthy-momentum', { startTick: 2, symbol: 'MOCK-C' }), // enters tick 8: rejected
    ];
    const result = run(tokens);
    assert.equal(result.decisions[2].riskDecision, 'REJECTED');
    const aExit = ofType(result, STRATEGY_EVENT.EXIT).find((e) => e.symbol === 'MOCK-A');
    assert.ok(aExit.tick > 8, 'a slot freed up later');
    assert.equal(result.trades.length, 2, 'MOCK-C was never traded');
    assert.equal(ofType(result, STRATEGY_EVENT.ENTRY).filter((e) => e.symbol === 'MOCK-C').length, 0);
  });

  test('insufficient balance is also a risk-manager rejection of an approved token', () => {
    const config = { ...defaultConfig, startingBalanceUsd: 2, maxOpenPositions: 3 };
    const result = run(healthyDecliners([0, 1, 2]), { config, closeOpenAtEnd: false });
    assert.equal(result.decisions[2].strategyDecision, 'APPROVED');
    assert.equal(result.decisions[2].riskDecision, 'REJECTED');
    assert.equal(result.decisions[2].riskReason, 'INSUFFICIENT_BALANCE');
    assert.equal(result.summary.balanceUsd, 0);
    assert.equal(result.trades.length, 2);
    assertAccounting(result);
  });

  test('after realized losses reach the daily limit, an approved token is rejected', () => {
    // Four rug-pulls, spaced so each position has stopped out before the next entry.
    const tokens = [0, 16, 32, 48].map((start, i) => tok('rug-pull', 'healthy-momentum', { startTick: start, symbol: `MOCK-RUG-${i + 1}` }));
    const result = run(tokens, { config: withStop });

    assert.deepEqual(result.decisions.map((d) => d.strategyDecision), ['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED']);
    assert.deepEqual(result.decisions.map((d) => d.riskDecision), ['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'REJECTED']);
    assert.equal(result.decisions[3].riskReason, 'DAILY_LOSS_LIMIT');
    assert.equal(result.decisions[3].executionTick, 48 + 6);

    assert.equal(result.trades.length, 3);
    assert.ok(result.trades.every((t) => t.closeReason === 'STOP_LOSS'));
    assert.ok(result.summary.dailyPnlUsd < -2.8 && result.summary.dailyPnlUsd > -3.0);
    assert.equal(result.summary.openTrades, 0);
    assert.equal(result.counts.losses, 3);
    assertAccounting(result);
  });

  test('unrealized losses never block an approved entry', () => {
    // MOCK-A rugs on paper (stop-loss off, position stays open); MOCK-B still gets in.
    const tokens = [
      tok('rug-pull', 'healthy-momentum', { startTick: 0, symbol: 'MOCK-A' }),
      tok('take-profit-run', 'healthy-momentum', { startTick: 10, symbol: 'MOCK-B' }),
    ];
    const result = run(tokens, { closeOpenAtEnd: false });
    assert.equal(result.decisions[1].riskDecision, 'ACCEPTED');
    assert.equal(result.summary.dailyPnlUsd, result.summary.totalRealizedPnlUsd);
    assertAccounting(result);
  });

  test('the showcase portfolio: 3 approved, the third turned away by the risk manager', () => {
    const tokens = SHOWCASE_TOKENS.map((t, i) => createShowcaseToken(t.id, { startTick: i }));
    const result = run(tokens, { closeOpenAtEnd: false });
    assert.equal(result.counts.tokens, 15);
    assert.equal(result.counts.strategyApproved, 3);
    assert.equal(result.counts.strategyRejected, 8);
    assert.equal(result.counts.strategyBlocked, 2);
    assert.equal(result.counts.strategyNoSignal, 2);
    assert.equal(result.counts.entriesAccepted, 2);
    assert.equal(result.counts.entriesRejectedByRisk, 1);
    assert.equal(result.decisions[2].riskReason, 'MAX_OPEN_POSITIONS');
    assertAccounting(result);
  });
});

describe('exit behavior inside strategy runs', () => {
  test('Conservative enters exactly at the anchor, so the Stage 3 path plays out unchanged: take-profit at 2x', () => {
    const result = run(tok('take-profit-run'), { profile: 'conservative' });
    const trade = result.trades[0];
    assert.equal(trade.entryPrice, BASE);
    assert.equal(trade.closeReason, 'TAKE_PROFIT');
    assert.equal(trade.exitPrice, BASE * 2);
    assert.equal(trade.closedAt, 11 + 6, 'Stage 3 reaches 2x six ticks after the anchor');
    near(trade.realizedPnlUsd, 1);
    assert.equal(trade.outcome, 'WIN');
  });

  test('take-profit fills at the trigger price even when the price is already above it (gap)', () => {
    const result = run(tok('take-profit-run'), { profile: 'balanced' });
    const trade = result.trades[0];
    const exit = ofType(result, STRATEGY_EVENT.EXIT)[0];
    const observed = ofType(result, STRATEGY_EVENT.PRICE).find((e) => e.tick === exit.tick).price;

    assert.equal(exit.reason, 'TAKE_PROFIT');
    assert.equal(exit.forced, false);
    assert.equal(exit.exitPrice, trade.takeProfitPrice);
    assert.ok(observed > trade.takeProfitPrice, 'the observed price had already gapped above the target');
    near(trade.realizedPnlUsd, 1, 'capped at exactly 2x, not the larger move seen');
  });

  test('stop-loss fills at the OBSERVED price when the price gaps through the trigger', () => {
    const token = tok('rug-pull');
    const result = run(token, { config: withStop });
    const trade = result.trades[0];
    const exit = ofType(result, STRATEGY_EVENT.EXIT)[0];

    assert.equal(exit.reason, 'STOP_LOSS');
    assert.equal(exit.forced, false);
    assert.equal(exit.exitPrice, token.prices[exit.tick]);
    assert.ok(exit.exitPrice < trade.stopLossPrice, 'filled well below the trigger');
    assert.ok(trade.realizedPnlUsd < -0.95, 'lost far more than the 40% the trigger represents');
    assert.equal(trade.outcome, 'LOSS');
    assertAccounting(result);
  });

  test('with stop-loss DISABLED a collapse closes nothing; it is an unrealized loss while the position is open', () => {
    const result = run(tok('rug-pull'), { closeOpenAtEnd: false });
    assert.equal(ofType(result, STRATEGY_EVENT.EXIT).length, 0);
    assert.equal(result.trades[0].stopLossPrice, null);
    assert.equal(result.trades[0].status, 'OPEN');
    assert.equal(result.trades[0].closeReason, null);
    assert.ok(result.summary.unrealizedPnlUsd < -0.95);
    assert.equal(result.summary.totalRealizedPnlUsd, 0);
    assert.equal(result.summary.dailyPnlUsd, 0);
    assert.equal(result.summary.losses, 0, 'an open position is never silently counted as a closed loss');
    near(result.summary.balanceUsd, 9);
    assert.equal(result.openTradesAtEnd, 1);
    assertAccounting(result);
  });

  test('a 40% decline closes nothing when stop-loss is disabled, and closes at the observed price when enabled', () => {
    const off = run(tok('gradual-decline'), { closeOpenAtEnd: false });
    assert.equal(ofType(off, STRATEGY_EVENT.EXIT).length, 0);
    assert.equal(off.openTradesAtEnd, 1);

    const on = run(tok('gradual-decline'), { config: withStop });
    const [exit] = ofType(on, STRATEGY_EVENT.EXIT);
    assert.equal(exit.reason, 'STOP_LOSS', 'the stop wins over the end-of-feed close on the same tick');
    assert.equal(exit.forced, false);
    assert.equal(exit.exitPrice, BASE * 0.5);
    assert.ok(exit.realizedPnlUsd < -0.4 && exit.realizedPnlUsd > -0.5);
  });

  test('strategy exits (take-profit, stop-loss) are never labelled as forced', () => {
    for (const scenario of ['take-profit-run', 'sideways-then-pump']) {
      const result = run(tok(scenario));
      assert.ok(ofType(result, STRATEGY_EVENT.EXIT).every((e) => e.forced === false), scenario);
      assert.equal(result.counts.forcedFeedEndClosures, 0, scenario);
    }
  });
});

describe('end of feed', () => {
  test('enabled: the open position is closed with the explicit reason FEED_ENDED and labelled forced', () => {
    const result = run(tok('rug-pull'), { closeOpenAtEnd: true });
    const [exit] = ofType(result, STRATEGY_EVENT.EXIT);
    assert.equal(exit.reason, 'FEED_ENDED');
    assert.equal(exit.forced, true);
    assert.equal(result.trades[0].closeReason, 'FEED_ENDED');
    assert.notEqual(result.trades[0].closeReason, 'MANUAL');
    assert.ok(exit.realizedPnlUsd < -0.95);
    assert.equal(exit.outcome, 'LOSS');
    assert.equal(result.counts.forcedFeedEndClosures, 1);
    assert.equal(result.openTradesAtEnd, 0);
    assert.deepEqual(result.openPositions, []);
    assert.equal(result.summary.unrealizedPnlUsd, 0);
    assertAccounting(result);
  });

  test('disabled: the position stays open, with realized and unrealized PnL kept separate', () => {
    const result = run(tok('gradual-decline'), { closeOpenAtEnd: false });
    assert.equal(result.closeOpenAtEnd, false);
    assert.equal(result.openTradesAtEnd, 1);
    assert.equal(result.counts.forcedFeedEndClosures, 0);
    assert.equal(result.summary.totalRealizedPnlUsd, 0);
    assert.ok(result.summary.unrealizedPnlUsd < 0);
    assert.equal(result.openPositions[0].unrealizedPnlUsd, result.summary.unrealizedPnlUsd);
    assertAccounting(result);
  });

  test('closing at the end of the feed frees slots for later tokens in the same run', () => {
    const tokens = [
      tok('gradual-decline', 'healthy-momentum', { startTick: 0, symbol: 'MOCK-EARLY-1' }),
      tok('gradual-decline', 'healthy-momentum', { startTick: 1, symbol: 'MOCK-EARLY-2' }),
      tok('take-profit-run', 'healthy-momentum', { startTick: 40, symbol: 'MOCK-LATE' }),
    ];
    const result = run(tokens);
    assert.equal(result.decisions[2].riskDecision, 'ACCEPTED');
    assert.equal(result.counts.forcedFeedEndClosures, 2);
    assertAccounting(result);
  });

  test('a decision on the very last tick has no execution price: no entry is attempted', () => {
    const result = run(tok('take-profit-run', 'healthy-momentum', { historyTicks: 3 }), { profile: 'aggressive' });
    const d = result.decisions[0];
    assert.equal(d.strategyDecision, 'APPROVED');
    assert.equal(d.riskDecision, 'NOT_REQUESTED');
    assert.equal(d.noExecutionReason, 'NO_NEXT_PRICE');
    assert.equal(result.trades.length, 0);
    assert.equal(result.summary.balanceUsd, 10);
    assert.equal(result.counts.noExecutionPrice, 1);
    assert.equal(ofType(result, STRATEGY_EVENT.NO_EXECUTION).length, 1);
    assertAccounting(result);
  });

  test('an entry on the final tick is possible; by default it is then force-closed at once (break-even, labelled FEED_ENDED)', () => {
    const token = tok('take-profit-run', 'healthy-momentum', { historyTicks: 4 });
    const closed = run(token, { profile: 'aggressive' });
    assert.equal(closed.trades[0].openedAt, 3);
    assert.equal(closed.trades[0].closedAt, 3);
    assert.equal(closed.trades[0].closeReason, 'FEED_ENDED');
    assert.equal(closed.trades[0].outcome, 'BREAK_EVEN');

    const open = run(token, { profile: 'aggressive', closeOpenAtEnd: false });
    assert.equal(open.openTradesAtEnd, 1);
    assert.equal(open.summary.unrealizedPnlUsd, 0);
  });
});

describe('the clean-looking rug: the filters are imperfect', () => {
  test('a token that looks identical to a winner passes every profile, then rugs', () => {
    const symbol = 'MOCK-LOOKALIKE';
    for (const profile of PROFILE_NAMES) {
      const winner = run(tok('take-profit-run', 'healthy-momentum', { seed: 5, symbol }), { profile });
      const rug = run(tok('rug-pull', 'healthy-momentum', { seed: 5, symbol }), { profile });

      assert.equal(winner.decisions[0].strategyDecision, 'APPROVED', profile);
      assert.equal(rug.decisions[0].strategyDecision, 'APPROVED', profile);
      assert.deepEqual(rug.decisions[0].checks, winner.decisions[0].checks, `${profile}: the filters saw exactly the same thing`);
      assert.ok(rug.decisions[0].checks.every((c) => c.status === 'PASS'), profile);

      near(winner.summary.totalRealizedPnlUsd, 1);
      assert.ok(rug.summary.totalRealizedPnlUsd < -0.9, `${profile}: the rug lost nearly the whole position`);
    }
  });

  test('conversely, a rejected token can be one that would have won: filters are not profit predictors either', () => {
    const honeypot = run(tok('sideways-then-pump', 'unsafe-honeypot'));
    const healthy = run(tok('sideways-then-pump', 'healthy-momentum'));
    assert.equal(honeypot.decisions[0].strategyDecision, 'REJECTED');
    assert.equal(honeypot.summary.totalRealizedPnlUsd, 0);
    near(healthy.summary.totalRealizedPnlUsd, 1);
  });

  test('a promising token that fades is approved and loses', () => {
    const result = run(tok('gradual-decline'));
    assert.equal(result.decisions[0].strategyDecision, 'APPROVED');
    assert.ok(result.summary.totalRealizedPnlUsd < 0);
  });
});

describe('ledger consistency and single closure', () => {
  const allTokens = () => SHOWCASE_TOKENS.map((t) => createShowcaseToken(t.id));

  test('holds for every showcase token, profile, stop-loss setting and end-of-feed setting', () => {
    for (const token of allTokens()) {
      for (const profile of PROFILE_NAMES) {
        for (const config of [defaultConfig, withStop]) {
          for (const closeOpenAtEnd of [true, false]) {
            const result = run(token, { profile, config, closeOpenAtEnd });
            assertAccounting(result);
            if (closeOpenAtEnd) assert.equal(result.openTradesAtEnd, 0, token.symbol);
          }
        }
      }
    }
  });

  test('holds for the portfolio, and each trade closes exactly once', () => {
    for (const config of [defaultConfig, withStop]) {
      const tokens = SHOWCASE_TOKENS.map((t, i) => createShowcaseToken(t.id, { startTick: i }));
      const result = run(tokens, { config });
      assertAccounting(result);

      const exits = ofType(result, STRATEGY_EVENT.EXIT);
      const exitsPerTrade = new Map();
      for (const e of exits) exitsPerTrade.set(e.tradeId, (exitsPerTrade.get(e.tradeId) ?? 0) + 1);
      for (const trade of result.trades) {
        assert.equal(exitsPerTrade.get(trade.id), 1, `trade ${trade.id} exits exactly once`);
        assert.equal(trade.status, 'CLOSED');
      }
      assert.equal(exits.length, result.summary.closedTrades);

      const exitPnl = exits.reduce((sum, e) => sum + e.realizedPnlUsd, 0);
      near(exitPnl, result.summary.totalRealizedPnlUsd);
      near(exitPnl, result.summary.dailyPnlUsd);
      near(result.summary.balanceUsd, 10 + exitPnl);
    }
  });

  test('a position freed by a closure is not freed twice: open count never goes negative or exceeds the limit', () => {
    const tokens = SHOWCASE_TOKENS.map((t, i) => createShowcaseToken(t.id, { startTick: i * 2 }));
    const result = run(tokens, { config: withStop });
    assert.ok(result.peakOpenPositions <= 2);
    assert.equal(result.summary.openTrades, 0);
    assertAccounting(result);
  });
});

describe('determinism', () => {
  test('every showcase token under every profile repeats exactly', () => {
    for (const entry of SHOWCASE_TOKENS) {
      for (const profile of PROFILE_NAMES) {
        const a = run(createShowcaseToken(entry.id, { seed: 11 }), { profile, config: withStop });
        const b = run(createShowcaseToken(entry.id, { seed: 11 }), { profile, config: withStop });
        assert.deepEqual(a, b, `${entry.id} / ${profile}`);
      }
    }
  });

  test('the portfolio repeats exactly', () => {
    const build = () => SHOWCASE_TOKENS.map((t, i) => createShowcaseToken(t.id, { seed: 3, startTick: i }));
    assert.deepEqual(run(build()), run(build()));
  });

  test('a different seed changes the fabricated attributes and prices', () => {
    const a = run(createShowcaseToken('promising-runner', { seed: 1 }));
    const b = run(createShowcaseToken('promising-runner', { seed: 2 }));
    assert.notDeepEqual(a.tokens[0].attributes, b.tokens[0].attributes);
    assert.notEqual(a.decisions[0].entryPrice, b.decisions[0].entryPrice);
  });
});

describe('input validation and result labelling', () => {
  test('results are labelled simulated and fabricated', () => {
    const result = run(tok('take-profit-run'));
    assert.equal(result.simulated, true);
    assert.equal(result.entryPolicy, 'strategy');
    assert.equal(result.dataSource, 'FABRICATED_MOCK_DATA');
    assert.equal(result.strategy.profile, 'balanced');
    assert.equal(result.tokens[0].attributes.dataSource, 'FABRICATED_MOCK_DATA');
    assert.ok(result.tokens.every((t) => t.symbol.startsWith('MOCK-')));
  });

  test('only fabricated strategy tokens are accepted', () => {
    const stage3Token = createMockToken('rug-pull');
    assert.throws(() => run(stage3Token), /Only fabricated mock tokens/);
    assert.throws(() => run({ ...tok('rug-pull'), dataSource: 'REAL' }), /Only fabricated mock tokens/);
    assert.throws(() => run({ ...tok('rug-pull'), symbol: 'BONK' }), /MOCK-/);
  });

  test('rejects malformed tokens, duplicates, empty lists and bad configs', () => {
    assert.throws(() => run([]), /non-empty/);
    assert.throws(() => runStrategySimulation({ tokens: [tok('rug-pull')] }), /strategy/i);
    assert.throws(() => run([tok('rug-pull'), tok('rug-pull')]), /Duplicate token symbol/);
    assert.throws(() => run({ ...tok('rug-pull'), startTick: -1 }), /startTick/);
    assert.throws(() => run({ ...tok('rug-pull'), prices: [1] }), /at least 2/);
    assert.throws(() => run({ ...tok('rug-pull'), prices: [1, NaN, 2] }), /prices/);
    assert.throws(() => run({ ...tok('rug-pull'), buys: [1, 2] }), /buys/);
    assert.throws(() => run({ ...tok('rug-pull'), attributes: null }), /attributes/);
    assert.throws(() => run(tok('rug-pull'), { config: { ...defaultConfig, paperTradingOnly: false } }), /paperTradingOnly/);
    assert.throws(() => runStrategySimulation({ tokens: [tok('rug-pull')], strategy: { observationTicks: 0 } }), /Invalid strategy config/);
  });

  test('missing activity data (null arrays) is allowed and simply makes the activity signal UNKNOWN', () => {
    const base = tok('take-profit-run');
    const result = run({ ...base, buys: null, sells: null }, { profile: 'aggressive' });
    assert.equal(result.decisions[0].checks.find((c) => c.id === 'buySellActivity').status, 'UNKNOWN');
    assert.equal(result.decisions[0].strategyDecision, 'APPROVED'); // momentum alone satisfies Aggressive
  });
});