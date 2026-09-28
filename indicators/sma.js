/**
 * SMA (Simple Moving Average).
 *
 * Pure calculation module: no database, network, exchange, strategy,
 * order, backtest, or frontend logic.
 *
 * Settings: { period: 20, source: "close" }
 * Output:   { value: [...] } aligned with the input candles.
 *
 * Uses an efficient rolling-sum window instead of re-summing every bar.
 * Positions without enough history are null (never dropped, never NaN).
 */

import { getSourceValue } from "./utils/source.js";
import {
    validatePositiveInteger,
    validateSource,
    validateCandles,
    applyDefaults
} from "./utils/validation.js";

export const name = "SMA";
export const outputs = ["value"];
export const defaultSettings = Object.freeze({ period: 20, source: "close" });

export function validateSettings(settings) {
    const resolved = applyDefaults(settings, defaultSettings);

    validatePositiveInteger(resolved.period, "SMA period");
    validateSource(resolved.source);

    return resolved;
}

/**
 * SMA over a plain array of finite numbers via a rolling sum.
 *
 * @param {number[]} values
 * @param {number} period positive integer
 * @returns {(number|null)[]} Same length as input, null until the window fills.
 */
export function smaValues(values, period) {
    validatePositiveInteger(period, "SMA period");

    const length = values.length;
    const result = new Array(length).fill(null);

    if (length < period) {
        return result;
    }

    let windowSum = 0;

    for (let i = 0; i < length; i += 1) {
        windowSum += values[i];

        if (i >= period) {
            windowSum -= values[i - period];
        }

        if (i >= period - 1) {
            result[i] = windowSum / period;
        }
    }

    return result;
}

/**
 * @param {object[]} candles Chronological OHLCV candles (oldest -> newest).
 * @param {object} [settings]
 * @returns {{ value: (number|null)[] }}
 */
export function calculate(candles, settings) {
    validateCandles(candles);

    const { period, source } = validateSettings(settings);
    const length = candles.length;
    const value = new Array(length).fill(null);

    if (length === 0) {
        return { value };
    }

    // Never mutates the input candles.
    const sources = candles.map((candle, index) => {
        try {
            return getSourceValue(candle, source);
        } catch (error) {
            throw new Error(`Invalid candle at index ${index}: ${error.message}`);
        }
    });

    const sma = smaValues(sources, period);

    for (let i = 0; i < length; i += 1) {
        value[i] = sma[i];
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
