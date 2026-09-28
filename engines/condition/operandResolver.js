/**
 * Operand resolver.
 *
 * Pure, deterministic runtime module: no database, network, exchange, order,
 * backtest, or frontend logic. It resolves a single strategy operand
 * (models/strategy.model.js `operandSchema`) to a runtime value for a given
 * bar offset:
 *
 *   indicator operand -> indicator registry -> existing indicator
 *                        implementation -> selected `output` -> value at
 *                        (evaluation index - barOffset)
 *   price operand     -> OHLC field of the candle at (index - barOffset)
 *   constant operand  -> the constant number itself
 *
 * Canonical operand shapes (exactly as defined by the Mongoose schema):
 *   { type: "price",     field: "close", timeframe: "15m" }
 *   { type: "indicator", name: "RSI", timeframe: "15m", output: "value",
 *     settings: { period: 14, source: "close" } }
 *   { type: "constant",  value: 30 }
 *
 * Tolerated aliases (same DSL, lenient reading -- not a second DSL):
 *   type "number" is read as "constant" (task brief uses number/constant
 *     interchangeably, the schema stores "constant");
 *   price operand `price: "close"` is read as `field: "close"`;
 *   indicator operand `indicator: { name, timeframe, output, settings }`
 *     is merged underneath top-level keys (task brief nests it, the schema
 *     stores it flat).
 *
 * Evaluation context shape (exchange-agnostic, backtest/live reusable):
 *   {
 *     candles: [...]                    // single-series shorthand
 *     candlesByTimeframe: {             // multi-timeframe series map
 *       "15m": [...], "1h": [...]
 *     },
 *     defaultTimeframe: "15m",          // fallback when operand omits it
 *     index: 42,                        // bar to evaluate (default: last)
 *     indexByTimeframe: { "15m": 42 },  // per-timeframe aligned indexes
 *     timestamp, market,                // informational, passed through
 *     cache                             // indicator series cache (opaque,
 *                                       // see createIndicatorCache)
 *   }
 *
 * Candles are chronological OHLCV objects (oldest -> newest), the same
 * contract consumed by `indicators/*.js`.
 *
 * --------------------------------------------------------------------------
 * Multi-timeframe boundary (explicit, not approximated):
 * Each operand is resolved inside its OWN timeframe series at
 * (series evaluation index - barOffset). The engine does NOT resample,
 * forward-fill, or fabricate alignment between timeframes: when operands
 * use different timeframes, the caller (market-data layer / backtester)
 * supplies per-timeframe aligned bar indexes via `indexByTimeframe`.
 * Without it, each series evaluates at its own last (or `index`) bar.
 * --------------------------------------------------------------------------
 *
 * Missing data (warmup nulls, out-of-range previous bar, non-finite OHLC
 * field) resolves to `null` so conditions evaluate to `false` instead of
 * signalling. Invalid configuration (unknown indicator/output, bad
 * comparator-adjacent values, missing series, unsupported timeframe)
 * throws explicit errors.
 */

import { getIndicator } from "../../indicators/indicatorRegistry.js";

/** Mirrors operandSchema.type. */
export const OPERAND_TYPES = Object.freeze(["price", "indicator", "constant"]);

/** Mirrors operandSchema.field. */
export const PRICE_FIELDS = Object.freeze(["open", "high", "low", "close"]);

/** Mirrors TIMEFRAMES in models/strategy.model.js (kept local so the core
 * evaluation path never imports a Mongoose model / database module). */
export const TIMEFRAMES = Object.freeze([
    "1m",
    "5m",
    "15m",
    "30m",
    "1h",
    "4h",
    "1D"
]);

/**
 * Create an indicator series cache for one evaluation scope.
 * Scope one cache per (market, timestamp) evaluation step and share it
 * across every condition of that step so repeated operands
 * (e.g. EMA20 in three conditions) are calculated once.
 *
 * The cache is keyed by candle-array reference first, so different markets
 * or series can never collide, then by indicator name + timeframe +
 * settings. Calculated runtime series are never written to MongoDB.
 *
 * @returns {{ seriesByCandles: WeakMap }}
 */
export function createIndicatorCache() {
    return { seriesByCandles: new WeakMap() };
}

