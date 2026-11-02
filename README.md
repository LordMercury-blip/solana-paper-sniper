# Solana Paper Sniper

A **paper-trading-only** Solana token sniping bot written in JavaScript (Node.js, ES modules).

> **No real trades. No wallet keys.** This project never connects to a wallet, never asks for a
> private key or seed phrase, never signs or sends a transaction, and never uses the network.
> `paperTradingOnly` must be `true` or the config validator throws.

> **All data is fabricated.** Every token, attribute, price and trade count is invented locally for
> testing. The bot does **not** detect real token launches, does **not** read real blockchain data,
> and its checks **cannot verify the safety of any real token**. A simulated result says nothing
> about profitability or safety on live Solana tokens.

## Status

| Stage | What it adds | State |
| ----- | ------------ | ----- |
| 1 | Risk manager and config validation | done |
| 2 | Paper trade ledger, automatic take-profit | done |
| 3a | Loss management: outcomes, optional stop-loss, costs, ledger-only flow | done |
| 3 | Deterministic offline mock token feed and simulator | done |
| 4 | Entry-filter and strategy layer on fabricated token data | **current** |

## Setup

Requires Node.js 18 or newer. Nothing to install: no dependencies, no API keys, no network.

```bash
cd C:\Users\HP\solana-paper-sniper
node --version
```

### Windows PowerShell note

If PowerShell says "running scripts is disabled", it is blocking `npm.ps1`. Any of these works:

```powershell
npm.cmd test                      # use the .cmd version of npm
node --test                       # or skip npm entirely
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # or allow scripts for this window only
```

## Run the tests

```bash
npm test
```

(equivalently `node --test`)

## Run the simulation

```bash
npm run simulate
```

Pass options after `--` (or call `node src/run-simulation.js <options>` directly):

```bash
npm run simulate -- --portfolio --quiet
npm run simulate -- --profile conservative --quiet
npm run simulate -- --token clean-looking-rug --stop-loss
npm run simulate -- --token thin-depth --explain
npm run simulate -- --scenario take-profit-run --archetype unsafe-honeypot
npm run simulate -- --portfolio --keep-open --quiet
```

Stage 3 behavior (enter every token at launch, no checks) is kept for compatibility:

```bash
npm run simulate -- --entry-policy launch
npm run simulate -- --entry-policy launch --portfolio --quiet
```

### Options

| Option | Meaning |
| ------ | ------- |
| `--entry-policy <p>` | `strategy` (default, Stage 4) or `launch` (Stage 3: enter every token at its first price) |
| `--profile <name>` | `conservative`, `balanced` (default) or `aggressive` (strategy only) |
| `--token <id>` | Run one fabricated showcase token (strategy only; see `--list`) |
| `--scenario <name>` | One scenario. In strategy mode it builds a token from the scenario and `--archetype` |
| `--archetype <name>` | Fabricated attribute profile for `--scenario` (default `healthy-momentum`) |
| `--portfolio` | Run the tokens together on ONE ledger, launching one tick apart (`launch` policy: two ticks apart) |
| `--seed <integer>` | Seed for fabricated data (default 1) |
| `--stop-loss` | Enable the 40% stop-loss. **OFF unless you pass this flag** |
| `--fee <rate>` | Simulated cost per side, e.g. `0.01` = 1% (default 0) |
| `--keep-open` | Leave positions open when a feed ends (default: force-close them as `FEED_ENDED`) |
| `--quiet` | Strategy: show only checks that did not pass. Launch: hide the per-tick price lines |
| `--timeline` | Strategy: also print every simulated tick |
| `--explain` | Strategy: also print what real on-chain data a future version would need for each check |
| `--list` | List profiles, showcase tokens, archetypes and scenarios |
| `--help` | Show help |

The command is deterministic, always finishes, prints text only, and exits 0 (1 on a bad option).

Flags that switch something on (`--stop-loss`, `--keep-open`, `--quiet`, `--portfolio`, `--timeline`,
`--explain`, `--list`, `--help`) take no value. `--stop-loss=false` is an **error**, not a way to turn
the flag off: leave the flag out instead.

