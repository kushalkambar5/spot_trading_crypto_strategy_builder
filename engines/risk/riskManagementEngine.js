/**
 * Risk management engine: sits between signal generation and order
 * generation/execution.
 *
 * Intended pipeline (one-directional -- this module never calls the signal
 * engine; the caller passes an already-generated signal):
 *
 *   signalEngine.generateSignal(strategy, marketContext)
 *       ↓  { signal: "BUY" | "SELL" | "NO_SIGNAL", ... }
 *   riskManagementEngine.evaluateRisk(strategy, signal, riskContext)
 *       ↓  { approved: true, ...riskDecision } | { approved: false, reason }
 *   future order engine (not part of this module)
 *
 * Pure, deterministic module: no database, network, exchange, indicator
 * math, order creation, backtest, or frontend logic. All runtime state
 * (balances, equity, positions, timestamps, market constraints, ATR values,
 * trailing-stop state) arrives through the context object, so the same
 * inputs always produce the same decision across backtesting, paper
 * trading, and live trading.
 *
 * Entry evaluation order (deterministic; cheap gates first so indicator
 * values such as ATR are never consumed for an already-blocked trade):
 *   1. Is the signal a valid BUY entry signal?
 *   2. Is the strategy enabled?
 *   3. Is cooldown active?
 *   4. Is max daily loss exceeded?
 *   5. Is max positions (and max trades/day) reached?
 *   6. Calculate requested (raw) position size.
 *   7. Validate maximum capital allocation + sufficient balance.
 *   8. Calculate stop loss.
 *   9. Calculate take profit.
 *   10. Calculate trailing-stop configuration.
 *   11. Calculate risk amount.
 *   12. Validate final quantity/notional against market constraints.
 *   13. Return the approved risk decision.
 *
 * Two outcome families (never mixed):
 *   - Risk rejection: `{ approved: false, reason }` with a reason from
 *     RISK_REJECTION_REASONS (e.g. MAX_POSITIONS_REACHED). Normal business.
 *   - Configuration error: `throw new Error("Invalid ...")`. The strategy
 *     or context is malformed and must be fixed.
 *
 * Spot V1 is long-only: BUY opens/increases a spot position, SELL reduces
 * or closes it. Only "LONG" side math exists; anything else throws.
 */

import {
    calculateRawPositionSize,
    normalizePositionSize,
    readMarketConstraints,
    BELOW_MIN_QUANTITY,
    BELOW_MIN_NOTIONAL
} from "./positionSizer.js";
import { calculateStopLoss, isStopLossHit } from "./stopLoss.js";
import { calculateTakeProfit, isTakeProfitHit } from "./takeProfit.js";
import {
    calculateTrailingStop,
    isTrailingStopHit
} from "./trailingStop.js";
import {
    RISK_REJECTION_REASONS,
    readRiskBlock,
    checkCooldown,
    checkMaxDailyLoss,
    checkMaxPositions,
    checkMaxTradesPerDay,
    checkMaxCapitalAllocation
} from "./riskConstraints.js";
import {
    assertPositiveFiniteNumber,
    assertFiniteNumber,
    roundToTickSize,
    calculateRiskAmount
} from "./riskUtils.js";

export { RISK_REJECTION_REASONS };

/** Re-exported for callers that validate market minimums themselves. */
export { BELOW_MIN_QUANTITY, BELOW_MIN_NOTIONAL };

/** Version of the normalized risk-decision shape below. */
export const RISK_DECISION_VERSION = 1;

/** Exit reasons mirror models/position.model.js `exitReason`. */
export const EXIT_REASONS = Object.freeze({
    STOP_LOSS: "STOP_LOSS",
    TAKE_PROFIT: "TAKE_PROFIT",
    TRAILING_STOP: "TRAILING_STOP"
});

const DISABLED_STATUSES = Object.freeze(["STOPPED", "PAUSED"]);

// ---------------------------------------------------------------------------
// Signal / strategy / price access helpers (plain reads, no DB)
// ---------------------------------------------------------------------------

