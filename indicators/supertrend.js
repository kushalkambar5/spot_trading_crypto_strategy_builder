/**
 * Supertrend.
 *
 * Pure calculation module: no database, network, exchange, strategy,
 * order, backtest, or frontend logic.
 *
 * Settings: { period: 10, multiplier: 3 }
 * Output:   { value: [...], direction: [...] } aligned with candles,
 *           direction entries are "bullish" | "bearish" (null until ready).
 *
 * Method:
 *   1. True Range: max(high-low, |high-prevClose|, |low-prevClose|)
 *   2. ATR via Wilder's smoothing (SMA of first `period` TRs, then
 *      ATR = (prevATR * (period-1) + TR) / period)
 *   3. Basic bands: median +/- multiplier * ATR, median = (high+low)/2
 *   4. Final bands carry forward unless price or the basic band breaks them:
 *      finalUpper = basicUpper if basicUpper < prevFinalUpper
 *                   or prevClose > prevFinalUpper, else prevFinalUpper
 *      finalLower = basicLower if basicLower > prevFinalLower
 *                   or prevClose < prevFinalLower, else prevFinalLower
 *   5. Trend flips on closes beyond the opposite final band; the
 *      Supertrend value is the final band of the active side.
 *
 * Internal TR/ATR/bands are not exposed as strategy outputs in V1.
 */

import {
    validatePositiveInteger,
    validatePositiveNumber,
    validateCandles,
    applyDefaults
} from "./utils/validation.js";

export const name = "SUPERTREND";
export const outputs = ["value", "direction"];
export const defaultSettings = Object.freeze({ period: 10, multiplier: 3 });

export const DIRECTION_BULLISH = "bullish";
export const DIRECTION_BEARISH = "bearish";

function assertOhlc(candle, index) {
    if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
        throw new Error(`Invalid candle at index ${index}: expected an object.`);
    }

    const { high, low, close } = candle;

    for (const [field, fieldValue] of [
        ["high", high],
        ["low", low],
        ["close", close]
    ]) {
        if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
            throw new Error(
                `Invalid candle at index ${index}: ${field} must be a finite number.`
            );
        }
    }

    if (high < low) {
        throw new Error(
            `Invalid candle at index ${index}: high must be >= low.`
        );
    }

    return { high, low, close };
}

export function validateSettings(settings) {
    // Accept `atrPeriod` as a compatibility alias for `period` because the
    // existing config registry (config/indicatorRegistry.js) uses that key.
    // Canonical output settings always use `period`.
    const input =
        settings === undefined || settings === null ? {} : settings;

    if (typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Settings must be an object.");
    }

    const normalized = {
        ...input,
        period: input.period !== undefined ? input.period : input.atrPeriod
    };
    const resolved = applyDefaults(normalized, defaultSettings);

    validatePositiveInteger(resolved.period, "Supertrend period");
    validatePositiveNumber(resolved.multiplier, "Supertrend multiplier");

    return { period: resolved.period, multiplier: resolved.multiplier };
}

/**
 * @param {object[]} candles Chronological OHLCV candles (oldest -> newest).
 * @param {object} [settings]
 * @returns {{ value: (number|null)[], direction: (string|null)[] }}
 */
export function calculate(candles, settings) {
    validateCandles(candles);

    const { period, multiplier } = validateSettings(settings);
    const length = candles.length;
    const value = new Array(length).fill(null);
    const direction = new Array(length).fill(null);

    if (length === 0) {
        return { value, direction };
    }

    // Never mutates the input candles.
    const highs = new Array(length);
    const lows = new Array(length);
    const closes = new Array(length);

    for (let i = 0; i < length; i += 1) {
        const { high, low, close } = assertOhlc(candles[i], i);
        highs[i] = high;
        lows[i] = low;
        closes[i] = close;
    }

    if (length < period) {
        return { value, direction };
    }

    // 1. True Range.
    const trueRanges = new Array(length);
    for (let i = 0; i < length; i += 1) {
        if (i === 0) {
            trueRanges[i] = highs[i] - lows[i];
        } else {
            trueRanges[i] = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
        }
    }

    // 2. ATR with Wilder's smoothing, seeded by the SMA of the first TRs.
    const atr = new Array(length).fill(null);
    if (period === 1) {
        for (let i = 0; i < length; i += 1) {
            atr[i] = trueRanges[i];
        }
    } else {
        let seedSum = 0;
        for (let i = 0; i < period; i += 1) {
            seedSum += trueRanges[i];
        }
        atr[period - 1] = seedSum / period;

        for (let i = period; i < length; i += 1) {
            atr[i] = (atr[i - 1] * (period - 1) + trueRanges[i]) / period;
        }
    }

    // 3-4. Basic and final bands (only defined once ATR exists).
    const firstValid = period - 1;
    const finalUpper = new Array(length).fill(null);
    const finalLower = new Array(length).fill(null);

    for (let i = firstValid; i < length; i += 1) {
        const median = (highs[i] + lows[i]) / 2;
        const basicUpper = median + multiplier * atr[i];
        const basicLower = median - multiplier * atr[i];

        if (i === firstValid) {
            finalUpper[i] = basicUpper;
            finalLower[i] = basicLower;
        } else {
            finalUpper[i] =
                basicUpper < finalUpper[i - 1] ||
                closes[i - 1] > finalUpper[i - 1]
                    ? basicUpper
                    : finalUpper[i - 1];
            finalLower[i] =
                basicLower > finalLower[i - 1] ||
                closes[i - 1] < finalLower[i - 1]
                    ? basicLower
                    : finalLower[i - 1];
        }
    }

    // 5. Trend state and Supertrend value selection.
    for (let i = firstValid; i < length; i += 1) {
        if (i === firstValid) {
            direction[i] =
                closes[i] > finalUpper[i]
                    ? DIRECTION_BULLISH
                    : DIRECTION_BEARISH;
        } else if (direction[i - 1] === DIRECTION_BEARISH) {
            direction[i] =
                closes[i] > finalUpper[i - 1]
                    ? DIRECTION_BULLISH
                    : DIRECTION_BEARISH;
        } else {
            direction[i] =
                closes[i] < finalLower[i - 1]
                    ? DIRECTION_BEARISH
                    : DIRECTION_BULLISH;
        }

        value[i] =
            direction[i] === DIRECTION_BULLISH
                ? finalLower[i]
                : finalUpper[i];
    }

    return { value, direction };
}

export default {
    name,
    outputs,
    defaultSettings,
    validateSettings,
    calculate
};