## How the strategy works (Stage 4)

For every fabricated token the bot (1) observes it, (2) evaluates it once with a set of checks,
and (3) only if the strategy approves, *requests* an entry through the existing ledger. The risk
manager has the final say.

### Timing, defined exactly

All indices are **local** to a token: index 0 is the first tick at which the token appears in the
feed. A **tick** is one abstract simulation step with no mapping to wall-clock time.

1. **Observation window begins at local index 0.** The bot records price and trade activity for
   every tick from then on.
2. **Age unit: ticks.** A token's age at local index `i` is `ageAtFirstSeenTicks + i`. A token
   first seen at age 0 is brand new.
3. **First eligible tick** `d` is the earliest index where BOTH hold: at least `observationTicks`
   of history exist (`i >= observationTicks`) AND the token is old enough
   (`ageAtFirstSeenTicks + i >= minAgeTicks`). So
   `d = max(observationTicks, minAgeTicks - ageAtFirstSeenTicks)`. The bot simply waits for the
   later condition, so **every profile can satisfy both**. Unknown age cannot shorten the wait.
   For a token with age 0: Conservative `d = 10`, Balanced `d = 5`, Aggressive `d = 2`.
4. **The decision happens at tick `d`** and uses only history up to and including index `d`. The
   evaluator is handed only that slice, so it cannot read later prices or activity
   (**no look-ahead**).
5. **Execution is at the next tick, `d + 1`,** at that tick's price. The strategy never saw that
   price when deciding; one tick is the modelled latency. If the feed has no index `d + 1`, no
   entry is attempted (`NO_NEXT_PRICE`).
6. **The risk manager is asked at tick `d + 1`** (`canOpenTrade`, then `openTrade`). It can still
   reject (`MAX_OPEN_POSITIONS`, `DAILY_LOSS_LIMIT`, `INSUFFICIENT_BALANCE`, `INVALID_PRICE`).
   A rejection creates no position, leaves the balance unchanged, and is never retried.
7. **Take-profit and stop-loss come from the actual entry price** (`d + 1`), never from the
   token's earlier launch price.
8. Within one tick, tokens are processed in list order: execute a pending entry or update the open
   position, then evaluate if eligible, then handle end of feed.

If the feed ends before a token becomes eligible, the checks run on the history that exists, the
history-dependent ones are `UNKNOWN`, and the token is `BLOCKED`.

### Decision rules

Every check returns `PASS`, `FAIL` or `UNKNOWN`. Missing or unusable data is `UNKNOWN`, which is
**never treated as a pass**. All checks always run, so the report shows every result.

1. Any **mandatory** check `FAIL` gives **`REJECTED`**.
2. Otherwise any mandatory check `UNKNOWN` gives **`BLOCKED`** (unknown critical data blocks entry).
3. Otherwise count the **signals** that `PASS`. Enough passes gives **`APPROVED`**; otherwise
   **`NO_SIGNAL`**. An `UNKNOWN` signal is simply not counted as a pass.
4. An `APPROVED` token requests an entry. The strategy decision and the risk-manager decision are
   reported separately.

Strong signals never override a failed or unknown mandatory check.

### The checks

Every check below is **simulated from fabricated data**. The third column is what a real version
would need; none of it is implemented.

