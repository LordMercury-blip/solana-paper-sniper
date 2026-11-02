import defaultConfig, { validateConfig } from './config.js';
import { roundUsd } from './accounting.js';

// Tolerance for floating point comparisons on USD amounts.
const EPSILON = 1e-9;

export const REJECT = Object.freeze({
  INVALID_POSITION_SIZE: 'INVALID_POSITION_SIZE',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MAX_OPEN_POSITIONS: 'MAX_OPEN_POSITIONS',
  DAILY_LOSS_LIMIT: 'DAILY_LOSS_LIMIT',
  LEDGER_REQUIRED: 'LEDGER_REQUIRED',
});

export class RiskManager {
  // Private state: balance, daily PnL and positions can only change through
  // openPosition() and closePosition(), never by assigning to properties.
  #balanceUsd;
  #dailyPnlUsd = 0; // REALIZED net PnL since the last resetDaily()
  #positions = new Map(); // id -> { sizeUsd, entryFeeUsd }
  #nextId = 1;
  #positionsOpened = 0;
  #ledgerToken = null;

  constructor(cfg = defaultConfig) {
    this.config = Object.freeze({ ...validateConfig(cfg) });
    this.#balanceUsd = this.config.startingBalanceUsd;
  }

  /** Cash not tied up in open positions. */
  get balanceUsd() {
    return this.#balanceUsd;
  }

  /** Realized net PnL since the last resetDaily(). Unrealized PnL is never included. */
  get dailyPnlUsd() {
    return this.#dailyPnlUsd;
  }

  get openPositionCount() {
    return this.#positions.size;
  }

  // --- ledger binding ---

  /**
   * Called once by TradeLedger. After this, openPosition() and closePosition()
   * only work when given the returned token, so every position must go through
   * the ledger. A RiskManager that has never been bound still works standalone.
   */
  claimForLedger() {
    if (this.#ledgerToken !== null) {
      throw new Error('RiskManager is already bound to a TradeLedger');
    }
    if (this.#positionsOpened > 0) {
      throw new Error(
        'RiskManager has already been used; bind a fresh RiskManager to the TradeLedger'
      );
    }
    this.#ledgerToken = Symbol('ledger');
    return this.#ledgerToken;
  }

