/**
 * Signal engine: converts evaluated strategy conditions into trading
 * signals. Built strictly on top of the logical expression engine
 * (which itself sits on the condition engine); it never resolves
 * indicators directly and contains no per-indicator branching, so new
 * indicators work here without modification.
 *
 * Pure, deterministic module: no database, network, exchange, order
 * creation, position mutation, backtest, or frontend logic. It stops at
 * signal generation -- execution layers consume the result.
 *
 * Strategy contract (models/strategy.model.js):
 *   entry: { action: "BUY", trigger: "FALSE_TO_TRUE",
 *            conditions: <condition tree> }
 *   exit.indicator: { enabled, conditions: <condition tree> }
 *   exit.stopLoss / exit.takeProfit: { enabled, type: "PERCENTAGE"|"POINTS",
 *     value }
 *   exit.trailingStop: { enabled, activation: "IMMEDIATE"|"AFTER_PROFIT",
 *     activationValue, type: "PERCENTAGE"|"POINTS", value }
 * Spot V1 is long-only: entry signals are BUY, exit signals are SELL.
 *
 * FALSE_TO_TRUE semantics: a signal fires only on the false -> true edge.
 * previous = true, current = true emits NO_SIGNAL (no repeated entries
 * while a condition remains true).
 *
 * Exit priority on a single evaluation (deterministic; mirrors the plan's
 * "first executable exit wins" principle for one open position):
 *   STOP_LOSS -> TAKE_PROFIT -> TRAILING_STOP -> INDICATOR.
 *
 * Position routing: pass position state explicitly whenever it is known
 * ({ position } or { hasOpenPosition } in context/options). When the state
 * is known, only the relevant side is considered (open -> exits only,
 * flat -> entries only). When unknown, both sides are evaluated with exit
 * priority. Backtest / paper / live loops should always pass position
 * state so a BUY is never suggested while a position is open.
 */

import { evaluateExpression } from "../logical/logicalExpressionEngine.js";
import {
    getCandlesForTimeframe,
    resolveEvaluationIndex
} from "../condition/operandResolver.js";

/** Internal signal representation. "BUY"/"SELL" match the order-side and
 * entry-action vocabulary of the strategy/order schemas. */
export const SIGNALS = Object.freeze({
    BUY: "BUY",
    SELL: "SELL",
    NO_SIGNAL: "NO_SIGNAL"
});

export const SIGNAL_REASONS = Object.freeze({
    NONE: "NONE",
    ENTRY_CONDITION: "ENTRY_CONDITION",
    EXIT_INDICATOR: "EXIT_INDICATOR",
    STOP_LOSS: "STOP_LOSS",
    TAKE_PROFIT: "TAKE_PROFIT",
    TRAILING_STOP: "TRAILING_STOP"
});

/** Mirrors strategy.entry.trigger. */
export const ENTRY_TRIGGERS = Object.freeze(["FALSE_TO_TRUE"]);

export const EXIT_LEVEL_TYPES = Object.freeze(["PERCENTAGE", "POINTS"]);

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * Apply an entry/exit edge trigger to a previous/current result pair.
 *
 * @param {string|undefined|null} trigger Defaults to "FALSE_TO_TRUE".
 * @param {boolean} previousResult
 * @param {boolean} currentResult
 * @returns {boolean} True only on the false -> true edge.
 * @throws On unsupported triggers or non-boolean results.
 */
export function applyTrigger(trigger, previousResult, currentResult) {
    const resolved = trigger === undefined || trigger === null ? "FALSE_TO_TRUE" : trigger;

    if (resolved !== "FALSE_TO_TRUE") {
        throw new Error(
            `Unsupported trigger: ${resolved}. Expected "FALSE_TO_TRUE".`
        );
    }

    if (typeof previousResult !== "boolean" || typeof currentResult !== "boolean") {
        throw new Error(
            "Invalid trigger evaluation: previous and current results " +
                `must be booleans, received (${typeof previousResult}, ` +
                `${typeof currentResult}).`
        );
    }

    return previousResult === false && currentResult === true;
}