/**
 * Ensure the evaluation context carries a usable indicator cache,
 * creating and attaching one when absent.
 *
 * @param {object} context Evaluation context (mutated only to attach cache).
 * @returns {{ seriesByCandles: WeakMap }}
 * @throws When context.cache exists but is not a valid indicator cache.
 */
export function ensureIndicatorCache(context) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
        throw new Error("Invalid evaluation context: expected an object.");
    }

    if (context.cache === undefined || context.cache === null) {
        context.cache = createIndicatorCache();
        return context.cache;
    }

    if (
        typeof context.cache === "object" &&
        context.cache.seriesByCandles instanceof WeakMap
    ) {
        return context.cache;
    }

    throw new Error(
        "Invalid evaluation context cache: expected a store created by " +
            "createIndicatorCache()."
    );
}

/**
 * Deterministic serialization for cache keys (object keys sorted
 * recursively). Only JSON-like settings are supported.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws When the value is not JSON-serializable.
 */
function stableStringify(value) {
    if (value === null) {
        return "null";
    }

    const valueType = typeof value;

    if (valueType === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(
                "Invalid indicator settings: values must be finite numbers."
            );
        }
        return String(value);
    }

    if (valueType === "string") {
        return JSON.stringify(value);
    }

    if (valueType === "boolean") {
        return value ? "true" : "false";
    }

    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }

    if (valueType === "object") {
        const keys = Object.keys(value)
            .filter(key => value[key] !== undefined)
            .sort();
        return `{${keys
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(",")}}`;
    }

    throw new Error(
        "Invalid indicator settings: settings must be JSON-serializable."
    );
}

/**
 * Build the cache key for an indicator configuration. Accounts for, at
 * minimum: indicator name, timeframe, output, and settings.
 *
 * @param {string} normalizedName Uppercase indicator name.
 * @param {string} timeframeKey Resolved timeframe (or "default").
 * @param {unknown} settings Raw operand settings.
 * @returns {string}
 */
export function buildIndicatorCacheKey(normalizedName, timeframeKey, settings) {
    const settingsKey =
        settings === undefined || settings === null
            ? "{}"
            : stableStringify(settings);
    return `${normalizedName}|${timeframeKey}|${settingsKey}`;
}

/**
 * Normalize a user-supplied operand into its canonical flat shape.
 * Never mutates the input.
 *
 * @param {unknown} operand
 * @returns {{ type, field, name, timeframe, output, settings, value }}
 * @throws When the operand is not an object or its type is invalid.
 */
function normalizeOperand(operand) {
    if (!operand || typeof operand !== "object" || Array.isArray(operand)) {
        throw new Error("Invalid operand: expected an object.");
    }

    if (typeof operand.type !== "string") {
        throw new Error(
            `Invalid operand type: ${operand.type}. ` +
                `Expected one of: ${OPERAND_TYPES.join(", ")}.`
        );
    }

    // Alias: the task brief uses "number", the schema stores "constant".
    const type = operand.type === "number" ? "constant" : operand.type;

    if (!OPERAND_TYPES.includes(type)) {
        throw new Error(
            `Invalid operand type: ${operand.type}. ` +
                `Expected one of: ${OPERAND_TYPES.join(", ")}.`
        );
    }

    // Alias: the task brief nests indicator config under `indicator`,
    // the schema stores it flat. Flat keys win when both are present.
    const nested =
        operand.indicator && typeof operand.indicator === "object"
            ? operand.indicator
            : {};

    return {
        type,
        // Alias: `price: "close"` reads as `field: "close"`.
        field: operand.field !== undefined ? operand.field : operand.price,
        name: operand.name !== undefined ? operand.name : nested.name,
        timeframe:
            operand.timeframe !== undefined
                ? operand.timeframe
                : nested.timeframe,
        output:
            operand.output !== undefined ? operand.output : nested.output,
        settings:
            operand.settings !== undefined
                ? operand.settings
                : nested.settings,
        value: operand.value
    };
}

/**
 * Select the candle series for an operand timeframe.
 *
 * @param {string|undefined|null} timeframe Operand timeframe (may be absent).
 * @param {object} context Evaluation context.
 * @returns {{ candles: object[], timeframeKey: string }}
 * @throws When the timeframe is unsupported or no series is available.
 */