/**
 * Normalize caller-supplied signal input.
 *
 * Accepts a bare "BUY" string or a signal object such as the one produced
 * by `signalEngine.generateSignal` (`{ signal, timestamp, ... }`, price
 * optionally attached as `price` / `entryPrice` / `currentPrice`).
 *
 * @param {unknown} input
 * @returns {{ type: string, price: number|null, timestamp: unknown }}
 * @throws On malformed (unreadable) signal input.
 */
export function normalizeSignalInput(input) {
    if (typeof input === "string") {
        const type = input.trim().toUpperCase();

        if (type !== "BUY" && type !== "SELL" && type !== "NO_SIGNAL") {
            throw new Error(
                `Invalid signal: ${input}. ` +
                    'Expected "BUY", "SELL", or "NO_SIGNAL".'
            );
        }

        return { type, price: null, timestamp: null };
    }

    if (input && typeof input === "object" && !Array.isArray(input)) {
        const raw =
            input.signal !== undefined && input.signal !== null
                ? input.signal
                : input.type;
        const type = typeof raw === "string" ? raw.trim().toUpperCase() : raw;

        if (type !== "BUY" && type !== "SELL" && type !== "NO_SIGNAL") {
            throw new Error(
                `Invalid signal: ${raw}. ` +
                    'Expected "BUY", "SELL", or "NO_SIGNAL".'
            );
        }

        const price =
            input.price !== undefined && input.price !== null
                ? input.price
                : input.entryPrice !== undefined && input.entryPrice !== null
                  ? input.entryPrice
                  : input.currentPrice !== undefined &&
                      input.currentPrice !== null
                    ? input.currentPrice
                    : null;

        if (price !== null) {
            assertPositiveFiniteNumber(price, "Signal price");
        }

        return {
            type,
            price,
            timestamp:
                input.timestamp !== undefined ? input.timestamp : null,
            market:
                input.market !== undefined && input.market !== null
                    ? input.market
                    : input.metadata &&
                        typeof input.metadata === "object" &&
                        input.metadata.market !== undefined
                      ? input.metadata.market
                      : null
        };
    }

    throw new Error("Invalid signal: expected a signal string or object.");
}

/**
 * Resolve the entry price for a trade: explicit override wins, then the
 * signal's own price, then the runtime market price. Never invented.
 *
 * @param {object} normalizedSignal Output of normalizeSignalInput.
 * @param {object} context Runtime risk context.
 * @param {object} [options] `{ entryPrice }` override.
 * @returns {number}
 * @throws When no finite positive price is available.
 */
export function resolveEntryPrice(normalizedSignal, context, options = {}) {
    const source = context && typeof context === "object" ? context : {};
    const opts = options && typeof options === "object" ? options : {};

    const candidates = [
        opts.entryPrice,
        normalizedSignal.price,
        source.entryPrice,
        source.currentPrice,
        source.price
    ];

    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null) {
            assertPositiveFiniteNumber(candidate, "Entry price");
            return candidate;
        }
    }

    throw new Error(
        "Missing entry price: provide options.entryPrice, a signal price, " +
            "or context.currentPrice."
    );
}

/**
 * Read the strategy exit block leniently (absent block = all exits off).
 *
 * @param {object} strategy
 * @returns {{ stopLoss: object|null, takeProfit: object|null,
 *   trailingStop: object|null }}
 */
function readExitBlock(strategy) {
    const exit =
        strategy.exit && typeof strategy.exit === "object"
            ? strategy.exit
            : {};

    return {
        stopLoss:
            exit.stopLoss && typeof exit.stopLoss === "object"
                ? exit.stopLoss
                : null,
        takeProfit:
            exit.takeProfit && typeof exit.takeProfit === "object"
                ? exit.takeProfit
                : null,
        trailingStop:
            exit.trailingStop && typeof exit.trailingStop === "object"
                ? exit.trailingStop
                : null
    };
}