// ---------------------------------------------------------------------------
// Strategy / context access helpers (plain reads, no DB)
// ---------------------------------------------------------------------------

function assertStrategy(strategy) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
        throw new Error("Invalid strategy: expected an object.");
    }
}

function readEntry(strategy) {
    assertStrategy(strategy);

    if (!strategy.entry || typeof strategy.entry !== "object") {
        throw new Error("Invalid strategy: strategy.entry is missing.");
    }

    return strategy.entry;
}

function readEntryConditions(strategy) {
    const entry = readEntry(strategy);

    if (
        entry.conditions === undefined ||
        entry.conditions === null ||
        (typeof entry.conditions === "object" &&
            !Array.isArray(entry.conditions) &&
            Object.keys(entry.conditions).length === 0)
    ) {
        throw new Error("Invalid strategy: strategy.entry.conditions is missing.");
    }

    return entry.conditions;
}

function readExitIndicator(strategy) {
    const exit =
        strategy && typeof strategy === "object" ? strategy.exit : undefined;

    if (!exit || typeof exit !== "object") {
        return { enabled: false, conditions: null };
    }

    const indicator = exit.indicator;

    if (!indicator || typeof indicator !== "object" || !indicator.enabled) {
        return { enabled: false, conditions: null };
    }

    if (indicator.conditions === undefined || indicator.conditions === null) {
        throw new Error(
            "Invalid strategy: indicator exit is enabled but " +
                "exit.indicator.conditions is missing."
        );
    }

    return { enabled: true, conditions: indicator.conditions };
}

function readPosition(context, options) {
    const position =
        (options && options.position !== undefined ? options.position : undefined) ??
        (context && context.position !== undefined ? context.position : undefined) ??
        null;

    if (position !== null && (typeof position !== "object" || Array.isArray(position))) {
        throw new Error("Invalid position: expected an object or null.");
    }

    return position;
}

/**
 * @returns {boolean|undefined} True when a position is open, false when
 *   flat, undefined when the caller did not provide position state.
 */
function readHasOpenPosition(context, options, position) {
    const explicit =
        (options && options.hasOpenPosition !== undefined
            ? options.hasOpenPosition
            : undefined) ??
        (context && context.hasOpenPosition !== undefined
            ? context.hasOpenPosition
            : undefined);

    if (explicit !== undefined) {
        if (typeof explicit !== "boolean") {
            throw new Error(
                "Invalid hasOpenPosition: expected a boolean."
            );
        }

        return explicit;
    }

    if (position) {
        return true;
    }

    return undefined;
}

function readEntryPrice(position) {
    if (!position) {
        return null;
    }

    const entryPrice =
        position.entryPrice !== undefined && position.entryPrice !== null
            ? position.entryPrice
            : position.averageEntryPrice;

    if (entryPrice === undefined || entryPrice === null) {
        return null;
    }

    if (typeof entryPrice !== "number" || !Number.isFinite(entryPrice)) {
        throw new Error(
            `Invalid position entry price: ${entryPrice}. ` +
                "Expected a finite number."
        );
    }

    return entryPrice;
}

/**
 * Resolve the current market price for level-exit evaluation.
 * Explicit caller input wins, then the open position's tracked price
 * (position.currentPrice per the position schema), otherwise the close
 * of the default series at the evaluation index is used.
 *
 * @returns {number|null} Null when no price source is available.
 */
