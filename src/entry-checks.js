// Entry checks for MOCK tokens.
//
// Every check here runs on FABRICATED data and is a SIMULATED check. It cannot verify the
// safety of any real token. Each check records what real on-chain data a future version
// would need (futureRealCheck); none of that is implemented.
//
// Every check returns PASS, FAIL or UNKNOWN. Missing or unusable data is UNKNOWN and is
// never treated as a pass.
//
// NO LOOK-AHEAD: evaluateEntry() receives only the history up to and including the
// decision tick. It has no way to read later prices or activity.

export const CHECK_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' });

export const CHECK_GROUP = Object.freeze({
  PROCESS: 'PROCESS', // mandatory: is there enough history / age to judge at all?
  TOKEN_SAFETY: 'TOKEN_SAFETY', // mandatory
  MARKET_SANITY: 'MARKET_SANITY', // mandatory
  SIGNAL: 'SIGNAL', // strategy signal: only counted after every mandatory check passes
});

export const DECISION = Object.freeze({
  APPROVED: 'APPROVED', // mandatory checks all PASS and enough signals PASS
  REJECTED: 'REJECTED', // at least one mandatory check FAILED
  BLOCKED: 'BLOCKED', // no mandatory FAIL, but at least one is UNKNOWN
  NO_SIGNAL: 'NO_SIGNAL', // mandatory checks passed, not enough signals passed
});

export const FUTURE_REAL_DATA = Object.freeze({
  observationWindow: 'Real timestamped price and trade history for the token over the same window.',
  tokenAge: 'The real creation time of the token and its liquidity pool, from chain history.',
  mintAuthority: 'Read the mint authority field of the real token mint account on-chain.',
  freezeAuthority: 'Read the freeze authority field of the real token mint account on-chain.',
  suspiciousPermissions:
    'Inspect the real token program and any extensions on the mint (for example delegates, transfer fees, transfer hooks).',
  holderConcentration:
    'Real holder balances excluding liquidity-pool and program-owned accounts, plus analysis of linked wallets.',
  minLiquidity: 'Real pool reserves across every venue that trades the token.',
  priceImpact:
    'Real route quotes for the exact order size against current pool state, kept separate from fees and slippage.',
  sellability:
    'A simulated real sell against current chain state. Even a pass cannot rule out later changes.',
  priceSpike: 'A real, manipulation-aware price series.',
  priceCollapse: 'A real, manipulation-aware price series.',
  momentum: 'A real price series. Momentum is backward-looking and predicts nothing.',
  buySellActivity: 'Real swap data, filtered for wash trading and self-trades.',
});

// ---------------------------------------------------------------------------------------
// Permission flags: how a mint's extra permissions are interpreted
//
// These are labels this simulator uses for Token-2022 mint extensions. A classic SPL Token
// mint has no extensions at all; for those the only controls are the mint and freeze
// authorities, handled by their own checks. The table below is a simplified reading of the
// extensions, NOT an audit: it must be re-verified against the current Token-2022
// documentation before any real data is used, and it is not exhaustive.
//
// Not every extension is equally dangerous, so a flag is placed in one of three tiers:
//   HIGH_RISK         gives someone direct control over holders' tokens or blocks selling.
//                     The check FAILS.
//   NEEDS_INSPECTION  the risk depends on parameters or on another program, so it cannot be
//                     judged from the flag alone. The check is UNKNOWN, which blocks entry.
//                     An unrecognized flag is treated the same way.
//   INFORMATIONAL     does not give control over holders' balances. The check passes.
// A flag listed in the strategy's allowedPermissionFlags is accepted explicitly.
// ---------------------------------------------------------------------------------------

export const PERMISSION_RISK = Object.freeze({
  HIGH_RISK: 'HIGH_RISK',
  NEEDS_INSPECTION: 'NEEDS_INSPECTION',
  INFORMATIONAL: 'INFORMATIONAL',
});

const permission = (risk, note) => Object.freeze({ risk, note });

