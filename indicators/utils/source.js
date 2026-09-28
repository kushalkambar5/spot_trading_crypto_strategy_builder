/**
 * Shared price-source selector for the indicator calculation layer.
 *
 * Pure calculation module: no database, network, exchange, strategy,
 * order, backtest, or frontend logic.
 *
 * Supported sources:
 *   open   = candle.open
 *   high   = candle.high
 *   low    = candle.low
 *   close  = candle.close
 *   hl2    = (high + low) / 2
 *   hlc3   = (high + low + close) / 3
 *   ohlc4  = (open + high + low + close) / 4
 */

export const SUPPORTED_SOURCES = Object.freeze([
    "open",
    "high",
    "low",
    "close",
    "hl2",
    "hlc3",
    "ohlc4"
]);

export const DEFAULT_SOURCE = "close";

function assertCandleField(candle, field) {
    const value = candle[field];

    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Invalid candle ${field}: expected a finite number.`);
    }

    return value;
}

/**
 * Check whether a source string is supported.
 *
 * @param {unknown} source
 * @returns {boolean}
 */
export function isSupportedSource(source) {
    return typeof source === "string" && SUPPORTED_SOURCES.includes(source);
}

/**
 * Resolve a single source value from a candle.
 *
 * Only the OHLC fields required by the requested source are validated,
 * so e.g. source "close" does not force high/low to be present.
 *
 * @param {object} candle OHLCV candle
 * @param {string} [source="close"]
 * @returns {number}
 * @throws When the candle or source is invalid.
 */
export function getSourceValue(candle, source = DEFAULT_SOURCE) {
    if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
        throw new Error("Invalid candle: expected an object.");
    }

    const resolvedSource =
        source === undefined || source === null ? DEFAULT_SOURCE : source;

    if (!isSupportedSource(resolvedSource)) {
        throw new Error(`Unsupported source: ${resolvedSource}.`);
    }

    switch (resolvedSource) {
        case "open":
            return assertCandleField(candle, "open");

        case "high":
            return assertCandleField(candle, "high");

        case "low":
            return assertCandleField(candle, "low");

        case "close":
            return assertCandleField(candle, "close");

        case "hl2": {
            const high = assertCandleField(candle, "high");
            const low = assertCandleField(candle, "low");
            return (high + low) / 2;
        }

        case "hlc3": {
            const high = assertCandleField(candle, "high");
            const low = assertCandleField(candle, "low");
            const close = assertCandleField(candle, "close");
            return (high + low + close) / 3;
        }

        case "ohlc4": {
            const open = assertCandleField(candle, "open");
            const high = assertCandleField(candle, "high");
            const low = assertCandleField(candle, "low");
            const close = assertCandleField(candle, "close");
            return (open + high + low + close) / 4;
        }

        /* istanbul ignore next: guarded by isSupportedSource above */
        default:
            throw new Error(`Unsupported source: ${resolvedSource}.`);
    }
}

export default {
    SUPPORTED_SOURCES,
    DEFAULT_SOURCE,
    isSupportedSource,
    getSourceValue
};