function resolveCurrentPrice(context, options, position) {
    const explicit =
        (options && options.currentPrice !== undefined ? options.currentPrice : undefined) ??
        (context && context.currentPrice !== undefined ? context.currentPrice : undefined) ??
        (context && context.price !== undefined ? context.price : undefined);

    if (explicit !== undefined && explicit !== null) {
        if (typeof explicit !== "number" || !Number.isFinite(explicit)) {
            throw new Error(
                `Invalid current price: ${explicit}. Expected a finite number.`
            );
        }

        return explicit;
    }

    const tracked =
        position && position.currentPrice !== undefined && position.currentPrice !== null
            ? position.currentPrice
            : undefined;

    if (tracked !== undefined) {
        if (typeof tracked !== "number" || !Number.isFinite(tracked)) {
            throw new Error(
                `Invalid position current price: ${tracked}. ` +
                    "Expected a finite number."
            );
        }

        return tracked;
    }

    try {
        const { candles, timeframeKey } = getCandlesForTimeframe(
            context && context.defaultTimeframe !== undefined
                ? context.defaultTimeframe
                : undefined,
            context ?? {}
        );
        const index = resolveEvaluationIndex(candles, timeframeKey, context ?? {}, 0);
        const candle = index >= 0 ? candles[index] : null;
        const close =
            candle && typeof candle === "object" ? candle.close : undefined;

        return typeof close === "number" && Number.isFinite(close) ? close : null;
    } catch {
        return null;
    }
}

/**
 * Resolve the signal timestamp: explicit input wins, otherwise the current
 * bar's candle timestamp, otherwise null (never fabricated).
 */
function resolveSignalTimestamp(context, options) {
    if (options && options.timestamp !== undefined && options.timestamp !== null) {
        return options.timestamp;
    }

    if (context && context.timestamp !== undefined && context.timestamp !== null) {
        return context.timestamp;
    }

    try {
        const { candles, timeframeKey } = getCandlesForTimeframe(
            context && context.defaultTimeframe !== undefined
                ? context.defaultTimeframe
                : undefined,
            context ?? {}
        );
        const index = resolveEvaluationIndex(candles, timeframeKey, context ?? {}, 0);
        const candle = index >= 0 ? candles[index] : null;

        if (candle && typeof candle === "object" && candle.timestamp !== undefined) {
            return candle.timestamp;
        }
    } catch {
        // No usable candle series: timestamp stays null.
    }

    return null;
}

// ---------------------------------------------------------------------------
// Price-level exits (pure threshold math, long-only spot)
// ---------------------------------------------------------------------------

function assertLevelConfig(kind, config) {
    if (!config.enabled) {
        return null;
    }

    if (!EXIT_LEVEL_TYPES.includes(config.type)) {
        throw new Error(
            `Invalid ${kind} type: ${config.type}. ` +
                `Expected one of: ${EXIT_LEVEL_TYPES.join(", ")}.`
        );
    }

    if (
        typeof config.value !== "number" ||
        !Number.isFinite(config.value) ||
        config.value < 0
    ) {
        throw new Error(
            `Invalid ${kind} value: ${config.value}. ` +
                "Expected a finite number >= 0."
        );
    }

    return { type: config.type, value: config.value };
}

/**
 * Compute absolute stop-loss / take-profit prices from an entry price.
 * PERCENTAGE is relative to the entry price; POINTS is an absolute price
 * distance (same unit as the price series).
 *
 * @param {number} entryPrice
 * @param {object} exit Strategy `exit` object (stopLoss/takeProfit read).
 * @returns {{ stopLossPrice: number|null, takeProfitPrice: number|null }}
 */
export function computeExitLevelPrices(entryPrice, exit) {
    if (typeof entryPrice !== "number" || !Number.isFinite(entryPrice)) {
        throw new Error(
            `Invalid entry price: ${entryPrice}. Expected a finite number.`
        );
    }

    const source = exit && typeof exit === "object" ? exit : {};
    let stopLossPrice = null;
    let takeProfitPrice = null;

    if (source.stopLoss && typeof source.stopLoss === "object") {
        const config = assertLevelConfig("stopLoss", source.stopLoss);

        if (config) {
            stopLossPrice =
                config.type === "PERCENTAGE"
                    ? entryPrice * (1 - config.value / 100)
                    : entryPrice - config.value;
        }
    }

    if (source.takeProfit && typeof source.takeProfit === "object") {
        const config = assertLevelConfig("takeProfit", source.takeProfit);

        if (config) {
            takeProfitPrice =
                config.type === "PERCENTAGE"
                    ? entryPrice * (1 + config.value / 100)
                    : entryPrice + config.value;
        }
    }

    return { stopLossPrice, takeProfitPrice };
}