export function getCandlesForTimeframe(timeframe, context) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
        throw new Error("Invalid evaluation context: expected an object.");
    }

    if (timeframe !== undefined && timeframe !== null) {
        if (typeof timeframe !== "string" || !TIMEFRAMES.includes(timeframe)) {
            throw new Error(
                `Unsupported timeframe: ${timeframe}. ` +
                    `Expected one of: ${TIMEFRAMES.join(", ")}.`
            );
        }

        if (
            context.candlesByTimeframe !== undefined &&
            context.candlesByTimeframe !== null
        ) {
            const series = context.candlesByTimeframe[timeframe];

            if (series === undefined) {
                throw new Error(
                    `Missing candle series for timeframe "${timeframe}". ` +
                        "Provide it via context.candlesByTimeframe."
                );
            }

            if (!Array.isArray(series)) {
                throw new Error(
                    `Invalid candle series for timeframe "${timeframe}": ` +
                        "expected an array."
                );
            }

            return { candles: series, timeframeKey: timeframe };
        }

        if (
            Array.isArray(context.candles) &&
            (context.defaultTimeframe === undefined ||
                context.defaultTimeframe === null ||
                context.defaultTimeframe === timeframe)
        ) {
            return { candles: context.candles, timeframeKey: timeframe };
        }

        throw new Error(
            `Missing candle series for timeframe "${timeframe}". ` +
                "Provide it via context.candlesByTimeframe."
        );
    }

    if (Array.isArray(context.candles)) {
        return {
            candles: context.candles,
            timeframeKey: context.defaultTimeframe ?? "default"
        };
    }

    if (
        context.candlesByTimeframe !== undefined &&
        context.candlesByTimeframe !== null &&
        typeof context.candlesByTimeframe === "object"
    ) {
        const keys = Object.keys(context.candlesByTimeframe);

        if (
            keys.length === 1 &&
            Array.isArray(context.candlesByTimeframe[keys[0]])
        ) {
            return {
                candles: context.candlesByTimeframe[keys[0]],
                timeframeKey: keys[0]
            };
        }

        if (
            typeof context.defaultTimeframe === "string" &&
            Array.isArray(context.candlesByTimeframe[context.defaultTimeframe])
        ) {
            return {
                candles:
                    context.candlesByTimeframe[context.defaultTimeframe],
                timeframeKey: context.defaultTimeframe
            };
        }
    }

    throw new Error(
        "Operand is missing timeframe and the evaluation context does not " +
            "define a usable default. Provide operand.timeframe, " +
            "context.candles, or context.defaultTimeframe."
    );
}

/**
 * Resolve the array index to read for a given bar offset.
 * offset 0 = current bar, 1 = previous bar (crossover support).
 *
 * @param {object[]} candles Chronological series (oldest -> newest).
 * @param {string} timeframeKey Resolved timeframe key.
 * @param {object} context Evaluation context.
 * @param {number} barOffset Non-negative integer.
 * @returns {number} May be negative when history is insufficient; callers
 *   treat negative indexes as missing data (`null`), never as an error.
 * @throws When the base evaluation index itself is invalid/out of range.
 */
export function resolveEvaluationIndex(
    candles,
    timeframeKey,
    context,
    barOffset
) {
    if (!Number.isInteger(barOffset) || barOffset < 0) {
        throw new Error(
            `Invalid barOffset: ${barOffset}. Expected a non-negative integer.`
        );
    }

    let base = candles.length - 1;

    const perTimeframe =
        context.indexByTimeframe !== undefined &&
        context.indexByTimeframe !== null
            ? context.indexByTimeframe[timeframeKey]
            : undefined;

    if (perTimeframe !== undefined) {
        base = perTimeframe;
    } else if (context.index !== undefined && context.index !== null) {
        base = context.index;
    }

    if (!Number.isInteger(base) || base < 0 || base >= candles.length) {
        throw new Error(
            `Evaluation index ${base} is out of range for timeframe ` +
                `"${timeframeKey}" (series length ${candles.length}).`
        );
    }

    return base - barOffset;
}

/**
 * Fetch (or calculate and cache) the full output series object for an
 * indicator configuration. The complete `calculate()` result is cached so
 * every declared output stays consistent; the caller selects `output`.
 *
 * @returns {object} e.g. `{ value: [...] }` or `{ line, signal, histogram }`.
 * @throws Propagates unknown-indicator and invalid-settings errors.
 */
