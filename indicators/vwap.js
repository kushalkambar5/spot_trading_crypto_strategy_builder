/**
 * VWAP (Volume-Weighted Average Price), session-anchored.
 *
 * Pure calculation module: no database, network, exchange, strategy,
 * order, backtest, or frontend logic.
 *
 * Settings: { source: "hlc3", anchor: "session" }
 * Output:   { value: [...] } aligned with the input candles.
 *
 * Formula per session:
 *   VWAP = SUM(source * volume) / SUM(volume)
 *
 * Crypto trades 24/7, so the V1 session boundary is the deterministic
 * UTC calendar day (00:00 UTC). Cumulative sums reset whenever
 * candle.timestamp crosses into a new UTC day. Zero cumulative volume
 * yields null (never divides by zero, never NaN).
 */

import { getSourceValue } from "./utils/source.js";
import {
    validateSource,
    validateCandles,
    applyDefaults
} from "./utils/validation.js";

export const name = "VWAP";
export const outputs = ["value"];
export const defaultSettings = Object.freeze({
    source: "hlc3",
    anchor: "session"
});

// Timestamps below 1e12 are treated as seconds (crypto feeds usually
// send milliseconds). Documented so behaviour stays deterministic.
const SECONDS_THRESHOLD = 1e12;
const SECONDS_TO_MS = 1000;

/**
 * Derive a UTC-day key (YYYY-M-D) from a candle timestamp.
 */
function utcDayKey(timestamp, index) {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        throw new Error(`Invalid candle timestamp at index ${index}.`);
    }

    const asMs =
        Math.abs(timestamp) < SECONDS_THRESHOLD
            ? timestamp * SECONDS_TO_MS
            : timestamp;
    const date = new Date(asMs);

    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid candle timestamp at index ${index}.`);
    }

    return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

export function validateSettings(settings) {
    const resolved = applyDefaults(settings, defaultSettings);

    validateSource(resolved.source);

    if (resolved.anchor !== "session") {
        throw new Error('VWAP anchor must be "session".');
    }

    return resolved;
}

/**
 * @param {object[]} candles Chronological OHLCV candles (oldest -> newest).
 * @param {object} [settings]
 * @returns {{ value: (number|null)[] }}
 */
export function calculate(candles, settings) {
    validateCandles(candles);

    const { source } = validateSettings(settings);
    const length = candles.length;
    const value = new Array(length).fill(null);

    if (length === 0) {
        return { value };
    }

    let currentDay = null;
    let cumulativePriceVolume = 0;
    let cumulativeVolume = 0;

    for (let i = 0; i < length; i += 1) {
        const candle = candles[i];

        if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
            throw new Error(`Invalid candle at index ${i}: expected an object.`);
        }

        const day = utcDayKey(candle.timestamp, i);

        let sourceValue;
        try {
            sourceValue = getSourceValue(candle, source);
        } catch (error) {
            throw new Error(`Invalid candle at index ${i}: ${error.message}`);
        }

        const { volume } = candle;
        if (
            typeof volume !== "number" ||
            !Number.isFinite(volume) ||
            volume < 0
        ) {
            throw new Error(`Invalid candle volume at index ${i}.`);
        }

        // Reset cumulative sums at every UTC-day boundary.
        if (day !== currentDay) {
            currentDay = day;
            cumulativePriceVolume = 0;
            cumulativeVolume = 0;
        }

        cumulativePriceVolume += sourceValue * volume;
        cumulativeVolume += volume;

        // Never divide by zero: no volume yet means no VWAP.
        value[i] = cumulativeVolume === 0 ? null : cumulativePriceVolume / cumulativeVolume;
    }

    return { value };
}

export default {
    name,
    outputs,
    defaultSettings,
    validateSettings,
    calculate
};