export const PERMISSION_FLAGS = Object.freeze({
  PERMANENT_DELEGATE: permission(PERMISSION_RISK.HIGH_RISK, "a delegate can move or burn any holder's tokens"),
  NON_TRANSFERABLE: permission(PERMISSION_RISK.HIGH_RISK, 'tokens cannot be transferred, so they cannot be sold'),
  DEFAULT_ACCOUNT_STATE_FROZEN: permission(PERMISSION_RISK.HIGH_RISK, 'new token accounts start frozen until the freeze authority thaws them'),
  TRANSFER_HOOK: permission(PERMISSION_RISK.NEEDS_INSPECTION, 'another program runs on every transfer; the risk depends on that program'),
  TRANSFER_FEE: permission(PERMISSION_RISK.NEEDS_INSPECTION, 'the risk depends on the fee rate, its cap, and who can change them'),
  CONFIDENTIAL_TRANSFER: permission(PERMISSION_RISK.NEEDS_INSPECTION, 'balances can be hidden; the configuration needs inspection'),
  MINT_CLOSE_AUTHORITY: permission(PERMISSION_RISK.NEEDS_INSPECTION, 'an authority can close the mint account'),
  INTEREST_BEARING: permission(PERMISSION_RISK.NEEDS_INSPECTION, 'displayed amounts depend on a rate an authority can change'),
  METADATA_POINTER: permission(PERMISSION_RISK.INFORMATIONAL, 'points to where token metadata is stored'),
  TOKEN_METADATA: permission(PERMISSION_RISK.INFORMATIONAL, 'stores token metadata on the mint'),
  GROUP_POINTER: permission(PERMISSION_RISK.INFORMATIONAL, 'groups tokens together'),
  GROUP_MEMBER_POINTER: permission(PERMISSION_RISK.INFORMATIONAL, 'marks membership of a token group'),
  TOKEN_GROUP: permission(PERMISSION_RISK.INFORMATIONAL, 'group information'),
  TOKEN_GROUP_MEMBER: permission(PERMISSION_RISK.INFORMATIONAL, 'group membership information'),
});

/** Returns { risk, note } for a flag. Unrecognized flags need inspection. */
export function classifyPermissionFlag(flag) {
  if (typeof flag === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_FLAGS, flag)) {
    return PERMISSION_FLAGS[flag];
  }
  return { risk: PERMISSION_RISK.NEEDS_INSPECTION, note: 'unrecognized flag, cannot be classified' };
}

// ---------------------------------------------------------------------------------------
// Price impact estimate (a constant-product pool approximation)
//
// Assumes a constant-product pool (x * y = k) whose quote-side reserve is R (USD). An order
// worth `a` USD at the current spot price moves the price against us by:
//   buy:   impact = a / R            (average fill price above spot)
//   sell:  impact = a / (R + a)      (proceeds below spot value)
// Expressed in basis points (x 10,000).
//
// This is PRICE IMPACT only: the deterministic effect of our own order size on the pool.
// It is NOT the pool's trading fee, NOT slippage (price movement between quote and fill,
// other traders, MEV), and NOT network fees. Real pools may not be constant-product.
// The simulator never applies this estimate to fills; the ledger's tradingFeeRate is the
// only cost applied to simulated trades.
// ---------------------------------------------------------------------------------------

export function estimateBuyImpactBps(quoteReserveUsd, orderUsd) {
  return (10000 * orderUsd) / quoteReserveUsd;
}

export function estimateSellImpactBps(quoteReserveUsd, orderUsd) {
  return (10000 * orderUsd) / (quoteReserveUsd + orderUsd);
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v) => `${v.toFixed(1)}%`;
const signedPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const ticks = (n) => `${n} tick${n === 1 ? '' : 's'}`;

function makeCheck(id, group, status, detail, measured = null, threshold = null) {
  return {
    id,
    group,
    category: group === CHECK_GROUP.SIGNAL ? 'SIGNAL' : 'MANDATORY',
    status,
    measured,
    threshold,
    detail,
    simulated: true,
    futureRealCheck: FUTURE_REAL_DATA[id],
  };
}

const unknown = (id, group, detail, threshold = null) =>
  makeCheck(id, group, CHECK_STATUS.UNKNOWN, detail, null, threshold);

// Statistics over the price history. Never reads beyond the array it is given.
function priceStats(prices) {
  let maxRisePct = 0;
  let maxDropPct = 0;
  let high = prices[0];
  let incomplete = false;

  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev > 0) {
      const change = (cur / prev - 1) * 100;
      if (change > maxRisePct) maxRisePct = change;
      if (-change > maxDropPct) maxDropPct = -change;
    } else {
      incomplete = true;
    }
    if (cur > high) high = cur;
  }

  const first = prices[0];
  const last = prices[prices.length - 1];
  return {
    maxRisePct,
    maxDropPct,
    riseSinceLaunchPct: first > 0 ? (last / first - 1) * 100 : null,
    drawdownFromHighPct: high > 0 ? ((high - last) / high) * 100 : null,
    incomplete,
  };
}