/**
 * @param {object} strategy
 * @returns {boolean} True when the strategy may take new entries.
 * @throws When the strategy is not an object.
 */
export function isStrategyEnabled(strategy) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
        throw new Error("Invalid strategy: expected an object.");
    }

    if (strategy.enabled === false) {
        return false;
    }

    if (
        typeof strategy.status === "string" &&
        DISABLED_STATUSES.includes(strategy.status)
    ) {
        return false;
    }

    return true;
}

function rejection({
    reason,
    failedAt,
    signal,
    market,
    timestamp,
    entryPrice,
    detail
}) {
    const result = {
        approved: false,
        reason,
        failedAt,
        signal,
        market: market ?? null,
        timestamp: timestamp ?? null
    };

    if (entryPrice !== undefined && entryPrice !== null) {
        result.entry = { price: entryPrice };
    }

    if (detail !== undefined && detail !== null) {
        result.detail = detail;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Entry evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a BUY signal against strategy risk configuration plus runtime
 * portfolio/account context.
 *
 * SELL signals are exits, not entries: pass them to
 * `evaluatePositionExit` (or the signal engine) instead. A SELL or
 * NO_SIGNAL passed here yields a rejection, never an approval and never
 * an exception for well-formed input.
 *
 * @param {object} strategy Strategy object (`positionSizing`, `exit`,
 *   `riskManagement` per models/strategy.model.js). Extra sizing/exit
 *   types beyond the stored enums are accepted leniently (see each
 *   sub-module); persisting them requires a schema enum extension.
 * @param {string|object} signalInput "BUY" or a signal object
 *   (`{ signal: "BUY", price?, timestamp? }`).
 * @param {object} [context] Runtime context:
 *   `{ currentPrice, portfolioValue, availableBalance, openPositions |
 *   openPositionCount, deployedCapital, dailyStartingEquity, currentEquity
 *   | dailyPnL | realizedDailyPnL + unrealizedPnL, tradesTodayCount,
 *   lastTradeTimestamp, currentTimestamp, marketConstraints { minQuantity,
 *   maxQuantity, stepSize, minNotional, tickSize }, atrValue,
 *   positionState { highestPrice, previousTrailingStop }, market }`.
 * @param {object} [options] `{ entryPrice, market, timestamp }` overrides.
 * @returns {object} Approved risk decision or `{ approved: false, reason }`.
 * @throws On invalid strategy configuration or missing required context.
 */
export function evaluateRisk(strategy, signalInput, context = {}, options = {}) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
        throw new Error("Invalid strategy: expected an object.");
    }

    const source = context && typeof context === "object" ? context : {};
    const opts = options && typeof options === "object" ? options : {};
    const signal = normalizeSignalInput(signalInput);
    const market =
        opts.market !== undefined && opts.market !== null
            ? opts.market
            : signal.market !== undefined && signal.market !== null
              ? signal.market
              : source.market !== undefined && source.market !== null
                ? source.market
                : null;
    const timestamp =
        opts.timestamp !== undefined && opts.timestamp !== null
            ? opts.timestamp
            : signal.timestamp !== undefined && signal.timestamp !== null
              ? signal.timestamp
              : source.currentTimestamp !== undefined
                ? source.currentTimestamp
                : null;

    // 1. Signal must be a BUY entry signal (spot V1 is long-only).
    if (signal.type === "NO_SIGNAL") {
        return rejection({
            reason: RISK_REJECTION_REASONS.NO_SIGNAL,
            failedAt: "SIGNAL",
            signal: signal.type,
            market,
            timestamp
        });
    }

    if (signal.type !== "BUY") {
        return rejection({
            reason: RISK_REJECTION_REASONS.INVALID_SIGNAL,
            failedAt: "SIGNAL",
            signal: signal.type,
            market,
            timestamp,
            detail: `Entry evaluation accepts BUY signals only, received "${signal.type}".`
        });
    }

    // 2. Strategy must be enabled.
    if (!isStrategyEnabled(strategy)) {
        return rejection({
            reason: RISK_REJECTION_REASONS.STRATEGY_DISABLED,
            failedAt: "STRATEGY",
            signal: signal.type,
            market,
            timestamp
        });
    }

    const risk = readRiskBlock(strategy);

    // 3. Cooldown.
    const cooldown = checkCooldown(risk, source);

    if (!cooldown.passed) {
        return rejection({
            reason: cooldown.reason,
            failedAt: "COOLDOWN",
            signal: signal.type,
            market,
            timestamp,
            detail: cooldown.detail
        });
    }

    // 4. Max daily loss.
    const dailyLoss = checkMaxDailyLoss(risk, source);

    if (!dailyLoss.passed) {
        return rejection({
            reason: dailyLoss.reason,
            failedAt: "MAX_DAILY_LOSS",
            signal: signal.type,
            market,
            timestamp,
            detail: dailyLoss.detail
        });
    }

    // 5. Max positions + max trades per day.
    const positions = checkMaxPositions(risk, source);

    if (!positions.passed) {
        return rejection({
            reason: positions.reason,
            failedAt: "MAX_POSITIONS",
            signal: signal.type,
            market,
            timestamp,
            detail: positions.detail
        });
    }

    const tradesPerDay = checkMaxTradesPerDay(risk, source);

    if (!tradesPerDay.passed) {
        return rejection({
            reason: tradesPerDay.reason,
            failedAt: "MAX_TRADES_PER_DAY",
            signal: signal.type,
            market,
            timestamp,
            detail: tradesPerDay.detail
        });
    }

    // Entry price (signal/current -- never assumed).
    const entryPrice = resolveEntryPrice(signal, source, opts);

    if (!strategy.positionSizing || typeof strategy.positionSizing !== "object") {
        throw new Error(
            "Invalid strategy: strategy.positionSizing is missing."
        );
    }

    // 6. Requested (raw) position size.
    const raw = calculateRawPositionSize(strategy.positionSizing, {
        entryPrice,
        portfolioValue: source.portfolioValue ?? source.portfolio,
        availableBalance: source.availableBalance
    });

    // 7a. Maximum capital allocation (total deployed, not just this trade).
    const allocation = checkMaxCapitalAllocation(risk, source, raw.notional);

    if (!allocation.passed) {
        return rejection({
            reason: allocation.reason,
            failedAt: "MAX_CAPITAL_ALLOCATION",
            signal: signal.type,
            market,
            timestamp,
            entryPrice,
            detail: allocation.detail
        });
    }

    // 7b. Sufficient balance for this trade's notional.
    if (
        source.availableBalance !== undefined &&
        source.availableBalance !== null
    ) {
        assertFiniteNumber(source.availableBalance, "Available balance");

        if (raw.notional > source.availableBalance) {
            return rejection({
                reason: RISK_REJECTION_REASONS.INSUFFICIENT_BALANCE,
                failedAt: "BALANCE",
                signal: signal.type,
                market,
                timestamp,
                entryPrice,
                detail:
                    `Trade notional (${raw.notional}) exceeds available ` +
                    `balance (${source.availableBalance}).`
            });
        }
    }

    // 8-10. Stop loss, take profit, trailing-stop configuration.
    const exit = readExitBlock(strategy);
    const atrValue =
        source.atrValue !== undefined && source.atrValue !== null
            ? source.atrValue
            : source.atr !== undefined && source.atr !== null
              ? source.atr
              : source.indicators && typeof source.indicators === "object"
                ? source.indicators.atr
                : undefined;

    const stopLoss = calculateStopLoss({
        entryPrice,
        stopLoss: exit.stopLoss,
        atrValue,
        atr: source.atr,
        indicators: source.indicators
    });

    const takeProfit = calculateTakeProfit({
        entryPrice,
        takeProfit: exit.takeProfit,
        stopLossPrice: stopLoss.price
    });

    const positionState =
        source.positionState && typeof source.positionState === "object"
            ? source.positionState
            : {};

    const trailing = calculateTrailingStop({
        entryPrice,
        currentPrice: entryPrice,
        highestPrice:
            positionState.highestPrice !== undefined
                ? positionState.highestPrice
                : source.highestPrice,
        previousTrailingStop:
            positionState.previousTrailingStop !== undefined
                ? positionState.previousTrailingStop
                : source.previousTrailingStop,
        trailingStop: exit.trailingStop,
        trailingPercent:
            source.trailingPercent !== undefined
                ? source.trailingPercent
                : positionState.trailingPercent
    });

    // 12. Final quantity/notional validation against market constraints.
    const marketConstraints = readMarketConstraints(
        source.marketConstraints ?? source.limits ?? opts.marketConstraints
    );
    const normalized = normalizePositionSize(
        raw.quantity,
        entryPrice,
        source.marketConstraints ?? source.limits ?? opts.marketConstraints
    );

    if (!normalized.ok) {
        return rejection({
            reason: normalized.reason,
            failedAt: "MARKET_CONSTRAINTS",
            signal: signal.type,
            market,
            timestamp,
            entryPrice,
            detail: normalized.detail
        });
    }

    // Tick-size rounding applies to trigger levels only, after all math.
    const tickSize = marketConstraints.tickSize;
    const snap = price =>
        tickSize !== null && price !== null ? roundToTickSize(price, tickSize) : price;

    const finalStopPrice = snap(stopLoss.price);
    const finalTakePrice = snap(takeProfit.price);
    const finalTrailingPrice = snap(trailing.stopPrice);

    // 11. Actual monetary risk from the (tick-snapped) stop distance.
    let riskAmount = null;

    if (stopLoss.enabled && finalStopPrice !== null) {
        const portfolioValue = source.portfolioValue ?? source.portfolio;
        riskAmount = calculateRiskAmount({
            entryPrice,
            stopLossPrice: finalStopPrice,
            quantity: normalized.quantity,
            portfolioValue:
                portfolioValue !== undefined && portfolioValue !== null
                    ? portfolioValue
                    : undefined
        });
    }

    const portfolioValue = source.portfolioValue ?? source.portfolio;
    const capitalAllocationPercent =
        portfolioValue !== undefined &&
        portfolioValue !== null &&
        Number.isFinite(portfolioValue) &&
        portfolioValue > 0
            ? (normalized.notional / portfolioValue) * 100
            : null;

    // 13. Normalized risk decision for the future order engine.
    return {
        approved: true,
        version: RISK_DECISION_VERSION,
        signal: signal.type,
        market,
        timestamp,
        entry: { price: entryPrice },
        position: {
            quantity: normalized.quantity,
            notional: normalized.notional,
            sizingType: raw.sizingType,
            sizingValue: raw.sizingValue,
            rawQuantity: raw.quantity,
            rawNotional: raw.notional,
            marketAdjustments: normalized.adjustments
        },
        stopLoss: {
            enabled: stopLoss.enabled,
            price: finalStopPrice,
            type: stopLoss.type
        },
        takeProfit: {
            enabled: takeProfit.enabled,
            price: finalTakePrice,
            type: takeProfit.type,
            riskRewardRatio: takeProfit.riskRewardRatio
        },
        trailingStop: {
            enabled: trailing.enabled,
            active: trailing.active,
            stopPrice: finalTrailingPrice,
            rawStopPrice: snap(trailing.rawStopPrice),
            activationPrice: snap(trailing.activationPrice),
            highestPrice: trailing.highestPrice,
            previousTrailingStop: trailing.previousTrailingStop
        },
        risk: {
            riskAmount: riskAmount ? riskAmount.totalRisk : null,
            riskPerUnit: riskAmount ? riskAmount.riskPerUnit : null,
            riskPercent: riskAmount ? riskAmount.riskPercent : null,
            capitalAllocationPercent
        },
        constraints: {
            cooldown: true,
            maxDailyLoss: true,
            maxPositions: true,
            maxCapitalAllocation: true,
            maxTradesPerDay: true
        }
    };
}

