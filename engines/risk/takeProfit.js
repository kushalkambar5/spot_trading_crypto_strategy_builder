/**
 * Take-profit calculator for long spot positions.
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic.
 *
 * Supported modes (strategy schema stores PERCENTAGE/POINTS; FIXED_PRICE
 * and RISK_REWARD are accepted leniently -- persisting them requires
 * extending the `takeProfitSchema` enum in models/strategy.model.js):
 *   PERCENTAGE  -> target = entry * (1 + value / 100)
 *   POINTS      -> target = entry + value (absolute price distance)
 *   FIXED_PRICE -> target = value (absolute price, must sit above entry)
 *   RISK_REWARD -> target = entry + (entry - stopLossPrice) * ratio
 *
 * RISK_REWARD is always derived from the ACTUAL calculated stop-loss
 * distance -- never from an independent entry percentage. It therefore
 * requires a calculated stop-loss price; without one it is a
 * configuration error.
 *
 * Spot V1 is long-only: a target at or below the entry price is a
 * configuration error, never silently accepted.
 */

import {
    assertFiniteNumber,
    assertPositiveFiniteNumber
} from "./riskUtils.js";

export const TAKE_PROFIT_TYPES = Object.freeze([
    "PERCENTAGE",
    "POINTS",
    "FIXED_PRICE",
    "RISK_REWARD"
]);

const TAKE_PROFIT_ALIASES = Object.freeze({
    PERCENTAGE: ["PERCENTAGE", "PERCENT", "PERCENTAGE_PROFIT"],
    POINTS: ["POINTS", "POINT", "ABSOLUTE_DISTANCE", "PRICE_DISTANCE"],
    FIXED_PRICE: ["FIXED_PRICE", "FIXED", "PRICE", "ABSOLUTE_PRICE", "ABSOLUTE"],
    RISK_REWARD: [
        "RISK_REWARD",
        "RISK_REWARD_RATIO",
        "RISK_TO_REWARD",
        "REWARD_RISK",
        "RR"
    ]
});

/**
 * @param {unknown} type
 * @returns {string} Canonical take-profit type.
 * @throws On unknown types.
 */
export function normalizeTakeProfitType(type) {
    if (typeof type !== "string") {
        throw new Error(
            `Invalid take-profit type: ${type}. ` +
                `Expected one of: ${TAKE_PROFIT_TYPES.join(", ")}.`
        );
    }

    const key = type.trim().toUpperCase();

    for (const [canonical, aliases] of Object.entries(TAKE_PROFIT_ALIASES)) {
        if (aliases.includes(key)) {
            return canonical;
        }
    }

    throw new Error(
        `Invalid take-profit type: ${type}. ` +
            `Expected one of: ${TAKE_PROFIT_TYPES.join(", ")}.`
    );
}

/**
 * Validate a strategy takeProfit block.
 *
 * @param {object|undefined|null} takeProfit Strategy `exit.takeProfit`.
 * @returns {{ enabled: boolean, type: string|null, value: number|null }}
 * @throws On invalid configuration.
 */
export function validateTakeProfitConfig(takeProfit) {
    if (takeProfit === undefined || takeProfit === null) {
        return { enabled: false, type: null, value: null };
    }

    if (typeof takeProfit !== "object" || Array.isArray(takeProfit)) {
        throw new Error(
            "Invalid take-profit configuration: expected an object."
        );
    }

    if (!takeProfit.enabled) {
        return { enabled: false, type: null, value: null };
    }

    const type = normalizeTakeProfitType(takeProfit.type);

    assertFiniteNumber(takeProfit.value, "Take-profit value");

    if (!(takeProfit.value > 0)) {
        throw new Error(
            `Invalid take-profit value: ${takeProfit.value}. ` +
                "Expected a number greater than 0."
        );
    }

    return { enabled: true, type, value: takeProfit.value };
}

/**
 * Calculate the absolute take-profit price for a long spot position.
 *
 * @param {object} params
 * @param {number} params.entryPrice Entry price (> 0).
 * @param {object} params.takeProfit Strategy `exit.takeProfit` object.
 * @param {number|undefined|null} [params.stopLossPrice] Actual calculated
 *   stop-loss price. Required for RISK_REWARD mode.
 * @param {string} [params.side="LONG"] Only "LONG" is supported in spot V1.
 * @returns {{ enabled: boolean, price: number|null, type: string|null,
 *   riskRewardRatio: number|null }}
 * @throws On invalid configuration or a target on the wrong side of entry.
 */
export function calculateTakeProfit({
    entryPrice,
    takeProfit,
    stopLossPrice,
    side = "LONG"
}) {
    assertPositiveFiniteNumber(entryPrice, "Entry price");

    if (side !== "LONG") {
        throw new Error(
            `Unsupported position side for take profit: ${side}. ` +
                'Spot V1 supports "LONG" only.'
        );
    }

    const config = validateTakeProfitConfig(takeProfit);

    if (!config.enabled) {
        return {
            enabled: false,
            price: null,
            type: null,
            riskRewardRatio: null
        };
    }

    let price;

    switch (config.type) {
        case "PERCENTAGE":
            price = entryPrice * (1 + config.value / 100);
            break;

        case "POINTS":
            price = entryPrice + config.value;
            break;

        case "FIXED_PRICE":
            price = config.value;
            break;

        case "RISK_REWARD": {
            if (stopLossPrice === undefined || stopLossPrice === null) {
                throw new Error(
                    "Invalid take-profit configuration: RISK_REWARD mode " +
                        "requires a calculated stop-loss price."
                );
            }

            assertPositiveFiniteNumber(stopLossPrice, "Stop-loss price");

            if (!(stopLossPrice < entryPrice)) {
                throw new Error(
                    "Invalid take-profit configuration: RISK_REWARD mode " +
                        "requires a stop loss below the entry price."
                );
            }

            const riskDistance = entryPrice - stopLossPrice;
            price = entryPrice + riskDistance * config.value;
            break;
        }

        /* istanbul ignore next: guarded by normalizeTakeProfitType */
        default:
            throw new Error(`Invalid take-profit type: ${config.type}.`);
    }

    assertFiniteNumber(price, "Take-profit price");

    if (!(price > entryPrice)) {
        throw new Error(
            "Invalid take-profit configuration: target price " +
                `(${price}) must be above the entry price ` +
                `(${entryPrice}) for a long position.`
        );
    }

    return {
        enabled: true,
        price,
        type: config.type,
        riskRewardRatio: config.type === "RISK_REWARD" ? config.value : null
    };
}

/**
 * Long spot take-profit trigger: price at or above the target level.
 *
 * @param {number} currentPrice
 * @param {number} takeProfitPrice
 * @returns {boolean}
 */
export function isTakeProfitHit(currentPrice, takeProfitPrice) {
    if (
        typeof currentPrice !== "number" ||
        !Number.isFinite(currentPrice) ||
        typeof takeProfitPrice !== "number" ||
        !Number.isFinite(takeProfitPrice)
    ) {
        return false;
    }

    return currentPrice >= takeProfitPrice;
}

export default {
    TAKE_PROFIT_TYPES,
    normalizeTakeProfitType,
    validateTakeProfitConfig,
    calculateTakeProfit,
    isTakeProfitHit
};
