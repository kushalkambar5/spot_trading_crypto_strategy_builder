/**
 * Stop-loss calculator for long spot positions.
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic.
 *
 * Supported modes (strategy schema stores PERCENTAGE/POINTS; FIXED_PRICE
 * and ATR are accepted leniently -- persisting them requires extending the
 * `stopLossSchema` enum in models/strategy.model.js):
 *   PERCENTAGE  -> stop = entry * (1 - value / 100)
 *   POINTS      -> stop = entry - value (absolute price distance)
 *   FIXED_PRICE -> stop = value (absolute price, must sit below entry)
 *   ATR         -> stop = entry - atrValue * multiplier
 *
 * ATR note: this module never calculates ATR. The project has no standalone
 * ATR indicator (ATR math currently lives inside the Supertrend
 * implementation), so the caller supplies the current ATR value via
 * `atrValue` (aliases: `atr`, `indicators.atr`). This keeps indicator math
 * in the indicator layer and the risk layer purely arithmetic.
 *
 * Spot V1 is long-only: a stop at or above the entry price is a
 * configuration error, never silently accepted.
 */

import {
    assertFiniteNumber,
    assertPositiveFiniteNumber
} from "./riskUtils.js";

export const STOP_LOSS_TYPES = Object.freeze([
    "PERCENTAGE",
    "POINTS",
    "FIXED_PRICE",
    "ATR"
]);

const STOP_LOSS_ALIASES = Object.freeze({
    PERCENTAGE: ["PERCENTAGE", "PERCENT", "PERCENTAGE_STOP"],
    POINTS: ["POINTS", "POINT", "ABSOLUTE_DISTANCE", "PRICE_DISTANCE"],
    FIXED_PRICE: ["FIXED_PRICE", "FIXED", "PRICE", "ABSOLUTE_PRICE", "ABSOLUTE"],
    ATR: ["ATR", "ATR_BASED", "ATR_STOP"]
});

/**
 * @param {unknown} type
 * @returns {string} Canonical stop-loss type.
 * @throws On unknown types.
 */
export function normalizeStopLossType(type) {
    if (typeof type !== "string") {
        throw new Error(
            `Invalid stop-loss type: ${type}. ` +
                `Expected one of: ${STOP_LOSS_TYPES.join(", ")}.`
        );
    }

    const key = type.trim().toUpperCase();

    for (const [canonical, aliases] of Object.entries(STOP_LOSS_ALIASES)) {
        if (aliases.includes(key)) {
            return canonical;
        }
    }

    throw new Error(
        `Invalid stop-loss type: ${type}. ` +
            `Expected one of: ${STOP_LOSS_TYPES.join(", ")}.`
    );
}

/**
 * Read the ATR value from a runtime parameter bag, accepting the
 * documented aliases. Returns null when absent (caller decides whether
 * that is an error -- only ATR-mode stop loss requires it).
 *
 * @param {object|undefined|null} params
 * @returns {number|null}
 */
export function readAtrValue(params) {
    if (params === undefined || params === null) {
        return null;
    }

    const direct =
        params.atrValue !== undefined && params.atrValue !== null
            ? params.atrValue
            : params.atr !== undefined && params.atr !== null
              ? params.atr
              : params.indicators &&
                  typeof params.indicators === "object" &&
                  params.indicators.atr !== undefined &&
                  params.indicators.atr !== null
                ? params.indicators.atr
                : null;

    if (direct === null) {
        return null;
    }

    assertPositiveFiniteNumber(direct, "ATR value");

    return direct;
}

/**
 * Validate a strategy stopLoss block.
 *
 * @param {object|undefined|null} stopLoss Strategy `exit.stopLoss` object.
 * @returns {{ enabled: boolean, type: string|null, value: number|null,
 *   settings: object|null }}
 * @throws On invalid configuration.
 */
