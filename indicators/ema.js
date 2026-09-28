/**
 * EMA (Exponential Moving Average).
 *
 * Pure calculation module: no database, network, exchange, strategy,
 * order, backtest, or frontend logic.
 *
 * Settings: { period: 20, source: "close" }
 * Output:   { value: [...] } aligned with the input candles.
 *
 * Method:
 *   multiplier = 2 / (period + 1)
 *   initial EMA = SMA of the first `period` source values
 *   EMA_today = (value_today - EMA_prev) * multiplier + EMA_prev
 *
 * Positions without enough history are null (never dropped, never NaN).
 */

import { getSourceValue } from "./utils/source.js";
import {
    validatePositiveInteger,
    validateSource,
    validateCandles,
    applyDefaults
} from "./utils/validation.js";

export const name = "EMA";
export const outputs = ["value"];
export const defaultSettings = Object.freeze({ period: 20, source: "close" });

export function validateSettings(settings) {
    const resolved = applyDefaults(settings, defaultSettings);

    validatePositiveInteger(resolved.period, "EMA period");
    validateSource(resolved.source);

    return resolved;
}

/**
 * EMA over a plain array of finite numbers (no nulls expected).
 * Shared by indicators that smooth derived series (e.g. MACD signal).
 *
 * @param {number[]} values
 * @param {number} period positive integer
 * @returns {(number|null)[]} Same length as input, null until seeded.
 */
export function emaValues(values, period) {
    validatePositiveInteger(period, "EMA period");

    const length = values.length;
    const result = new Array(length).fill(null);

    if (length < period) {
        return result;
    }

    let sum = 0;
    for (let i = 0; i < period; i += 1) {
        sum += values[i];
    }

    // Seed with the SMA of the first `period` values.
    result[period - 1] = sum / period;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < length; i += 1) {
        result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1];
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

    // Extract source values first so invalid OHLC fails fast with context.
    // Never mutates the input candles.
    const sources = candles.map((candle, index) => {
        try {
            return getSourceValue(candle, source);
        } catch (error) {
            throw new Error(`Invalid candle at index ${index}: ${error.message}`);
        }
    });

    const ema = emaValues(sources, period);

    for (let i = 0; i < length; i += 1) {
        value[i] = ema[i];
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