| Check | Group | A real version would need | Key limitation |
| ----- | ----- | ------------------------- | -------------- |
| `observationWindow` | mandatory, process | real timestamped history over the window | `UNKNOWN` until enough history exists |
| `tokenAge` | mandatory, process | real creation time of the token and pool | an eligibility wait: reports `UNKNOWN` until reached |
| `mintAuthority` | mandatory, safety | the real mint account's mint authority field | "revoked" says nothing about other control routes |
| `freezeAuthority` | mandatory, safety | the real mint account's freeze authority field | same |
| `suspiciousPermissions` | mandatory, safety | the real mint's extensions, read on-chain and checked against the current Token-2022 documentation | interpreted in tiers (see below); the table is simplified and not exhaustive |
| `holderConcentration` | mandatory, safety | real balances excluding pool/program accounts, linked-wallet analysis | holdings can be split across many wallets; negative or impossible figures are `UNKNOWN` |
| `minLiquidity` | mandatory, safety | real pool reserves across venues | liquidity can be pulled after entry |
| `priceImpact` | mandatory, safety | real route quotes for the order size | see "Price impact" below |
| `sellability` | mandatory, safety | a simulated real sell against live state | state can change after the check |
| `priceSpike` | mandatory, market sanity | a real, manipulation-aware price series | thresholds are arbitrary; prices can be manipulated |
| `priceCollapse` | mandatory, market sanity | same | same |
| `momentum` | **signal** | a real price series | backward-looking; predicts nothing |
| `buySellActivity` | **signal** | real swap data filtered for wash trading | wash trading can fake it; too few trades is `UNKNOWN` |

`priceSpike` and `priceCollapse` use the whole history since the first observed tick (largest
single-tick rise or drop, rise since launch, drawdown from the high). `momentum` and
`buySellActivity` use the last `observationTicks` ticks.

### Token permissions (Token-2022 extensions)

A classic SPL Token mint has no extensions: its only controls are the mint and freeze authorities,
which have their own checks. Extensions exist only on Token-2022 mints, and they are not equally
dangerous, so `suspiciousPermissions` places each flag in one of three tiers:

| Tier | Verdict | Flags (this simulator's labels) | Why |
| ---- | ------- | ------------------------------- | --- |
| High risk | `FAIL` (`REJECTED`) | `PERMANENT_DELEGATE`, `NON_TRANSFERABLE`, `DEFAULT_ACCOUNT_STATE_FROZEN` | someone can move or burn holders' tokens, or the token cannot be sold, or accounts start frozen |
| Needs inspection | `UNKNOWN` (`BLOCKED`) | `TRANSFER_HOOK`, `TRANSFER_FEE`, `CONFIDENTIAL_TRANSFER`, `MINT_CLOSE_AUTHORITY`, `INTEREST_BEARING` | the risk depends on parameters or on another program, so the flag alone cannot be judged |
| Informational | `PASS` | `METADATA_POINTER`, `TOKEN_METADATA`, `GROUP_POINTER`, `GROUP_MEMBER_POINTER`, `TOKEN_GROUP`, `TOKEN_GROUP_MEMBER` | no control over holders' balances |

- An **unrecognized** flag needs inspection. It is never treated as safe.
- `allowedPermissionFlags` accepts a flag explicitly, for that flag only.
- This table is a **simplified reading, not an audit**. It must be checked against the current
  Token-2022 documentation before any real data is used, and it is not exhaustive. A pass here
  proves nothing about a real token.

### Default thresholds (profiles)

> **These are placeholders**, chosen so fabricated mock tokens behave sensibly in demos and tests.
> They are **not validated** safety or profit thresholds and have not been checked against any
> real token. Every value is configurable (`resolveStrategyConfig(profile, overrides)`).

| Setting | Conservative | Balanced (default) | Aggressive |
| ------- | ------------ | ------------------ | ---------- |
| `observationTicks` | 5 | 3 | 2 |
| `minAgeTicks` | 10 | 5 | 2 |
| First eligible tick (age 0) | 10 | 5 | 2 |
| Mint / freeze authority must be revoked | yes | yes | yes |
| Allowed permission flags | none | none | none |
| Simulated sell must succeed | yes | yes | yes |
| `maxTopHolderPct` | 10 | 20 | 35 |
| `maxTop10HolderPct` | 40 | 60 | 80 |
| `minLiquidityUsd` | 25,000 | 10,000 | 3,000 |
| `maxPriceImpactBps` | 25 | 50 | 100 |
| `maxSingleTickRisePct` | 25 | 40 | 75 |
| `maxRiseSinceLaunchPct` | 60 | 100 | 200 |
| `maxSingleTickDropPct` | 15 | 25 | 40 |
| `maxDrawdownFromHighPct` | 25 | 40 | 60 |
| `minMomentumPct` | +5 | +2 | 0 |
| `minBuySharePct` | 60 | 55 | 50 |
| `minTradesInWindow` (else `UNKNOWN`) | 20 | 10 | 5 |
| `minSignalsPassed` (of 2) | 2 | 2 | 1 |

No profile relaxes the authority, permission or sellability requirements. Aggressive loosens
numeric thresholds only. Overrides can change any of them, and `requireMintAuthorityRevoked`,
`requireFreezeAuthorityRevoked` and `requireSellable` can be set to `false`. Even then, **missing
data stays `UNKNOWN`**.

### Price impact: calculation, assumptions and what it is not

The check models a constant-product pool (`x * y = k`) with quote-side reserve `R` (USD). For an
order worth `a` USD at the current spot price:

```
buy:   impact = a / R            (average fill price above spot)
sell:  impact = a / (R + a)      (proceeds below spot value)
```

in basis points. The buy order is the position size ($1). The sell order is sized at the
position's value at take-profit ($2 at 2x). The check passes when the larger of the two is at or
below `maxPriceImpactBps`.

- It is **price impact only**: the deterministic effect of our own order size against pool depth.
- It is **not the pool's trading fee**, **not slippage** (price movement between quote and fill,
  other traders, MEV) and **not network fees**. None of those are modelled by this check.
