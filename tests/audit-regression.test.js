import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import defaultConfig from '../src/config.js';
import { createRng, SCENARIO_NAMES } from '../src/mock-feed.js';
import { createStrategyToken, ARCHETYPE_NAMES } from '../src/mock-attributes.js';
import { PROFILE_NAMES, resolveStrategyConfig, firstEligibleIndex } from '../src/strategy-config.js';
import { runStrategySimulation } from '../src/strategy-simulator.js';
import {
  CHECK_STATUS,
  DECISION,
  PERMISSION_FLAGS,
  PERMISSION_RISK,
  classifyPermissionFlag,
  evaluateEntry,
} from '../src/entry-checks.js';
import { parseCliArgs, runCli } from '../src/cli.js';

const { PASS, FAIL, UNKNOWN } = CHECK_STATUS;
const BALANCED = resolveStrategyConfig('balanced');
const ORDER = { sizeUsd: 1, takeProfitMultiplier: 2 };

const goodAttributes = () => ({
  mintAuthority: 'REVOKED', freezeAuthority: 'REVOKED', permissionFlags: [],
  topHolderPct: 8, top10HolderPct: 30, liquidityUsd: 50000, quoteReserveUsd: 25000,
  sellSimulation: 'SUCCEEDED', ageAtFirstSeenTicks: 0,
});
const goodHistory = () => ({
  prices: Array.from({ length: 6 }, (_, i) => 1 + 0.02 * i),
  buys: Array(6).fill(7),
  sells: Array(6).fill(3),
});
const evaluate = (attributes = {}, strategy = BALANCED) =>
  evaluateEntry({ history: goodHistory(), attributes: { ...goodAttributes(), ...attributes }, strategy, order: ORDER });
const check = (result, id) => result.checks.find((c) => c.id === id);

function capture(argv) {
  const out = [];
  const err = [];
  const code = runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, text: out.join('\n'), errText: err.join('\n') };
}

describe('audit fix 1: invalid holder data never approves a token', () => {
  test('negative shares are UNKNOWN and block entry', () => {
    for (const [top, top10] of [[-1, 30], [8, -1], [-0.0001, 30], [8, -5], [-1, -1]]) {
      const result = evaluate({ topHolderPct: top, top10HolderPct: top10 });
      assert.equal(check(result, 'holderConcentration').status, UNKNOWN, `${top}/${top10}`);
      assert.equal(result.decision, DECISION.BLOCKED, `${top}/${top10}`);
    }
  });

  test('an impossible combination (top-10 share below the top holder share) is UNKNOWN; equal is fine', () => {
    assert.equal(check(evaluate({ topHolderPct: 15, top10HolderPct: 10 }), 'holderConcentration').status, UNKNOWN);
    assert.equal(check(evaluate({ topHolderPct: 8, top10HolderPct: 8 }), 'holderConcentration').status, PASS);
  });

  test('a real violation still FAILS even when the data is also inconsistent', () => {
    assert.equal(check(evaluate({ topHolderPct: 25, top10HolderPct: 10 }), 'holderConcentration').status, FAIL);
  });

  test('end to end: a token with a negative holder share is blocked, no position, balance untouched', () => {
    const token = createStrategyToken('take-profit-run');
    token.attributes.topHolderPct = -1;
    const result = runStrategySimulation({ tokens: [token], strategy: BALANCED });
    assert.equal(result.decisions[0].strategyDecision, 'BLOCKED');
    assert.deepEqual(result.decisions[0].reasons, ['holderConcentration']);
    assert.equal(result.decisions[0].riskDecision, 'NOT_REQUESTED');
    assert.equal(result.trades.length, 0);
    assert.equal(result.summary.balanceUsd, 10);
  });
});