/**
 * Long spot stop-loss: current price at or below the stop level.
 *
 * @param {number} currentPrice
 * @param {{ enabled: boolean, type: string, value: number }} stopLoss
 * @param {number} entryPrice
 * @returns {boolean}
 */
export function isStopLossHit(currentPrice, stopLoss, entryPrice) {
    if (!stopLoss || !stopLoss.enabled) {
        return false;
    }

    const { stopLossPrice } = computeExitLevelPrices(entryPrice, { stopLoss });

    return (
        stopLossPrice !== null &&
        typeof currentPrice === "number" &&
        Number.isFinite(currentPrice) &&
        currentPrice <= stopLossPrice
    );
}

/**
 * Long spot take-profit: current price at or above the profit level.
 *
 * @param {number} currentPrice
 * @param {{ enabled: boolean, type: string, value: number }} takeProfit
 * @param {number} entryPrice
 * @returns {boolean}
 */
export function isTakeProfitHit(currentPrice, takeProfit, entryPrice) {
    if (!takeProfit || !takeProfit.enabled) {
        return false;
    }

    const { takeProfitPrice } = computeExitLevelPrices(entryPrice, { takeProfit });

    return (
        takeProfitPrice !== null &&
        typeof currentPrice === "number" &&
        Number.isFinite(currentPrice) &&
        currentPrice >= takeProfitPrice
    );
}

/**
 * Evaluate a trailing stop against the highest price seen since entry.
 *
 * Interface note (explicit assumption, documented because the schema does
 * not spell it out): `activationValue` uses the same unit as the trailing
 * `type` (PERCENTAGE -> percent move from entry, POINTS -> absolute price
 * distance from entry). `highestPrice` should be tracked by the caller
 * (backtester / live position manager); when absent it falls back to
 * `currentPrice`, which is conservative (never invents a higher high).
 *
 * @param {object} params
 * @param {number} params.entryPrice
 * @param {number} params.currentPrice
 * @param {number|undefined|null} params.highestPrice
 * @param {object} params.trailingStop Strategy trailingStop object.
 * @returns {{ active: boolean, triggered: boolean,
 *   stopPrice: number|null, activationPrice: number|null }}
 */
export function evaluateTrailingStop({
    entryPrice,
    currentPrice,
    highestPrice,
    trailingStop
}) {
    const empty = {
        active: false,
        triggered: false,
        stopPrice: null,
        activationPrice: null
    };

    if (!trailingStop || !trailingStop.enabled) {
        return empty;
    }

    if (typeof entryPrice !== "number" || !Number.isFinite(entryPrice)) {
        throw new Error(
            `Invalid entry price: ${entryPrice}. Expected a finite number.`
        );
    }

    if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) {
        throw new Error(
            `Invalid current price: ${currentPrice}. Expected a finite number.`
        );
    }

    const config = assertLevelConfig("trailingStop", trailingStop);

    if (trailingStop.activation !== "IMMEDIATE" && trailingStop.activation !== "AFTER_PROFIT") {
        throw new Error(
            `Invalid trailingStop activation: ${trailingStop.activation}. ` +
                'Expected "IMMEDIATE" or "AFTER_PROFIT".'
        );
    }

    if (
        trailingStop.activation === "AFTER_PROFIT" &&
        (typeof trailingStop.activationValue !== "number" ||
            !Number.isFinite(trailingStop.activationValue) ||
            trailingStop.activationValue < 0)
    ) {
        throw new Error(
            `Invalid trailingStop activationValue: ${trailingStop.activationValue}. ` +
                "Expected a finite number >= 0."
        );
    }

    const highest =
        typeof highestPrice === "number" && Number.isFinite(highestPrice)
            ? highestPrice
            : currentPrice;

    let activationPrice = null;
    let active = false;

    if (trailingStop.activation === "IMMEDIATE") {
        active = true;
    } else {
        activationPrice =
            config.type === "PERCENTAGE"
                ? entryPrice * (1 + trailingStop.activationValue / 100)
                : entryPrice + trailingStop.activationValue;
        active = highest >= activationPrice;
    }

    if (!active) {
        return { active: false, triggered: false, stopPrice: null, activationPrice };
    }

    const stopPrice =
        config.type === "PERCENTAGE"
            ? highest * (1 - config.value / 100)
            : highest - config.value;

    return {
        active: true,
        triggered: currentPrice <= stopPrice,
        stopPrice,
        activationPrice
    };
}

