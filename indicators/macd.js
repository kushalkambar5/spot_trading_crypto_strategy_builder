/**
 * MACD (Moving Average Convergence Divergence).
 *
 * Pure calculation module: no database, network, exchange, strategy,
 * order, backtest, or frontend logic.
 *
 * Settings: { source: "close", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }
 * Output:   { line: [...], signal: [...], histogram: [...] },
 *           every series aligned with the input candles.
 *
 * Method:
 *   fastEMA = EMA(source, fastPeriod)      (SMA-seeded, shared helper)
 *   slowEMA = EMA(source, slowPeriod)
 *   line    = fastEMA - slowEMA
 *   signal  = EMA(line, signalPeriod)
 *   histogram = line - signal
 *
 * The condition engine later selects output "line" | "signal" | "histogram".
 */

import { getSourceValue } from "./utils/source.js";
import { emaValues } from "./ema.js";
import {
    validatePositiveInteger,
    validateSource,
    validateCandles,
    applyDefaults
} from "./utils/validation.js";

export const name = "MACD";
export const outputs = ["line", "signal", "histogram"];
export const defaultSettings = Object.freeze({
    source: "close",
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9
});

export function validateSettings(settings) {
    const resolved = applyDefaults(settings, defaultSettings);

    validateSource(resolved.source);
    validatePositiveInteger(resolved.fastPeriod, "MACD fastPeriod");
    validatePositiveInteger(resolved.slowPeriod, "MACD slowPeriod");
    validatePositiveInteger(resolved.signalPeriod, "MACD signalPeriod");

    if (resolved.fastPeriod >= resolved.slowPeriod) {
        throw new Error("MACD fastPeriod must be less than slowPeriod.");
    }

    return resolved;
}

/**
 * @param {object[]} candles Chronological OHLCV candles (oldest -> newest).
 * @param {object} [settings]
 * @returns {{ line: (number|null)[], signal: (number|null)[], histogram: (number|null)[] }}
 */
export function calculate(candles, settings) {
    validateCandles(candles);

    const { source, fastPeriod, slowPeriod, signalPeriod } =
        validateSettings(settings);
    const length = candles.length;
    const line = new Array(length).fill(null);
    const signal = new Array(length).fill(null);
    const histogram = new Array(length).fill(null);

    if (length === 0) {
        return { line, signal, histogram };
    }

    // Never mutates the input candles.
    const sources = candles.map((candle, index) => {
        try {
            return getSourceValue(candle, source);
        } catch (error) {
            throw new Error(`Invalid candle at index ${index}: ${error.message}`);
        }
    });

    // Reuse the SMA-seeded EMA helper so MACD legs match standalone EMA.
    const fastEma = emaValues(sources, fastPeriod);
    const slowEma = emaValues(sources, slowPeriod);

    for (let i = 0; i < length; i += 1) {
        if (fastEma[i] !== null && slowEma[i] !== null) {
            line[i] = fastEma[i] - slowEma[i];
        }
    }

    // Signal is the EMA of the MACD line. The line has leading nulls, so
    // compact the valid segment, smooth it, then map results back to keep
    // every series aligned with the candle array.
    const lineIndexes = [];
    const lineValues = [];

    for (let i = 0; i < length; i += 1) {
        if (line[i] !== null) {
            lineIndexes.push(i);
            lineValues.push(line[i]);
        }
    }

    const signalCompact = emaValues(lineValues, signalPeriod);

    for (let k = 0; k < signalCompact.length; k += 1) {
        if (signalCompact[k] !== null) {
            signal[lineIndexes[k]] = signalCompact[k];
        }
    }

    for (let i = 0; i < length; i += 1) {
        if (line[i] !== null && signal[i] !== null) {
            histogram[i] = line[i] - signal[i];
        }
    }

    return { line, signal, histogram };
}

export default {
    name,
    outputs,
    defaultSettings,
    validateSettings,
    calculate
};