describe('audit fix 2: permission flags are interpreted in tiers, not all alike', () => {
  const byRisk = (risk) => Object.entries(PERMISSION_FLAGS).filter(([, v]) => v.risk === risk).map(([k]) => k);

  test('the table is well formed and has all three tiers', () => {
    for (const [flag, info] of Object.entries(PERMISSION_FLAGS)) {
      assert.ok(Object.values(PERMISSION_RISK).includes(info.risk), flag);
      assert.ok(info.note.length > 10, flag);
    }
    for (const risk of Object.values(PERMISSION_RISK)) assert.ok(byRisk(risk).length > 0, risk);
  });

  test('genuinely high-risk flags versus flags that need inspection versus informational ones', () => {
    assert.ok(['PERMANENT_DELEGATE', 'NON_TRANSFERABLE', 'DEFAULT_ACCOUNT_STATE_FROZEN'].every((f) => byRisk('HIGH_RISK').includes(f)));
    assert.ok(['TRANSFER_HOOK', 'TRANSFER_FEE'].every((f) => byRisk('NEEDS_INSPECTION').includes(f)));
    assert.ok(byRisk('INFORMATIONAL').includes('METADATA_POINTER'));
  });

  test('each flag, alone, gives the verdict of its tier', () => {
    const expected = { HIGH_RISK: FAIL, NEEDS_INSPECTION: UNKNOWN, INFORMATIONAL: PASS };
    for (const [flag, info] of Object.entries(PERMISSION_FLAGS)) {
      assert.equal(check(evaluate({ permissionFlags: [flag] }), 'suspiciousPermissions').status, expected[info.risk], flag);
    }
  });

  test('high-risk is REJECTED; needs-inspection is BLOCKED (not rejected); informational alone is approved', () => {
    assert.equal(evaluate({ permissionFlags: ['PERMANENT_DELEGATE'] }).decision, DECISION.REJECTED);
    const inspect = evaluate({ permissionFlags: ['TRANSFER_FEE'] });
    assert.equal(inspect.decision, DECISION.BLOCKED);
    assert.deepEqual(inspect.reasons, ['suspiciousPermissions']);
    assert.match(check(inspect, 'suspiciousPermissions').detail, /needs inspection.*TRANSFER_FEE/);
    const info = evaluate({ permissionFlags: ['METADATA_POINTER', 'TOKEN_METADATA'] });
    assert.equal(info.decision, DECISION.APPROVED);
    assert.match(check(info, 'suspiciousPermissions').detail, /only informational flags/);
  });

  test('mixtures: high-risk wins over needs-inspection, which wins over informational', () => {
    const high = check(evaluate({ permissionFlags: ['METADATA_POINTER', 'TRANSFER_HOOK', 'PERMANENT_DELEGATE'] }), 'suspiciousPermissions');
    assert.equal(high.status, FAIL);
    assert.match(high.detail, /PERMANENT_DELEGATE/);
    assert.match(high.detail, /also needs inspection: TRANSFER_HOOK/);
    assert.equal(check(evaluate({ permissionFlags: ['METADATA_POINTER', 'TRANSFER_HOOK'] }), 'suspiciousPermissions').status, UNKNOWN);
  });

  test('unrecognized flags are never treated as safe: they need inspection', () => {
    for (const flag of ['SOMETHING_NEW', '', 'constructor', '__proto__', 'toString', null, 5, {}, ['x']]) {
      assert.equal(classifyPermissionFlag(flag).risk, PERMISSION_RISK.NEEDS_INSPECTION, String(flag));
      assert.equal(check(evaluate({ permissionFlags: [flag] }), 'suspiciousPermissions').status, UNKNOWN, String(flag));
    }
  });

  test('the allow-list accepts a flag explicitly, for that flag only', () => {
    const lenient = resolveStrategyConfig('balanced', { allowedPermissionFlags: ['TRANSFER_HOOK'] });
    assert.equal(check(evaluate({ permissionFlags: ['TRANSFER_HOOK'] }, lenient), 'suspiciousPermissions').status, PASS);
    assert.equal(check(evaluate({ permissionFlags: ['TRANSFER_HOOK', 'TRANSFER_FEE'] }, lenient), 'suspiciousPermissions').status, UNKNOWN);
  });

  test('missing flag data is still UNKNOWN, and an empty list (a classic token) passes', () => {
    assert.equal(check(evaluate({ permissionFlags: null }), 'suspiciousPermissions').status, UNKNOWN);
    assert.equal(check(evaluate({ permissionFlags: [] }), 'suspiciousPermissions').status, PASS);
  });

  test('end to end: needs-inspection blocks, informational enters, high-risk is rejected', () => {
    const outcome = (flags) => {
      const token = createStrategyToken('take-profit-run');
      token.attributes.permissionFlags = flags;
      return runStrategySimulation({ tokens: [token], strategy: BALANCED });
    };
    assert.equal(outcome(['TRANSFER_FEE']).decisions[0].strategyDecision, 'BLOCKED');
    assert.equal(outcome(['TRANSFER_FEE']).trades.length, 0);
    assert.equal(outcome(['PERMANENT_DELEGATE']).decisions[0].strategyDecision, 'REJECTED');
    const enters = outcome(['METADATA_POINTER']);
    assert.equal(enters.decisions[0].strategyDecision, 'APPROVED');
    assert.equal(enters.trades.length, 1);
  });
});