// ---------------------------------------------------------------------------
// Position (exit) evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate an open long spot position against its exit protection:
 * stop loss -> take profit -> trailing stop (deterministic priority,
 * mirroring the signal engine).
 *
 * Callers may pass explicit level prices (tracked on the position, e.g.
 * `position.stopLossPrice`) and/or the strategy exit configuration (from
 * which levels are freshly calculated). Explicit prices win when both
 * are given.
 *
 * Indicator-based exits are NOT evaluated here -- they belong to the
 * signal engine. This function is pure exit-price math returning a
 * decision the future order/position layer can consume.
 *
 * @param {object} params
 * @param {object} [params.position] Open position (`entryPrice` or
 *   `averageEntryPrice`, optional tracked `stopLossPrice`,
 *   `takeProfitPrice`, `trailingStopPrice` per models/position.model.js).
 * @param {number} [params.entryPrice] Override when no position object.
 * @param {number} params.currentPrice Current market price (required).
 * @param {number} [params.stopLossPrice] Explicit stop level (wins over
 *   strategy config).
 * @param {number} [params.takeProfitPrice] Explicit profit level.
 * @param {number} [params.trailingStopPrice] Explicit trailing level.
 * @param {object} [params.stopLoss] Strategy `exit.stopLoss` object.
 * @param {object} [params.takeProfit] Strategy `exit.takeProfit` object.
 * @param {object} [params.trailingStop] Strategy `exit.trailingStop`.
 * @param {object} [params.exit] Strategy `exit` object alternative to the
 *   three fields above.
 * @param {number} [params.highestPrice] Highest price since entry.
 * @param {number} [params.previousTrailingStop] Prior trailing stop
 *   (ratchet reference).
 * @param {number} [params.atrValue] For ATR-mode stop calculation.
 * @param {string} [params.side="LONG"] Only "LONG" in spot V1.
 * @returns {{ shouldExit: boolean, reason: string|null,
 *   currentPrice: number, entryPrice: number,
 *   levels: { stopLossPrice: number|null, takeProfitPrice: number|null,
 *   trailingStopPrice: number|null }, trailing: object|null }}
 */
