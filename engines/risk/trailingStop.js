/**
 * Trailing-stop calculator for long spot positions.
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic.
 *
 * Strategy configuration (models/strategy.model.js `trailingStopSchema`):
 *   { enabled, activation: "IMMEDIATE" | "AFTER_PROFIT", activationValue,
 *     type: "PERCENTAGE" | "POINTS", value }
 * `activationValue` uses the same unit as `type` (PERCENTAGE -> percent
 * move from entry, POINTS -> absolute price distance from entry).
 *
 * Runtime position state (never stored in the strategy definition):
 *   { highestPrice, previousTrailingStop }
 * Transient trailing state lives in the position/backtest runtime, not in
 * the strategy. Note: models/position.model.js currently exposes
 * `trailingStopPrice` but no `highestPrice` field -- callers must track
 * the highest price since entry themselves and pass it in. This module
 * never mutates the Position model.
 *
 * Ratchet rule (long): the stop moves only in the favorable direction.
 *   final = max(newlyCalculated, previousTrailingStop)
 * It can never move back down.
 */

import {
    assertFiniteNumber,
    assertPositiveFiniteNumber
} from "./riskUtils.js";

export const TRAILING_STOP_TYPES = Object.freeze(["PERCENTAGE", "POINTS"]);

export const TRAILING_ACTIVATIONS = Object.freeze([
    "IMMEDIATE",
    "AFTER_PROFIT"
]);

const TRAILING_TYPE_ALIASES = Object.freeze({
    PERCENTAGE: ["PERCENTAGE", "PERCENT"],
    POINTS: ["POINTS", "POINT", "ABSOLUTE_DISTANCE", "PRICE_DISTANCE"]
});

/**
 * @param {unknown} type
 * @returns {string} Canonical trailing-stop distance type.
 * @throws On unknown types.
 */
export function normalizeTrailingStopType(type) {
    if (typeof type !== "string") {
        throw new Error(
            `Invalid trailing-stop type: ${type}. ` +
                `Expected one of: ${TRAILING_STOP_TYPES.join(", ")}.`
        );
    }

    const key = type.trim().toUpperCase();

    for (const [canonical, aliases] of Object.entries(TRAILING_TYPE_ALIASES)) {
        if (aliases.includes(key)) {
            return canonical;
        }
    }

    throw new Error(
        `Invalid trailing-stop type: ${type}. ` +
            `Expected one of: ${TRAILING_STOP_TYPES.join(", ")}.`
    );
}

/**
 * Validate a strategy trailingStop block.
 *
 * @param {object|undefined|null} trailingStop Strategy
 *   `exit.trailingStop` object.
 * @returns {{ enabled: boolean, activation: string|null,
 *   activationValue: number|null, type: string|null, value: number|null }}
 * @throws On invalid configuration.
 */
export function validateTrailingStopConfig(trailingStop) {
    if (trailingStop === undefined || trailingStop === null) {
        return {
            enabled: false,
            activation: null,
            activationValue: null,
            type: null,
            value: null
        };
    }

    if (typeof trailingStop !== "object" || Array.isArray(trailingStop)) {
        throw new Error(
            "Invalid trailing-stop configuration: expected an object."
        );
    }

    if (!trailingStop.enabled) {
        return {
            enabled: false,
            activation: null,
            activationValue: null,
            type: null,
            value: null
        };
    }

    if (!TRAILING_ACTIVATIONS.includes(trailingStop.activation)) {
        throw new Error(
            `Invalid trailing-stop activation: ${trailingStop.activation}. ` +
                'Expected "IMMEDIATE" or "AFTER_PROFIT".'
        );
    }

    const type = normalizeTrailingStopType(trailingStop.type);

    assertFiniteNumber(trailingStop.value, "Trailing-stop value");

    if (!(trailingStop.value > 0)) {
        throw new Error(
            `Invalid trailing-stop value: ${trailingStop.value}. ` +
                "Expected a number greater than 0."
        );
    }

    if (type === "PERCENTAGE" && trailingStop.value >= 100) {
        throw new Error(
            `Invalid trailing-stop value: ${trailingStop.value}. ` +
                "Percentage trailing distance must be below 100."
        );
    }

    let activationValue = null;

    if (trailingStop.activation === "AFTER_PROFIT") {
        assertFiniteNumber(
            trailingStop.activationValue,
            "Trailing-stop activation value"
        );

        if (!(trailingStop.activationValue >= 0)) {
            throw new Error(
                `Invalid trailing-stop activation value: ${trailingStop.activationValue}. ` +
                    "Expected a number greater than or equal to 0."
            );
        }

        activationValue = trailingStop.activationValue;
    }

    return {
        enabled: true,
        activation: trailingStop.activation,
        activationValue,
        type,
        value: trailingStop.value
    };
}