describe('audit fix 3: boolean CLI flags can never be switched on by an inline value', () => {
  const FLAGS = ['--stop-loss', '--portfolio', '--keep-open', '--quiet', '--timeline', '--explain', '--list', '--help'];

  test('every boolean flag rejects "=value", including "=false"', () => {
    for (const flag of FLAGS) {
      for (const value of ['false', '0', 'true', 'no', '']) {
        assert.throws(() => parseCliArgs([`${flag}=${value}`]), /does not take a value/, `${flag}=${value}`);
      }
    }
  });

  test('--stop-loss=false is an error: it can neither enable nor silently ignore the stop-loss', () => {
    const { code, text, errText } = capture(['--token', 'clean-looking-rug', '--stop-loss=false']);
    assert.equal(code, 1);
    assert.equal(text, '');
    assert.match(errText, /^Error: --stop-loss does not take a value \(got "false"\)/);
  });

  test('"--stop-loss false" (space separated) is rejected as an unknown option', () => {
    assert.throws(() => parseCliArgs(['--stop-loss', 'false']), /Unknown option: false/);
  });

  test('plain boolean flags and valued flags with "=" still work', () => {
    assert.equal(parseCliArgs(['--stop-loss']).stopLoss, true);
    assert.equal(parseCliArgs(['--keep-open', '--quiet']).keepOpen, true);
    const o = parseCliArgs(['--seed=7', '--profile=aggressive', '--token=honeypot', '--fee=0.01']);
    assert.deepEqual([o.seed, o.profile, o.token, o.fee], [7, 'aggressive', 'honeypot', 0.01]);
    assert.equal(parseCliArgs(['--entry-policy=launch', '--scenario=rug-pull']).entryPolicy, 'launch');
    assert.equal(capture(['--token', 'honeypot', '--quiet']).code, 0);
  });
});