- The estimate is **never applied to simulated fills**. The only cost applied to simulated trades
  is the ledger's `tradingFeeRate`, which defaults to 0. Set a realistic value before trusting any
  simulated number.
- It reads a separate fabricated `quoteReserveUsd`, so headline liquidity and the depth an order
  trades against can differ. At $1 positions and the default liquidity floors the two checks
  rarely disagree, so the `thin-depth` token (large headline liquidity, tiny reserve) exists to
  show the impact check rejecting a token that passes the liquidity floor.
- Real pools may not be constant-product, so real impact can differ materially.

## Fabricated data

Each token is generated locally from a seed. No attribute is a blockchain observation.

- **Price path** = a fabricated **observation phase** (12 ticks, shaped by the archetype, ending
  exactly at the anchor price) followed by an **existing Stage 3 scenario path, unchanged**,
  anchored at that price. The path never depends on the strategy, so no profile can change what the
  feed shows. Different profiles enter at different ticks and prices on the same feed.
- **Attributes**: mint and freeze authority, permission flags, top-holder and top-10 share,
  liquidity, quote-side reserve, simulated sell result, age when first seen. Each token and its
  attributes are tagged `FABRICATED_MOCK_DATA`.
- **Activity**: per-tick buy and sell counts, seeded.
- Token symbols always start with `MOCK-`. The simulator refuses anything that is not a fabricated
  strategy token.

Archetypes: `healthy-momentum`, `no-momentum`, `quiet-token`, `unsafe-authority`,
`unsafe-honeypot`, `unsafe-permissions`, `whale-concentrated`, `thin-liquidity`, `thin-depth`,
`unknown-data`, `pumped`, `collapsing`, `short-history` (see `--list`).

Showcase tokens (an archetype combined with a Stage 3 scenario) include a **clean-looking rug**
(`healthy-momentum` x `rug-pull`): it has exactly the same fabricated attributes and observation
phase as the promising runner, passes every profile, then collapses. It exists to show that the
filters can only judge what the data shows. Others show unsafe tokens that are rejected (some of
which would have risen), insufficient data, unknown critical data, and promising momentum.

## Exits, fills and end of feed

- **Take-profit** closes when the price reaches 2x the entry price. The fill is at **exactly the
  trigger price, even if the price gapped higher**, so a gap above the target is not credited
  (conservative). Real polling bots may fill differently.