export function validateStopLossConfig(stopLoss) {
    if (stopLoss === undefined || stopLoss === null) {
        return { enabled: false, type: null, value: null, settings: null };
    }

    if (typeof stopLoss !== "object" || Array.isArray(stopLoss)) {
        throw new Error("Invalid stop-loss configuration: expected an object.");
    }

    if (!stopLoss.enabled) {
        return { enabled: false, type: null, value: null, settings: null };
    }

    const type = normalizeStopLossType(stopLoss.type);

    assertFiniteNumber(stopLoss.value, "Stop-loss value");

    if (!(stopLoss.value > 0)) {
        throw new Error(
            `Invalid stop-loss value: ${stopLoss.value}. ` +
                "Expected a number greater than 0."
        );
    }

    if (type === "PERCENTAGE" && stopLoss.value >= 100) {
        throw new Error(
            `Invalid stop-loss value: ${stopLoss.value}. ` +
                "Percentage stop loss must be below 100."
        );
    }

    let settings = null;

    if (type === "ATR") {
        const raw = stopLoss.settings;

        if (raw !== undefined && raw !== null) {
            if (typeof raw !== "object" || Array.isArray(raw)) {
                throw new Error(
                    "Invalid stop-loss settings: expected an object."
                );
            }

            settings = { ...raw };
        }
    }

    return { enabled: true, type, value: stopLoss.value, settings };
}

/**
 * Calculate the absolute stop-loss price for a long spot position.
 *
 * @param {object} params
 * @param {number} params.entryPrice Entry price (> 0).
 * @param {object} params.stopLoss Strategy `exit.stopLoss` object.
 * @param {number} [params.atrValue] Required for ATR mode; also read from
 *   `params.atr` / `params.indicators.atr`.
 * @param {number} [params.atr] Alias for atrValue.
 * @param {object} [params.indicators] May carry `{ atr }`.
 * @param {string} [params.side="LONG"] Only "LONG" is supported in spot V1.
 * @returns {{ enabled: boolean, price: number|null, type: string|null }}
 * @throws On invalid configuration or a stop on the wrong side of entry.
 */
export function calculateStopLoss({
    entryPrice,
    stopLoss,
    atrValue,
    atr,
    indicators,
    side = "LONG"
}) {
    assertPositiveFiniteNumber(entryPrice, "Entry price");

    if (side !== "LONG") {
        throw new Error(
            `Unsupported position side for stop loss: ${side}. ` +
                'Spot V1 supports "LONG" only.'
        );
    }

    const config = validateStopLossConfig(stopLoss);

    if (!config.enabled) {
        return { enabled: false, price: null, type: null };
    }

    let price;

    switch (config.type) {
        case "PERCENTAGE":
            price = entryPrice * (1 - config.value / 100);
            break;

        case "POINTS":
            price = entryPrice - config.value;
            break;

        case "FIXED_PRICE":
            price = config.value;
            break;

        case "ATR": {
            const resolved =
                atrValue !== undefined && atrValue !== null
                    ? atrValue
                    : readAtrValue({ atrValue, atr, indicators });

            if (resolved === null) {
                throw new Error(
                    "Missing ATR value: ATR stop loss requires " +
                        "context.atrValue (current ATR from the indicator layer)."
                );
            }

            price = entryPrice - resolved * config.value;
            break;
        }

        /* istanbul ignore next: guarded by normalizeStopLossType */
        default:
            throw new Error(`Invalid stop-loss type: ${config.type}.`);
    }

    assertFiniteNumber(price, "Stop-loss price");

    if (!(price > 0)) {
        throw new Error(
            "Invalid stop-loss configuration: calculated stop price " +
                `(${price}) must be greater than 0.`
        );
    }

    if (!(price < entryPrice)) {
        throw new Error(
            "Invalid stop-loss configuration: stop price " +
                `(${price}) must be below the entry price ` +
                `(${entryPrice}) for a long position.`
        );
    }

    return { enabled: true, price, type: config.type };
}

/**
 * Long spot stop-loss trigger: price at or below the stop level.
 *
 * @param {number} currentPrice
 * @param {number} stopLossPrice
 * @returns {boolean}
 */
export function isStopLossHit(currentPrice, stopLossPrice) {
    if (
        typeof currentPrice !== "number" ||
        !Number.isFinite(currentPrice) ||
        typeof stopLossPrice !== "number" ||
        !Number.isFinite(stopLossPrice)
    ) {
        return false;
    }

    return currentPrice <= stopLossPrice;
}

export default {
    STOP_LOSS_TYPES,
    normalizeStopLossType,
    readAtrValue,
    validateStopLossConfig,
    calculateStopLoss,
    isStopLossHit
};