function authorityCheck(id, value, required, label) {
  if (value === 'REVOKED') {
    return makeCheck(id, CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.PASS, `${label} revoked`, value, 'REVOKED');
  }
  if (value === 'ACTIVE') {
    return required
      ? makeCheck(id, CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.FAIL, `${label} still active`, value, 'REVOKED')
      : makeCheck(id, CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.PASS, `${label} active but tolerated by config`, value, 'not required');
  }
  return unknown(id, CHECK_GROUP.TOKEN_SAFETY, `${label} status not available`, 'REVOKED');
}

/**
 * Evaluates one token at one decision tick.
 *
 * @param history     { prices, buys, sells } up to and including the decision tick. buys and
 *                    sells are per-tick trade counts (arrays) or null when unavailable.
 * @param attributes  fabricated token attributes (see mock-attributes.js)
 * @param strategy    a resolved strategy config
 * @param order       { sizeUsd, takeProfitMultiplier } used for the price impact estimate
 */
export function evaluateEntry({ history, attributes, strategy, order }) {
  const prices = history.prices;
  const idx = prices.length - 1; // decision index: the last price the strategy has seen
  const N = strategy.observationTicks;
  const attr = attributes;
  const checks = [];

  const pricesUsable =
    prices.length >= 1 && prices.every((p) => isNumber(p) && p >= 0);
  const observed = idx >= N;
  const historyOk = observed && pricesUsable;
  const noHistory = (id, group, threshold) =>
    unknown(id, group, `insufficient usable history: ${ticks(idx)} seen, ${N} needed`, threshold);

  // --- mandatory: process -------------------------------------------------------------
  checks.push(
    observed
      ? makeCheck('observationWindow', CHECK_GROUP.PROCESS, CHECK_STATUS.PASS, `${ticks(idx)} of history (need ${N})`, idx, N)
      : unknown('observationWindow', CHECK_GROUP.PROCESS, `only ${ticks(idx)} of history (need ${N})`, N)
  );

  const age = isNumber(attr.ageAtFirstSeenTicks) ? attr.ageAtFirstSeenTicks + idx : null;
  if (age === null) {
    checks.push(unknown('tokenAge', CHECK_GROUP.PROCESS, 'token age not available', strategy.minAgeTicks));
  } else if (age >= strategy.minAgeTicks) {
    checks.push(makeCheck('tokenAge', CHECK_GROUP.PROCESS, CHECK_STATUS.PASS, `age ${ticks(age)} (min ${strategy.minAgeTicks})`, age, strategy.minAgeTicks));
  } else {
    // Age is an eligibility condition (the bot waits for it), not a quality verdict.
    checks.push(unknown('tokenAge', CHECK_GROUP.PROCESS, `age ${ticks(age)}, not old enough yet (min ${strategy.minAgeTicks})`, strategy.minAgeTicks));
  }

  // --- mandatory: token safety --------------------------------------------------------
  checks.push(authorityCheck('mintAuthority', attr.mintAuthority, strategy.requireMintAuthorityRevoked, 'mint authority'));
  checks.push(authorityCheck('freezeAuthority', attr.freezeAuthority, strategy.requireFreezeAuthorityRevoked, 'freeze authority'));

  if (!Array.isArray(attr.permissionFlags)) {
    checks.push(unknown('suspiciousPermissions', CHECK_GROUP.TOKEN_SAFETY, 'permission flags not available', 'none unexpected'));
  } else {
    const tiers = { high: [], inspect: [], info: [] };
    for (const flag of attr.permissionFlags) {
      if (strategy.allowedPermissionFlags.includes(flag)) continue; // explicitly accepted
      const { risk } = classifyPermissionFlag(flag);
      if (risk === PERMISSION_RISK.HIGH_RISK) tiers.high.push(flag);
      else if (risk === PERMISSION_RISK.NEEDS_INSPECTION) tiers.inspect.push(flag);
      else tiers.info.push(flag);
    }
    const describe = (list) => list.map((f) => `${String(f)} (${classifyPermissionFlag(f).note})`).join('; ');
    if (tiers.high.length > 0) {
      const extra = tiers.inspect.length > 0 ? `; also needs inspection: ${tiers.inspect.map(String).join(', ')}` : '';
      checks.push(makeCheck('suspiciousPermissions', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.FAIL, `high-risk: ${describe(tiers.high)}${extra}`, attr.permissionFlags, strategy.allowedPermissionFlags));
    } else if (tiers.inspect.length > 0) {
      checks.push(makeCheck('suspiciousPermissions', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.UNKNOWN, `needs inspection, cannot be judged from the flag alone: ${describe(tiers.inspect)}`, attr.permissionFlags, strategy.allowedPermissionFlags));
    } else {
      const note = tiers.info.length > 0 ? `only informational flags: ${tiers.info.join(', ')}` : 'no unexpected permission flags';
      checks.push(makeCheck('suspiciousPermissions', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.PASS, note, attr.permissionFlags, strategy.allowedPermissionFlags));
    }
  }

  {
    const top = attr.topHolderPct;
    const top10 = attr.top10HolderPct;
    const measured = { topHolderPct: top ?? null, top10HolderPct: top10 ?? null };
    const threshold = { maxTopHolderPct: strategy.maxTopHolderPct, maxTop10HolderPct: strategy.maxTop10HolderPct };
    const over = [];
    if (isNumber(top) && top > strategy.maxTopHolderPct) over.push(`top holder ${pct(top)} > ${pct(strategy.maxTopHolderPct)}`);
    if (isNumber(top10) && top10 > strategy.maxTop10HolderPct) over.push(`top-10 ${pct(top10)} > ${pct(strategy.maxTop10HolderPct)}`);
    if (over.length > 0) {
      checks.push(makeCheck('holderConcentration', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.FAIL, over.join('; '), measured, threshold));
    } else if (!isNumber(top) || !isNumber(top10) || top < 0 || top10 < 0 || top10 < top) {
      // Missing, negative, or impossible (top-10 share below the top holder's share) data is
      // never a pass.
      checks.push(makeCheck('holderConcentration', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.UNKNOWN, 'holder data missing or invalid (shares cannot be negative, and the top-10 share cannot be below the top holder share)', measured, threshold));
    } else {
      checks.push(makeCheck('holderConcentration', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.PASS, `top holder ${pct(top)}, top-10 ${pct(top10)}`, measured, threshold));
    }
  }

  if (!isNumber(attr.liquidityUsd) || attr.liquidityUsd < 0) {
    checks.push(unknown('minLiquidity', CHECK_GROUP.TOKEN_SAFETY, 'liquidity not available', strategy.minLiquidityUsd));
  } else {
    const ok = attr.liquidityUsd >= strategy.minLiquidityUsd;
    checks.push(
      makeCheck(
        'minLiquidity',
        CHECK_GROUP.TOKEN_SAFETY,
        ok ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
        `liquidity $${attr.liquidityUsd.toLocaleString('en-US')} (min $${strategy.minLiquidityUsd.toLocaleString('en-US')})`,
        attr.liquidityUsd,
        strategy.minLiquidityUsd
      )
    );
  }

  if (!isNumber(attr.quoteReserveUsd)) {
    checks.push(unknown('priceImpact', CHECK_GROUP.TOKEN_SAFETY, 'quote-side reserve not available', strategy.maxPriceImpactBps));
  } else if (attr.quoteReserveUsd <= 0) {
    checks.push(makeCheck('priceImpact', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.FAIL, 'no quote-side reserve to trade against', attr.quoteReserveUsd, strategy.maxPriceImpactBps));
  } else {
    const sellOrderUsd = order.sizeUsd * order.takeProfitMultiplier; // position value at the take-profit
    const buyBps = estimateBuyImpactBps(attr.quoteReserveUsd, order.sizeUsd);
    const sellBps = estimateSellImpactBps(attr.quoteReserveUsd, sellOrderUsd);
    const worst = Math.max(buyBps, sellBps);
    checks.push(
      makeCheck(
        'priceImpact',
        CHECK_GROUP.TOKEN_SAFETY,
        worst <= strategy.maxPriceImpactBps ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
        `est. impact buy ${buyBps.toFixed(1)} bps, sell ${sellBps.toFixed(1)} bps (max ${strategy.maxPriceImpactBps} bps)`,
        { buyBps, sellBps },
        strategy.maxPriceImpactBps
      )
    );
  }

  if (attr.sellSimulation === 'SUCCEEDED') {
    checks.push(makeCheck('sellability', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.PASS, 'simulated sell succeeded', attr.sellSimulation, 'SUCCEEDED'));
  } else if (attr.sellSimulation === 'FAILED') {
    checks.push(
      strategy.requireSellable
        ? makeCheck('sellability', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.FAIL, 'simulated sell FAILED', attr.sellSimulation, 'SUCCEEDED')
        : makeCheck('sellability', CHECK_GROUP.TOKEN_SAFETY, CHECK_STATUS.PASS, 'simulated sell failed but tolerated by config', attr.sellSimulation, 'not required')
    );
  } else {
    checks.push(unknown('sellability', CHECK_GROUP.TOKEN_SAFETY, 'simulated sell result not available', 'SUCCEEDED'));
  }

  // --- mandatory: market sanity (uses the full history since the first observed tick) ---
  const spikeThreshold = { maxSingleTickRisePct: strategy.maxSingleTickRisePct, maxRiseSinceLaunchPct: strategy.maxRiseSinceLaunchPct };
  const collapseThreshold = { maxSingleTickDropPct: strategy.maxSingleTickDropPct, maxDrawdownFromHighPct: strategy.maxDrawdownFromHighPct };
  if (!historyOk) {
    checks.push(noHistory('priceSpike', CHECK_GROUP.MARKET_SANITY, spikeThreshold));
    checks.push(noHistory('priceCollapse', CHECK_GROUP.MARKET_SANITY, collapseThreshold));
  } else {
    const st = priceStats(prices);

    const spikeMeasured = { maxSingleTickRisePct: st.maxRisePct, riseSinceLaunchPct: st.riseSinceLaunchPct };
    const spikeOver = [];
    if (st.maxRisePct > strategy.maxSingleTickRisePct) spikeOver.push(`single-tick rise ${pct(st.maxRisePct)} > ${pct(strategy.maxSingleTickRisePct)}`);
    if (st.riseSinceLaunchPct !== null && st.riseSinceLaunchPct > strategy.maxRiseSinceLaunchPct) spikeOver.push(`rise since launch ${pct(st.riseSinceLaunchPct)} > ${pct(strategy.maxRiseSinceLaunchPct)}`);
    if (spikeOver.length > 0) {
      checks.push(makeCheck('priceSpike', CHECK_GROUP.MARKET_SANITY, CHECK_STATUS.FAIL, spikeOver.join('; '), spikeMeasured, spikeThreshold));
    } else if (st.incomplete || st.riseSinceLaunchPct === null) {
      checks.push(makeCheck('priceSpike', CHECK_GROUP.MARKET_SANITY, CHECK_STATUS.UNKNOWN, 'a zero price in the history prevents a full calculation', spikeMeasured, spikeThreshold));
    } else {
      checks.push(makeCheck('priceSpike', CHECK_GROUP.MARKET_SANITY, CHECK_STATUS.PASS, `largest single-tick rise ${pct(st.maxRisePct)}, rise since launch ${signedPct(st.riseSinceLaunchPct)}`, spikeMeasured, spikeThreshold));
    }

    const collapseMeasured = { maxSingleTickDropPct: st.maxDropPct, drawdownFromHighPct: st.drawdownFromHighPct };
    const collapseOver = [];
    if (st.maxDropPct > strategy.maxSingleTickDropPct) collapseOver.push(`single-tick drop ${pct(st.maxDropPct)} > ${pct(strategy.maxSingleTickDropPct)}`);
    if (st.drawdownFromHighPct !== null && st.drawdownFromHighPct > strategy.maxDrawdownFromHighPct) collapseOver.push(`drawdown from high ${pct(st.drawdownFromHighPct)} > ${pct(strategy.maxDrawdownFromHighPct)}`);
    if (collapseOver.length > 0) {
      checks.push(makeCheck('priceCollapse', CHECK_GROUP.MARKET_SANITY, CHECK_STATUS.FAIL, collapseOver.join('; '), collapseMeasured, collapseThreshold));
    } else if (st.incomplete || st.drawdownFromHighPct === null) {
      checks.push(makeCheck('priceCollapse', CHECK_GROUP.MARKET_SANITY, CHECK_STATUS.UNKNOWN, 'a zero price in the history prevents a full calculation', collapseMeasured, collapseThreshold));
    } else {
      checks.push(makeCheck('priceCollapse', CHECK_GROUP.MARKET_SANITY, CHECK_STATUS.PASS, `largest single-tick drop ${pct(st.maxDropPct)}, drawdown from high ${pct(st.drawdownFromHighPct)}`, collapseMeasured, collapseThreshold));
    }
  }

  // --- strategy signals (uses the last observationTicks ticks) --------------------------
  if (!historyOk || !(prices[idx - N] > 0)) {
    checks.push(noHistory('momentum', CHECK_GROUP.SIGNAL, strategy.minMomentumPct));
  } else {
    const change = (prices[idx] / prices[idx - N] - 1) * 100;
    checks.push(
      makeCheck(
        'momentum',
        CHECK_GROUP.SIGNAL,
        change >= strategy.minMomentumPct ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
        `${signedPct(change)} over the last ${N} ticks (min ${signedPct(strategy.minMomentumPct)})`,
        change,
        strategy.minMomentumPct
      )
    );
  }

  {
    const threshold = { minBuySharePct: strategy.minBuySharePct, minTradesInWindow: strategy.minTradesInWindow };
    const valid = (arr) =>
      Array.isArray(arr) && arr.length > idx && arr.slice(0, idx + 1).every((v) => Number.isInteger(v) && v >= 0);
    if (!observed || !valid(history.buys) || !valid(history.sells)) {
      checks.push(unknown('buySellActivity', CHECK_GROUP.SIGNAL, 'trade activity not available for the observation window', threshold));
    } else {
      let buys = 0;
      let sells = 0;
      for (let i = idx - N + 1; i <= idx; i += 1) {
        buys += history.buys[i];
        sells += history.sells[i];
      }
      const total = buys + sells;
      if (total === 0 || total < strategy.minTradesInWindow) {
        checks.push(makeCheck('buySellActivity', CHECK_GROUP.SIGNAL, CHECK_STATUS.UNKNOWN, `only ${total} trades in the last ${N} ticks (need ${strategy.minTradesInWindow} for a usable sample)`, { buys, sells, total }, threshold));
      } else {
        const share = (buys / total) * 100;
        checks.push(
          makeCheck(
            'buySellActivity',
            CHECK_GROUP.SIGNAL,
            share >= strategy.minBuySharePct ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
            `buys are ${pct(share)} of ${total} trades (min ${pct(strategy.minBuySharePct)})`,
            { buys, sells, total, buySharePct: share },
            threshold
          )
        );
      }
    }
  }

  // --- decision -------------------------------------------------------------------------
  const mandatory = checks.filter((c) => c.category === 'MANDATORY');
  const signals = checks.filter((c) => c.category === 'SIGNAL');
  const failed = mandatory.filter((c) => c.status === CHECK_STATUS.FAIL);
  const unknownMandatory = mandatory.filter((c) => c.status === CHECK_STATUS.UNKNOWN);
  const signalsPassed = signals.filter((c) => c.status === CHECK_STATUS.PASS).length;

  let mandatoryStatus = CHECK_STATUS.PASS;
  if (failed.length > 0) mandatoryStatus = CHECK_STATUS.FAIL;
  else if (unknownMandatory.length > 0) mandatoryStatus = CHECK_STATUS.UNKNOWN;

  let decision;
  let reasons;
  if (failed.length > 0) {
    decision = DECISION.REJECTED;
    reasons = failed.map((c) => c.id);
  } else if (unknownMandatory.length > 0) {
    // Unknown critical safety information is never treated as a pass.
    decision = DECISION.BLOCKED;
    reasons = unknownMandatory.map((c) => c.id);
  } else if (signalsPassed >= strategy.minSignalsPassed) {
    // Unknown signals are simply not counted as passes.
    decision = DECISION.APPROVED;
    reasons = [];
  } else {
    decision = DECISION.NO_SIGNAL;
    reasons = signals.filter((c) => c.status !== CHECK_STATUS.PASS).map((c) => c.id);
  }

  return {
    decisionIndex: idx,
    checks,
    mandatoryStatus,
    signalsPassed,
    signalsRequired: strategy.minSignalsPassed,
    decision,
    reasons,
  };
}