// ---------------------------------------------------------------------------
// Entry / exit evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the entry side of a strategy.
 *
 * @param {object} strategy Strategy object with `entry`.
 * @param {object} context Evaluation context.
 * @param {object} [options]
 * @param {boolean} [options.previousEntryResult] Externally tracked
 *   previous evaluation (live-trading mode). Defaults to evaluating the
 *   tree one bar back (backtest mode).
 * @returns {{ signal, timestamp, reason, conditionResult,
 *   previousConditionResult, metadata }}
 */
export function evaluateEntrySignal(strategy, context = {}, options = {}) {
    const entry = readEntry(strategy);
    const conditions = readEntryConditions(strategy);
    const trigger = entry.trigger === undefined || entry.trigger === null
        ? "FALSE_TO_TRUE"
        : entry.trigger;

    const currentResult = evaluateExpression(conditions, context, 0);
    const previousResult =
        options.previousEntryResult !== undefined &&
        options.previousEntryResult !== null
            ? options.previousEntryResult
            : evaluateExpression(conditions, context, 1);

    const edge = applyTrigger(trigger, previousResult, currentResult);

    return {
        signal: edge ? SIGNALS.BUY : SIGNALS.NO_SIGNAL,
        timestamp: resolveSignalTimestamp(context, options),
        reason: edge ? SIGNAL_REASONS.ENTRY_CONDITION : SIGNAL_REASONS.NONE,
        conditionResult: currentResult,
        previousConditionResult: previousResult,
        metadata: {
            market:
                (context && context.market) ??
                (options && options.market) ??
                null,
            trigger,
            action: entry.action ?? "BUY"
        }
    };
}

/**
 * Evaluate the exit side of a strategy (indicator conditions plus
 * stop-loss / take-profit / trailing-stop levels).
 *
 * Level exits require an open position with a finite entry price plus a
 * resolvable current price; without a position only the indicator exit is
 * considered. Without any enabled exit, the result is NO_SIGNAL.
 *
 * @param {object} strategy Strategy object with `exit`.
 * @param {object} context Evaluation context.
 * @param {object} [options]
 * @param {object} [options.position] Open position
 *   ({ entryPrice } or { averageEntryPrice }).
 * @param {number} [options.currentPrice] Override for the current price.
 * @param {number} [options.highestPrice] Highest price since entry
 *   (trailing-stop reference).
 * @param {boolean} [options.previousExitIndicatorResult] Externally tracked
 *   previous indicator-exit evaluation.
 * @returns {{ signal, timestamp, reason, conditionResult,
 *   previousConditionResult, levels, metadata }}
 */