  #assertAuthorized(token) {
    if (this.#ledgerToken !== null && token !== this.#ledgerToken) {
      throw new Error(
        `${REJECT.LEDGER_REQUIRED}: positions must be opened and closed through the TradeLedger`
      );
    }
  }

  // --- costs ---

  /** Simulated cost charged on top of the position size when a position opens. */
  entryFeeFor(sizeUsd) {
    return roundUsd(sizeUsd * this.config.tradingFeeRate);
  }

  /** Simulated cost deducted from gross proceeds when a position closes. */
  exitFeeFor(grossProceedsUsd) {
    return roundUsd(grossProceedsUsd * this.config.tradingFeeRate);
  }

  // --- entry checks ---

  /** Returns { allowed: boolean, reason?: string, message?: string } */
  canOpenPosition(sizeUsd = this.config.positionSizeUsd) {
    if (
      typeof sizeUsd !== 'number' ||
      !Number.isFinite(sizeUsd) ||
      sizeUsd <= 0 ||
      sizeUsd > this.config.positionSizeUsd + EPSILON
    ) {
      return {
        allowed: false,
        reason: REJECT.INVALID_POSITION_SIZE,
        message: `Position size must be a number > 0 and <= ${this.config.positionSizeUsd}`,
      };
    }

    // Only REALIZED losses count here. Unrealized losses on open positions do not.
    if (this.#dailyPnlUsd <= -this.config.dailyLossLimitUsd + EPSILON) {
      return {
        allowed: false,
        reason: REJECT.DAILY_LOSS_LIMIT,
        message: `Daily loss limit of $${this.config.dailyLossLimitUsd} reached`,
      };
    }

    // Open positions occupy a slot no matter what their unrealized PnL is.
    if (this.#positions.size >= this.config.maxOpenPositions) {
      return {
        allowed: false,
        reason: REJECT.MAX_OPEN_POSITIONS,
        message: `Maximum of ${this.config.maxOpenPositions} open positions reached`,
      };
    }

    const requiredUsd = roundUsd(sizeUsd + this.entryFeeFor(sizeUsd));
    if (this.#balanceUsd + EPSILON < requiredUsd) {
      return {
        allowed: false,
        reason: REJECT.INSUFFICIENT_BALANCE,
        message: `Balance $${this.#balanceUsd} is below the $${requiredUsd} needed (position size plus entry costs)`,
      };
    }

    return { allowed: true };
  }

  // --- opening and closing ---

  /**
   * Reserves simulated funds (position size plus entry fee) and returns a position id.
   * Throws if rejected. When a TradeLedger is bound, only the ledger can call this.
   */
  openPosition(sizeUsd = this.config.positionSizeUsd, token = undefined) {
    this.#assertAuthorized(token);

    const check = this.canOpenPosition(sizeUsd);
    if (!check.allowed) {
      throw new Error(`${check.reason}: ${check.message}`);
    }

    const entryFeeUsd = this.entryFeeFor(sizeUsd);
    const id = this.#nextId++;
    this.#balanceUsd = roundUsd(this.#balanceUsd - sizeUsd - entryFeeUsd);
    this.#positions.set(id, { sizeUsd, entryFeeUsd });
    this.#positionsOpened += 1;
    return id;
  }

  /**
   * Shows what closing would settle to, without changing anything.
   * grossProceedsUsd is the simulated value of the position BEFORE the exit fee.
   * realizedPnlUsd = net proceeds - position size - entry fee.
   */
  previewClose(id, grossProceedsUsd) {
    const position = this.#positions.get(id);
    if (!position) {
      throw new Error(`Unknown position id: ${id}`);
    }
    if (
      typeof grossProceedsUsd !== 'number' ||
      !Number.isFinite(grossProceedsUsd) ||
      grossProceedsUsd < 0
    ) {
      throw new Error('proceedsUsd must be a finite number >= 0');
    }

    const exitFeeUsd = this.exitFeeFor(grossProceedsUsd);
    const netProceedsUsd = roundUsd(grossProceedsUsd - exitFeeUsd);
    const realizedPnlUsd = roundUsd(netProceedsUsd - position.sizeUsd - position.entryFeeUsd);

    return {
      sizeUsd: position.sizeUsd,
      entryFeeUsd: position.entryFeeUsd,
      grossProceedsUsd,
      exitFeeUsd,
      netProceedsUsd,
      realizedPnlUsd,
    };
  }

  /**
   * Closes a position. grossProceedsUsd is the simulated amount before the exit fee
   * (0 = total loss, 2 = 2x on a $1 position). Returns the realized PnL after costs.
   * Frees the slot immediately. When a TradeLedger is bound, only the ledger can call this.
   */
  closePosition(id, grossProceedsUsd, token = undefined) {
    this.#assertAuthorized(token);

    const settlement = this.previewClose(id, grossProceedsUsd);
    this.#balanceUsd = roundUsd(this.#balanceUsd + settlement.netProceedsUsd);
    this.#dailyPnlUsd = roundUsd(this.#dailyPnlUsd + settlement.realizedPnlUsd);
    this.#positions.delete(id);
    return settlement.realizedPnlUsd;
  }

  /** Returns a copy of an open position, or null if there is none with that id. */
  getPosition(id) {
    const position = this.#positions.get(id);
    return position ? { ...position } : null;
  }

  // --- trigger prices ---

  /** Price at which the take-profit triggers for a given entry price. */
  takeProfitPrice(entryPrice) {
    this.#assertEntryPrice(entryPrice);
    return entryPrice * this.config.takeProfitMultiplier;
  }

  /**
   * Price at or below which the stop-loss triggers, or null when stop-loss is
   * disabled (the default).
   */
  stopLossPrice(entryPrice) {
    this.#assertEntryPrice(entryPrice);
    if (!this.config.stopLossEnabled) {
      return null;
    }
    return entryPrice * (1 - this.config.stopLossFraction);
  }

  #assertEntryPrice(entryPrice) {
    if (
      typeof entryPrice !== 'number' ||
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0
    ) {
      throw new Error('entryPrice must be a positive finite number');
    }
  }

  /** Call at the start of a new trading day. Does not touch balance or open positions. */
  resetDaily() {
    this.#dailyPnlUsd = 0;
  }

  getState() {
    return {
      balanceUsd: this.#balanceUsd,
      dailyPnlUsd: this.#dailyPnlUsd,
      openPositions: this.#positions.size,
    };
  }
}

export default RiskManager;