/**
 * Calculate the trailing stop for a long position, applying the ratchet.
 *
 * Highest-price fallback chain (conservative -- never invents a higher
 * high, mirroring the signal engine): explicit `highestPrice`, then
 * `currentPrice`, then `entryPrice`.
 *
 * @param {object} params
 * @param {number} params.entryPrice Entry price (> 0).
 * @param {number|undefined|null} [params.currentPrice] Current price.
 * @param {number|undefined|null} [params.highestPrice] Highest price seen
 *   since entry, tracked by the caller.
 * @param {number|undefined|null} [params.previousTrailingStop] Previously
 *   calculated stop; the result never moves below it.
 * @param {object} params.trailingStop Strategy `exit.trailingStop` object.
 * @param {number|undefined|null} [params.trailingPercent] Shorthand for a
 *   simple immediate percentage trail (e.g. 5). Used only when
 *   `trailingStop` is absent.
 * @returns {{ enabled: boolean, active: boolean, stopPrice: number|null,
 *   rawStopPrice: number|null, activationPrice: number|null,
 *   highestPrice: number|null, previousTrailingStop: number|null,
 *   movedUp: boolean }}
 * @throws On invalid configuration.
 */
export function calculateTrailingStop({
    entryPrice,
    currentPrice,
    highestPrice,
    previousTrailingStop,
    trailingStop,
    trailingPercent
}) {
    assertPositiveFiniteNumber(entryPrice, "Entry price");

    let config = trailingStop;

    if (
        (config === undefined || config === null) &&
        trailingPercent !== undefined &&
        trailingPercent !== null
    ) {
        config = {
            enabled: true,
            activation: "IMMEDIATE",
            type: "PERCENTAGE",
            value: trailingPercent
        };
    }

    const validated = validateTrailingStopConfig(config);

    const empty = {
        enabled: false,
        active: false,
        stopPrice: null,
        rawStopPrice: null,
        activationPrice: null,
        highestPrice: null,
        previousTrailingStop: null,
        movedUp: false
    };

    if (!validated.enabled) {
        return empty;
    }

    const referenceHigh =
        typeof highestPrice === "number" && Number.isFinite(highestPrice)
            ? highestPrice
            : typeof currentPrice === "number" &&
                Number.isFinite(currentPrice)
              ? currentPrice
              : entryPrice;

    assertPositiveFiniteNumber(referenceHigh, "Highest price");

    const previous =
        typeof previousTrailingStop === "number" &&
        Number.isFinite(previousTrailingStop)
            ? previousTrailingStop
            : null;

    let activationPrice = null;
    let active;

    if (validated.activation === "IMMEDIATE") {
        active = true;
    } else {
        activationPrice =
            validated.type === "PERCENTAGE"
                ? entryPrice * (1 + validated.activationValue / 100)
                : entryPrice + validated.activationValue;
        active = referenceHigh >= activationPrice;
    }

    if (!active) {
        return {
            enabled: true,
            active: false,
            stopPrice: previous,
            rawStopPrice: null,
            activationPrice,
            highestPrice: referenceHigh,
            previousTrailingStop: previous,
            movedUp: false
        };
    }

    const rawStopPrice =
        validated.type === "PERCENTAGE"
            ? referenceHigh * (1 - validated.value / 100)
            : referenceHigh - validated.value;

    assertFiniteNumber(rawStopPrice, "Trailing-stop price");

    if (!(rawStopPrice > 0)) {
        throw new Error(
            "Invalid trailing-stop configuration: calculated stop price " +
                `(${rawStopPrice}) must be greater than 0.`
        );
    }

    const stopPrice =
        previous !== null ? Math.max(rawStopPrice, previous) : rawStopPrice;

    return {
        enabled: true,
        active: true,
        stopPrice,
        rawStopPrice,
        activationPrice,
        highestPrice: referenceHigh,
        previousTrailingStop: previous,
        movedUp: previous !== null && stopPrice > previous
    };
}

/**
 * Long trailing-stop trigger: active stop exists and price is at or below
 * it.
 *
 * @param {number} currentPrice
 * @param {number|null|undefined} stopPrice
 * @returns {boolean}
 */
export function isTrailingStopHit(currentPrice, stopPrice) {
    if (
        typeof currentPrice !== "number" ||
        !Number.isFinite(currentPrice) ||
        typeof stopPrice !== "number" ||
        !Number.isFinite(stopPrice)
    ) {
        return false;
    }

    return currentPrice <= stopPrice;
}

export default {
    TRAILING_STOP_TYPES,
    TRAILING_ACTIVATIONS,
    normalizeTrailingStopType,
    validateTrailingStopConfig,
    calculateTrailingStop,
    isTrailingStopHit
};