export function evaluateExitSignal(strategy, context = {}, options = {}) {
    assertStrategy(strategy);

    const exit = strategy.exit && typeof strategy.exit === "object" ? strategy.exit : {};
    const indicatorExit = readExitIndicator(strategy);

    let indicatorCurrent = false;
    let indicatorPrevious = false;
    let indicatorEdge = false;

    if (indicatorExit.enabled) {
        indicatorCurrent = evaluateExpression(indicatorExit.conditions, context, 0);
        indicatorPrevious =
            options.previousExitIndicatorResult !== undefined &&
            options.previousExitIndicatorResult !== null
                ? options.previousExitIndicatorResult
                : evaluateExpression(indicatorExit.conditions, context, 1);
        indicatorEdge = applyTrigger("FALSE_TO_TRUE", indicatorPrevious, indicatorCurrent);
    } else if (
        options.previousExitIndicatorResult !== undefined &&
        options.previousExitIndicatorResult !== null &&
        typeof options.previousExitIndicatorResult !== "boolean"
    ) {
        throw new Error(
            "Invalid previousExitIndicatorResult: expected a boolean."
        );
    }

    const position = readPosition(context, options);
    const entryPrice = readEntryPrice(position);

    let levels = null;
    let levelReason = SIGNAL_REASONS.NONE;

    const wantsLevels =
        position &&
        entryPrice !== null &&
        ((exit.stopLoss && exit.stopLoss.enabled) ||
            (exit.takeProfit && exit.takeProfit.enabled) ||
            (exit.trailingStop && exit.trailingStop.enabled));

    if (wantsLevels) {
        const currentPrice = resolveCurrentPrice(context, options, position);

        if (currentPrice === null) {
            throw new Error(
                "Cannot evaluate price-level exits: current price is " +
                    "unavailable. Provide options.currentPrice, " +
                    "context.currentPrice, or candles with close values."
            );
        }

        const { stopLossPrice, takeProfitPrice } = computeExitLevelPrices(
            entryPrice,
            exit
        );

        const trailing = evaluateTrailingStop({
            entryPrice,
            currentPrice,
            highestPrice:
                options.highestPrice !== undefined
                    ? options.highestPrice
                    : context
                      ? context.highestPrice
                      : undefined,
            trailingStop: exit.trailingStop
        });

        const stopHit =
            stopLossPrice !== null && currentPrice <= stopLossPrice;
        const profitHit =
            takeProfitPrice !== null && currentPrice >= takeProfitPrice;

        // Deterministic priority: STOP_LOSS -> TAKE_PROFIT -> TRAILING_STOP.
        if (stopHit) {
            levelReason = SIGNAL_REASONS.STOP_LOSS;
        } else if (profitHit) {
            levelReason = SIGNAL_REASONS.TAKE_PROFIT;
        } else if (trailing.triggered) {
            levelReason = SIGNAL_REASONS.TRAILING_STOP;
        }

        levels = {
            entryPrice,
            currentPrice,
            stopLossPrice,
            takeProfitPrice,
            trailing
        };
    }

    let signal = SIGNALS.NO_SIGNAL;
    let reason = SIGNAL_REASONS.NONE;

    if (levelReason !== SIGNAL_REASONS.NONE) {
        signal = SIGNALS.SELL;
        reason = levelReason;
    } else if (indicatorEdge) {
        signal = SIGNALS.SELL;
        reason = SIGNAL_REASONS.EXIT_INDICATOR;
    }

    return {
        signal,
        timestamp: resolveSignalTimestamp(context, options),
        reason,
        conditionResult: indicatorCurrent,
        previousConditionResult: indicatorPrevious,
        levels,
        metadata: {
            market:
                (context && context.market) ??
                (options && options.market) ??
                null,
            trigger: "FALSE_TO_TRUE",
            indicatorExitEnabled: indicatorExit.enabled
        }
    };
}

