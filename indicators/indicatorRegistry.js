/**
 * V1 indicator registry: metadata + calculation references.
 *
 * Pure module: no database, network, exchange, strategy, order,
 * backtest, or frontend logic. It only wires the pure calculation
 * modules in this directory together.
 *
 * Each entry:
 *   { name, outputs, defaultSettings, calculate, validateSettings }
 *
 * Names resolve case-insensitively ("ema", "EMA", "Ema" all work),
 * but unknown names throw instead of silently resolving.
 */

import ema from "./ema.js";
import sma from "./sma.js";
import vwap from "./vwap.js";
import rsi from "./rsi.js";
import macd from "./macd.js";
import supertrend from "./supertrend.js";

const entries = Object.freeze({
    EMA: ema,
    SMA: sma,
    VWAP: vwap,
    RSI: rsi,
    MACD: macd,
    SUPERTREND: supertrend
});

/**
 * Normalize a user-supplied indicator name for lookup.
 */
function normalizeName(indicatorName) {
    if (typeof indicatorName !== "string") {
        throw new Error(`Unknown indicator: ${indicatorName}.`);
    }

    return indicatorName.trim().toUpperCase();
}

/**
 * @param {string} indicatorName e.g. "ema", "EMA", "Ema"
 * @returns registry entry with calculate/validateSettings references
 * @throws When the indicator is not part of V1.
 */
export function getIndicator(indicatorName) {
    const key = normalizeName(indicatorName);
    const entry = entries[key];

    if (!entry) {
        throw new Error(`Unknown indicator: ${indicatorName}.`);
    }

    return entry;
}

/**
 * @param {string} indicatorName
 * @returns {boolean} false for unknown names (never throws for strings).
 */
export function hasIndicator(indicatorName) {
    if (typeof indicatorName !== "string") {
        return false;
    }

    return Object.prototype.hasOwnProperty.call(
        entries,
        indicatorName.trim().toUpperCase()
    );
}

/**
 * @returns {string[]} Canonical V1 indicator names.
 */
export function getIndicators() {
    return Object.keys(entries);
}

export default {
    getIndicator,
    hasIndicator,
    getIndicators
};
