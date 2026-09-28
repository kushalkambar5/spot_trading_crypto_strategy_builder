/**
 * RSI (Relative Strength Index) with Wilder's smoothing.
 *
 * Pure calculation module: no database, network, exchange, strategy,
 * order, backtest, or frontend logic.
 *
 * Settings: { period: 14, source: "close" }
 * Output:   { value: [...] } in the 0-100 range, aligned with candles.
 *
 * Method:
 *   delta = source[i] - source[i-1]
 *   gain  = max(delta, 0), loss = max(-delta, 0)
 *   initial averages = mean of the first `period` gains/losses
 *   avgGain = (prevAvgGain * (period - 1) + gain) / period   (Wilder)
 *   avgLoss = (prevAvgLoss * (period - 1) + loss) / period   (Wilder)
 *   RS  = avgGain / avgLoss
 *   RSI = 100 - (100 / (1 + RS))
 *
 * Edge cases:
 *   avgLoss == 0 and avgGain > 0  -> 100
 *   avgGain == 0 and avgLoss > 0  -> 0
 *   both == 0 (flat market)       -> 50
 */

import { getSourceValue } from "./utils/source.js";
import {
    validatePositiveInteger,
    validateSource,
    validateCandles,
    applyDefaults
} from "./utils/validation.js";

export const name = "RSI";
export const outputs = ["value"];
export const defaultSettings = Object.freeze({ period: 14, source: "close" });

export function validateSettings(settings) {
    const resolved = applyDefaults(settings, defaultSettings);

    validatePositiveInteger(resolved.period, "RSI period");
    validateSource(resolved.source);

    return resolved;
}

function rsiFromAverages(avgGain, avgLoss) {
    if (avgLoss === 0) {
        if (avgGain > 0) {
            return 100;
        }
        // Flat market: no gains and no losses.
        return 50;
    }

    if (avgGain === 0) {
        return 0;
    }

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
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

    // First RSI needs `period` price changes, i.e. period + 1 candles.
    if (length <= period) {
        return { value };
    }

    // Initial average gain/loss over the first `period` changes
    // (candles 1..period vs their predecessors).
    let gainSum = 0;
    let lossSum = 0;

    for (let i = 1; i <= period; i += 1) {
        const delta = sources[i] - sources[i - 1];
        gainSum += Math.max(delta, 0);
        lossSum += Math.max(-delta, 0);
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;

    value[period] = rsiFromAverages(avgGain, avgLoss);

    // Wilder smoothing for the remaining bars.
    for (let i = period + 1; i < length; i += 1) {
        const delta = sources[i] - sources[i - 1];
        const gain = Math.max(delta, 0);
        const loss = Math.max(-delta, 0);

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        value[i] = rsiFromAverages(avgGain, avgLoss);
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