/**
 * Generate one signal for a strategy at the evaluation context's bar.
 *
 * Routing:
 *   hasOpenPosition === true  -> exits only (levels, then indicator).
 *   hasOpenPosition === false -> entries only.
 *   unknown                   -> both evaluated, exit priority
 *                                (callers that track positions should always
 *                                pass position state instead).
 *
 * @param {object} strategy Strategy object with `entry` / `exit`.
 * @param {object} context Evaluation context (candles, index, cache,
 *   market, timestamp, optional position / hasOpenPosition / prices).
 * @param {object} [options] Overrides: previousEntryResult,
 *   previousExitIndicatorResult, position, hasOpenPosition, currentPrice,
 *   highestPrice, timestamp, market.
 * @returns {{ signal, timestamp, reason, conditionResult,
 *   previousConditionResult, exit, levels, metadata }}
 *   signal is one of "BUY" | "SELL" | "NO_SIGNAL". Never creates orders or
 *   mutates positions.
 */
export function generateSignal(strategy, context = {}, options = {}) {
    assertStrategy(strategy);

    const entry = evaluateEntrySignal(strategy, context, options);
    const position = readPosition(context, options);
    const hasOpenPosition = readHasOpenPosition(context, options, position);

    if (hasOpenPosition === true) {
        const exitResult = evaluateExitSignal(strategy, context, options);

        return {
            signal: exitResult.signal,
            timestamp: exitResult.timestamp,
            reason: exitResult.reason,
            conditionResult: entry.conditionResult,
            previousConditionResult: entry.previousConditionResult,
            exit: {
                enabled: exitResult.metadata.indicatorExitEnabled,
                currentResult: exitResult.conditionResult,
                previousResult: exitResult.previousConditionResult
            },
            levels: exitResult.levels,
            metadata: {
                market: exitResult.metadata.market,
                trigger: "FALSE_TO_TRUE",
                hasOpenPosition: true
            }
        };
    }

    if (hasOpenPosition === false) {
        return {
            signal: entry.signal,
            timestamp: entry.timestamp,
            reason: entry.reason,
            conditionResult: entry.conditionResult,
            previousConditionResult: entry.previousConditionResult,
            exit: null,
            levels: null,
            metadata: {
                market: entry.metadata.market,
                trigger: entry.metadata.trigger,
                hasOpenPosition: false
            }
        };
    }

    // Position state unknown: evaluate exits too, exit priority.
    const exitResult = evaluateExitSignal(strategy, context, options);

    if (exitResult.signal === SIGNALS.SELL) {
        return {
            signal: SIGNALS.SELL,
            timestamp: exitResult.timestamp,
            reason: exitResult.reason,
            conditionResult: entry.conditionResult,
            previousConditionResult: entry.previousConditionResult,
            exit: {
                enabled: exitResult.metadata.indicatorExitEnabled,
                currentResult: exitResult.conditionResult,
                previousResult: exitResult.previousConditionResult
            },
            levels: exitResult.levels,
            metadata: {
                market: exitResult.metadata.market,
                trigger: "FALSE_TO_TRUE",
                hasOpenPosition: null
            }
        };
    }

    return {
        signal: entry.signal,
        timestamp: entry.timestamp,
        reason: entry.reason,
        conditionResult: entry.conditionResult,
        previousConditionResult: entry.previousConditionResult,
        exit: exitResult.metadata.indicatorExitEnabled
            ? {
                enabled: true,
                currentResult: exitResult.conditionResult,
                previousResult: exitResult.previousConditionResult
            }
            : null,
        levels: exitResult.levels,
        metadata: {
            market: entry.metadata.market,
            trigger: entry.metadata.trigger,
            hasOpenPosition: null
        }
    };
}

export default {
    SIGNALS,
    SIGNAL_REASONS,
    ENTRY_TRIGGERS,
    EXIT_LEVEL_TYPES,
    applyTrigger,
    computeExitLevelPrices,
    isStopLossHit,
    isTakeProfitHit,
    evaluateTrailingStop,
    evaluateEntrySignal,
    evaluateExitSignal,
    generateSignal
};