- **Stop-loss** (only if enabled) closes when the price falls to 60% of entry or lower. The fill is
  at the **observed price**, so a gap below the trigger loses more than 40% (realistic).
  With stop-loss disabled, no fall closes a position.
- **End of feed**: configurable. By default a position still open when its feed ends is closed at
  the last price with the explicit reason **`FEED_ENDED`** and is labelled **forced** in the report.
  It is not a strategy exit. With `--keep-open` the position stays open and shows **unrealized**
  PnL. An open position is never silently counted as a closed loss.
- **Realized and unrealized PnL are kept separate.** Only closed trades are realized. The daily
  loss limit counts realized net losses only.
- Exit reasons: `TAKE_PROFIT`, `STOP_LOSS`, `MANUAL`, `FEED_ENDED`. Only `MANUAL` and `FEED_ENDED`
  can be passed to `closeTrade()`; take-profit and stop-loss belong to `updatePrice()`.
- If a decision falls on the last tick of a feed there is no execution price, so no entry is
  attempted. An entry that does execute on the very last tick is, by default, force-closed at once
  at the same price.

## Risk controls (unchanged)

$10 starting balance, $1 per trade, at most 2 open positions, 2x take-profit, $2 realized daily
loss limit, optional 40% stop-loss (**disabled by default**). The risk manager is bound to the
ledger, so nothing can open or close a position behind the ledger's back. Closed positions free
their slot exactly once and update the balance and daily PnL exactly once.

## Understanding the results

A passing test suite shows the code does what it is specified to do on fabricated data. It does
**not** show that the strategy is profitable, and it does **not** show that any real token is safe.

- Net PnL across the showcase depends entirely on which fabricated tokens were written, so
  comparing profiles on it is meaningless. A profile that "wins" more on the showcase only means
  its extra entry happened to be a token scripted to rise.
- The clean-looking rug shows the main limitation directly: a token that looks identical to a
  winner at decision time can still lose almost the whole position.
- Thresholds are placeholders. Real tokens gap, stall, get manipulated, and have costs far above 0.

## Stage 3 compatibility

`--entry-policy launch` runs the Stage 3 simulator exactly as before: every token is entered at its
first price with no checks, and forced end-of-feed closures are still labelled `MANUAL`. All Stage 1
to 3 tests are unchanged except `tests/cli.test.js`, whose Stage 3 CLI tests now select
`--entry-policy launch` explicitly because the CLI default is now the Stage 4 strategy.
`FEED_ENDED` was added to the ledger without changing any existing ledger behavior.

## Project layout

```
package.json
README.md
src/
  accounting.js         money rounding and outcome classification
  config.js             risk settings and validation
  risk-manager.js       entry rules, balance, daily realized PnL
  trade-ledger.js       paper trades, take-profit, optional stop-loss, FEED_ENDED, consistency
  mock-feed.js          Stage 3 deterministic fake price paths (seeded random walk)
  simulator.js          Stage 3 simulator (entry policy: launch)
  report.js             Stage 3 report formatting
  strategy-config.js    Stage 4 profiles, validation, first-eligible-tick rule
  entry-checks.js       Stage 4 three-valued checks, price impact, decision rules
  mock-attributes.js    Stage 4 fabricated attributes, archetypes, showcase tokens
  strategy-simulator.js Stage 4 strategy-driven simulation through the ledger
  strategy-report.js    Stage 4 report formatting
  cli.js                command line options and run logic
  run-simulation.js     entry point for `npm run simulate`
tests/
  risk-manager.test.js        trade-ledger.test.js     loss-management.test.js
  mock-feed.test.js           simulator.test.js        cli.test.js
  strategy-config.test.js     entry-checks.test.js     mock-attributes.test.js
  strategy-simulator.test.js  fill-rules.test.js       strategy-cli.test.js
  audit-regression.test.js
```

## Next stages (planned)

1. Strategy refinement on fabricated data (re-evaluation windows, exit signals), still paper only
2. A read-only data layer design, behind a clear interface, with no wallet, no signing and no
   transactions. Not started, and not part of this project's current scope