describe('simulation invariants (seeded fuzz regression)', () => {
  const rng = createRng(20261029);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  test('300 randomized, contention-heavy runs keep every risk, timing, accounting and look-ahead invariant', () => {
    const violations = [];
    const bad = (name, detail = '') => violations.push(`${name} ${detail}`);

    for (let iter = 0; iter < 300; iter += 1) {
      const startingBalanceUsd = pick([2, 5, 10]);
      const positionSizeUsd = pick([0.5, 1]);
      const config = {
        ...defaultConfig, startingBalanceUsd, positionSizeUsd, maxOpenPositions: pick([1, 2, 3]),
        dailyLossLimitUsd: Math.min(startingBalanceUsd, pick([0.5, 1, 2])),
        stopLossEnabled: rng() < 0.5, tradingFeeRate: pick([0, 0, 0.001, 0.01, 0.05]),
      };
      const overrides = {};
      if (rng() < 0.4) overrides.observationTicks = int(1, 8);
      if (rng() < 0.4) overrides.minAgeTicks = int(0, 12);
      if (rng() < 0.3) overrides.minSignalsPassed = int(0, 2);
      const strategy = resolveStrategyConfig(pick(PROFILE_NAMES), overrides);
      const closeOpenAtEnd = rng() < 0.5;

      // Biased toward contention: many tokens launching close together, most of them approvable,
      // many that lose money, so the slot, cash and daily-loss rules are actually exercised.
      const tokens = Array.from({ length: int(1, 6) }, (_, i) => {
        const t = createStrategyToken(rng() < 0.5 ? pick(['rug-pull', 'gradual-decline', 'take-profit-run']) : pick(SCENARIO_NAMES), {
          archetype: rng() < 0.65 ? 'healthy-momentum' : pick(ARCHETYPE_NAMES), seed: int(0, 1e6), startTick: rng() < 0.7 ? int(0, 8) : int(0, 40), symbol: `MOCK-F${iter}-${i}`,
          preludeTicks: int(3, 20), basePrice: pick([0.0005, 1e-6, 0.37, 12]),
          ...(rng() < 0.15 ? { historyTicks: int(2, 14) } : {}),
        });
        if (rng() < 0.15) t.attributes.ageAtFirstSeenTicks = pick([null, 0, 3, 11]);
        return t;
      });

      const r = runStrategySimulation({ tokens, strategy, config, closeOpenAtEnd });
      const s = r.summary;
      if (!r.consistency.ok) bad('ledger inconsistent', r.consistency.errors.join(';'));
      if (r.peakOpenPositions > config.maxOpenPositions) bad('max open positions exceeded');
      if (r.trades.length !== r.counts.entriesAccepted) bad('trades != accepted entries');
      if (!closeOpenAtEnd && r.trades.some((t) => t.closeReason === 'FEED_ENDED')) bad('forced close while disabled');
      if (closeOpenAtEnd && r.openTradesAtEnd !== 0) bad('position left open while closure enabled');
      if (!config.stopLossEnabled && r.trades.some((t) => t.closeReason === 'STOP_LOSS' || t.stopLossPrice !== null)) bad('stop-loss active while disabled');
      if (r.trades.some((t) => t.sizeUsd !== positionSizeUsd)) bad('wrong position size');

      // replay the events in processing order against the risk state at each moment
      let realized = 0;
      let open = 0;
      let openCost = 0;
      const costOf = new Map();
      const attempts = new Map();
      const perTradeExits = new Map();
      for (const e of r.events) {
        if (e.type === 'EXIT') {
          realized += e.realizedPnlUsd; open -= 1; openCost -= costOf.get(e.tradeId);
          perTradeExits.set(e.tradeId, (perTradeExits.get(e.tradeId) ?? 0) + 1);
        }
        if (e.type === 'ENTRY' || e.type === 'ENTRY_REJECTED') attempts.set(e.symbol, (attempts.get(e.symbol) ?? 0) + 1);
        const cash = config.startingBalanceUsd + realized - openCost;
        const need = positionSizeUsd * (1 + config.tradingFeeRate);
        if (e.type === 'ENTRY') {
          costOf.set(e.tradeId, e.sizeUsd + e.entryFeeUsd);
          if (realized <= -config.dailyLossLimitUsd + 1e-9) bad('entry accepted after the daily loss limit');
          if (open >= config.maxOpenPositions) bad('entry accepted with every slot taken');
          if (cash + 1e-9 < need) bad('entry accepted without enough cash');
          open += 1; openCost += e.sizeUsd + e.entryFeeUsd;
        }
        if (e.type === 'ENTRY_REJECTED') {
          const justified =
            (e.reason === 'DAILY_LOSS_LIMIT' && realized <= -config.dailyLossLimitUsd + 1e-9) ||
            (e.reason === 'MAX_OPEN_POSITIONS' && open >= config.maxOpenPositions) ||
            (e.reason === 'INSUFFICIENT_BALANCE' && cash - need < 1e-9) ||
            e.reason === 'INVALID_PRICE';
          if (!justified) bad('entry rejected without a valid reason', e.reason);
        }
      }
      for (const [symbol, n] of attempts) if (n > 1) bad('entry attempted more than once', symbol);
      for (const t of r.trades) {
        if ((perTradeExits.get(t.id) ?? 0) > 1) bad('duplicate exit');
        if (t.status === 'CLOSED' && perTradeExits.get(t.id) !== 1) bad('closed trade without exactly one exit');
        if (t.takeProfitPrice !== t.entryPrice * 2) bad('take-profit not 2x the actual entry price');
        if (t.stopLossPrice !== null && t.stopLossPrice !== t.entryPrice * (1 - config.stopLossFraction)) bad('stop-loss not from the actual entry price');
        if (t.closeReason === 'TAKE_PROFIT' && t.exitPrice !== t.takeProfitPrice) bad('take-profit not filled at the trigger');
        if (t.closeReason === 'STOP_LOSS' && !(t.exitPrice <= t.stopLossPrice)) bad('stop-loss filled above the trigger');
      }
      if (Math.abs(realized - s.totalRealizedPnlUsd) > 1e-6) bad('exit PnL differs from ledger realized PnL');

      r.decisions.forEach((d, i) => {
        const tok = tokens[i];
        const mandatory = d.checks.filter((c) => c.category === 'MANDATORY');
        if (d.riskDecision === 'PENDING') bad('entry left pending');
        if ((d.strategyDecision === 'APPROVED') !== d.entryRequested) bad('approval and entry request disagree');
        if (d.strategyDecision === 'APPROVED' && mandatory.some((c) => c.status !== 'PASS')) bad('approved with a non-PASS mandatory check');
        if (d.strategyDecision === 'APPROVED' && d.signalsPassed < d.signalsRequired) bad('approved with too few signals');
        if (d.strategyDecision === 'BLOCKED' && (mandatory.some((c) => c.status === 'FAIL') || !mandatory.some((c) => c.status === 'UNKNOWN'))) bad('blocked for the wrong reason');
        if (d.strategyDecision === 'REJECTED' && !mandatory.some((c) => c.status === 'FAIL')) bad('rejected without a failure');
        if (d.strategyDecision !== 'APPROVED' && d.riskDecision !== 'NOT_REQUESTED') bad('risk manager asked about a non-approved token');
        if (d.status === 'EVALUATED' && d.decisionIndex !== firstEligibleIndex(strategy, tok.attributes.ageAtFirstSeenTicks)) bad('not decided at the first eligible tick');
        if (d.status === 'NOT_ELIGIBLE_BEFORE_FEED_END' && d.strategyDecision === 'APPROVED') bad('approved while never eligible');
        if (d.riskDecision === 'ACCEPTED' && (d.executionTick !== d.decisionTick + 1 || d.entryPrice !== tok.prices[d.decisionIndex + 1])) bad('entry not at decision + 1 and that tick price');
        if (d.riskDecision === 'REJECTED' && (d.tradeId !== null || d.entryPrice !== null)) bad('rejected entry has a position');
        if (d.status === 'EVALUATED') {
          const L = d.decisionIndex + 1;
          const fresh = evaluateEntry({
            history: { prices: tok.prices.slice(0, L), buys: tok.buys.slice(0, L), sells: tok.sells.slice(0, L) },
            attributes: tok.attributes, strategy, order: { sizeUsd: positionSizeUsd, takeProfitMultiplier: 2 },
          });
          if (JSON.stringify(fresh.checks) !== JSON.stringify(d.checks)) bad('recorded checks differ from a prefix-only evaluation');
        }
      });

      // end to end: poisoning everything after the decision must change nothing
      if (tokens.length === 1 && r.decisions[0].status === 'EVALUATED') {
        const d = r.decisions[0];
        const tok = tokens[0];
        const poisoned = {
          ...tok,
          prices: tok.prices.map((x, i) => (i >= d.decisionIndex + 2 ? 1e6 * (1 + (i % 7)) : x)),
          buys: tok.buys.map((x, i) => (i > d.decisionIndex ? 9999 : x)),
          sells: tok.sells.map((x, i) => (i > d.decisionIndex ? 0 : x)),
        };
        const d2 = runStrategySimulation({ tokens: [poisoned], strategy, config, closeOpenAtEnd }).decisions[0];
        if (JSON.stringify(d2.checks) !== JSON.stringify(d.checks) || d2.strategyDecision !== d.strategyDecision || d2.entryPrice !== d.entryPrice || d2.riskDecision !== d.riskDecision) {
          bad('future data changed the decision or the entry', tok.symbol);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});