export function evaluatePositionExit(params = {}) {
    const source = params && typeof params === "object" ? params : {};

    if (
        source.currentPrice === undefined ||
        source.currentPrice === null
    ) {
        throw new Error(
            "Missing current price: position exit evaluation requires currentPrice."
        );
    }

    assertPositiveFiniteNumber(source.currentPrice, "Current price");

    const side = source.side !== undefined ? source.side : "LONG";

    if (side !== "LONG") {
        throw new Error(
            `Unsupported position side for exit evaluation: ${side}. ` +
                'Spot V1 supports "LONG" only.'
        );
    }

    const position =
        source.position && typeof source.position === "object"
            ? source.position
            : null;

    const entryPrice =
        source.entryPrice !== undefined && source.entryPrice !== null
            ? source.entryPrice
            : position && position.entryPrice !== undefined && position.entryPrice !== null
              ? position.entryPrice
              : position &&
                  position.averageEntryPrice !== undefined &&
                  position.averageEntryPrice !== null
                ? position.averageEntryPrice
                : null;

    if (entryPrice === null) {
        throw new Error(
            "Missing entry price: provide params.entryPrice or " +
                "position.entryPrice."
        );
    }

    assertPositiveFiniteNumber(entryPrice, "Entry price");

    const exitBlock =
        source.exit && typeof source.exit === "object" ? source.exit : {};
    const stopLossConfig =
        source.stopLoss !== undefined && source.stopLoss !== null
            ? source.stopLoss
            : exitBlock.stopLoss !== undefined && exitBlock.stopLoss !== null
              ? exitBlock.stopLoss
              : null;
    const takeProfitConfig =
        source.takeProfit !== undefined
            ? source.takeProfit
            : exitBlock.takeProfit !== undefined
              ? exitBlock.takeProfit
              : null;
    const trailingConfig =
        source.trailingStop !== undefined
            ? source.trailingStop
            : exitBlock.trailingStop !== undefined
              ? exitBlock.trailingStop
              : null;

    // Explicit tracked prices win over freshly calculated ones.
    let stopLossPrice =
        source.stopLossPrice !== undefined && source.stopLossPrice !== null
            ? source.stopLossPrice
            : position &&
                position.stopLossPrice !== undefined &&
                position.stopLossPrice !== null
              ? position.stopLossPrice
              : null;

    let takeProfitPrice =
        source.takeProfitPrice !== undefined && source.takeProfitPrice !== null
            ? source.takeProfitPrice
            : position &&
                position.takeProfitPrice !== undefined &&
                position.takeProfitPrice !== null
              ? position.takeProfitPrice
              : null;

    let trailingStopPrice =
        source.trailingStopPrice !== undefined &&
        source.trailingStopPrice !== null
            ? source.trailingStopPrice
            : position &&
                position.trailingStopPrice !== undefined &&
                position.trailingStopPrice !== null
              ? position.trailingStopPrice
              : null;

    let trailingDetail = null;

    if (stopLossPrice === null && stopLossConfig) {
        const calculated = calculateStopLoss({
            entryPrice,
            stopLoss: stopLossConfig,
            atrValue: source.atrValue,
            atr: source.atr,
            indicators: source.indicators
        });

        stopLossPrice = calculated.price;
    }

    if (takeProfitPrice === null && takeProfitConfig) {
        const calculated = calculateTakeProfit({
            entryPrice,
            takeProfit: takeProfitConfig,
            stopLossPrice
        });

        takeProfitPrice = calculated.price;
    }

    if (trailingStopPrice === null && trailingConfig) {
        const calculated = calculateTrailingStop({
            entryPrice,
            currentPrice: source.currentPrice,
            highestPrice:
                source.highestPrice !== undefined
                    ? source.highestPrice
                    : position
                      ? position.highestPrice
                      : undefined,
            previousTrailingStop:
                source.previousTrailingStop !== undefined
                    ? source.previousTrailingStop
                    : null,
            trailingStop: trailingConfig
        });

        trailingDetail = calculated;
        trailingStopPrice = calculated.active ? calculated.stopPrice : null;
    }

    for (const [label, level] of [
        ["Stop-loss price", stopLossPrice],
        ["Take-profit price", takeProfitPrice],
        ["Trailing-stop price", trailingStopPrice]
    ]) {
        if (level !== null) {
            assertPositiveFiniteNumber(level, label);
        }
    }

    let shouldExit = false;
    let reason = null;

    if (
        stopLossPrice !== null &&
        isStopLossHit(source.currentPrice, stopLossPrice)
    ) {
        shouldExit = true;
        reason = EXIT_REASONS.STOP_LOSS;
    } else if (
        takeProfitPrice !== null &&
        isTakeProfitHit(source.currentPrice, takeProfitPrice)
    ) {
        shouldExit = true;
        reason = EXIT_REASONS.TAKE_PROFIT;
    } else if (
        trailingStopPrice !== null &&
        isTrailingStopHit(source.currentPrice, trailingStopPrice)
    ) {
        shouldExit = true;
        reason = EXIT_REASONS.TRAILING_STOP;
    }

    return {
        shouldExit,
        reason,
        currentPrice: source.currentPrice,
        entryPrice,
        levels: {
            stopLossPrice,
            takeProfitPrice,
            trailingStopPrice
        },
        trailing: trailingDetail
    };
}

export default {
    RISK_REJECTION_REASONS,
    RISK_DECISION_VERSION,
    EXIT_REASONS,
    normalizeSignalInput,
    resolveEntryPrice,
    isStrategyEnabled,
    evaluateRisk,
    evaluatePositionExit
};