function getIndicatorSeries(
    indicatorEntry,
    normalizedName,
    settings,
    timeframeKey,
    candles,
    context
) {
    const cache = ensureIndicatorCache(context);

    let perSeries = cache.seriesByCandles.get(candles);

    if (!perSeries) {
        perSeries = new Map();
        cache.seriesByCandles.set(candles, perSeries);
    }

    const key = buildIndicatorCacheKey(normalizedName, timeframeKey, settings);

    if (!perSeries.has(key)) {
        // Never duplicates indicator math: delegates to the existing
        // indicator implementation, which also validates `settings`.
        perSeries.set(key, indicatorEntry.calculate(candles, settings));
    }

    return perSeries.get(key);
}

function isMissingSeriesValue(value) {
    return (
        value === null ||
        value === undefined ||
        (typeof value === "number" && !Number.isFinite(value))
    );
}

/**
 * Resolve one operand to its runtime value at
 * (evaluation index - barOffset).
 *
 * @param {object} operand Canonical (or alias-tolerant) operand.
 * @param {object} context Evaluation context.
 * @param {number} [barOffset=0] 0 = current bar, 1 = previous bar.
 * @returns {number|string|null} `null` means "value unavailable"
 *   (insufficient history / data gap) and must make conditions `false`.
 * @throws On invalid configuration: unknown operand/indicator/output,
 *   missing price field, unsupported timeframe, missing series, invalid
 *   constant or settings.
 */
export function resolveOperandValue(operand, context, barOffset = 0) {
    const normalized = normalizeOperand(operand);

    if (normalized.type === "constant") {
        if (
            typeof normalized.value !== "number" ||
            !Number.isFinite(normalized.value)
        ) {
            throw new Error(
                `Invalid constant operand value: ${normalized.value}. ` +
                    "Expected a finite number."
            );
        }

        return normalized.value;
    }

    if (normalized.type === "price") {
        if (
            typeof normalized.field !== "string" ||
            !PRICE_FIELDS.includes(normalized.field)
        ) {
            throw new Error(
                `Invalid price operand field: ${normalized.field}. ` +
                    `Expected one of: ${PRICE_FIELDS.join(", ")}.`
            );
        }

        const { candles, timeframeKey } = getCandlesForTimeframe(
            normalized.timeframe,
            context
        );
        const index = resolveEvaluationIndex(
            candles,
            timeframeKey,
            context,
            barOffset
        );

        if (index < 0) {
            return null;
        }

        const candle = candles[index];
        const fieldValue =
            candle && typeof candle === "object" ? candle[normalized.field] : undefined;

        if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
            return null;
        }

        return fieldValue;
    }

    // Indicator operand: name/output/settings per the operand schema;
    // calculation delegated to the existing indicator layer.
    if (typeof normalized.name !== "string" || normalized.name.trim() === "") {
        throw new Error(
            `Invalid indicator operand: missing indicator name.`
        );
    }

    // Case-insensitive lookup; unknown names throw inside getIndicator.
    const indicatorEntry = getIndicator(normalized.name);
    const normalizedName = normalized.name.trim().toUpperCase();

    if (
        typeof normalized.output !== "string" ||
        !indicatorEntry.outputs.includes(normalized.output)
    ) {
        throw new Error(
            `Unknown output "${normalized.output}" for indicator ` +
                `"${normalizedName}". ` +
                `Supported outputs: ${indicatorEntry.outputs.join(", ")}.`
        );
    }

    const { candles, timeframeKey } = getCandlesForTimeframe(
        normalized.timeframe,
        context
    );
    const index = resolveEvaluationIndex(
        candles,
        timeframeKey,
        context,
        barOffset
    );

    if (index < 0) {
        return null;
    }

    const series = getIndicatorSeries(
        indicatorEntry,
        normalizedName,
        normalized.settings,
        timeframeKey,
        candles,
        context
    );
    const outputSeries = series[normalized.output];

    if (!Array.isArray(outputSeries)) {
        throw new Error(
            `Indicator "${normalizedName}" did not produce output ` +
                `"${normalized.output}".`
        );
    }

    const value = outputSeries[index];

    if (isMissingSeriesValue(value)) {
        return null;
    }

    return value;
}

export default {
    OPERAND_TYPES,
    PRICE_FIELDS,
    TIMEFRAMES,
    createIndicatorCache,
    ensureIndicatorCache,
    buildIndicatorCacheKey,
    getCandlesForTimeframe,
    resolveEvaluationIndex,
    resolveOperandValue
};
