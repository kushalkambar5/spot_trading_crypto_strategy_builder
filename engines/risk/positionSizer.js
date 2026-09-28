/**
 * Position sizer: converts a strategy `positionSizing` block plus runtime
 * pricing context into a raw quantity/notional, then normalizes it against
 * exchange/market constraints supplied by the caller.
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic. Market constraints arrive through
 * the context object -- this module never fetches them.
 *
 * Canonical sizing types (strategy schema stores the first three;
 * PERCENT_AVAILABLE_BALANCE is accepted leniently so the engine already
 * supports it -- persisting it requires adding it to the
 * `positionSizingSchema` enum in models/strategy.model.js):
 *   FIXED_QUANTITY          -> quantity = value (asset units, e.g. BTC)
 *   FIXED_USDT              -> notional = value, quantity = value / price
 *   PERCENT_CAPITAL         -> notional = portfolio * value / 100
 *   PERCENT_AVAILABLE_BALANCE -> notional = available * value / 100
 *
 * Capital allocation (% of portfolio/balance) is NOT risk amount
 * (entry - stop) * quantity. Those stay separate by design.
 *
 * Risk-based sizing ("risk $X per trade / stop distance") is NOT
 * implemented: the strategy schema has no such mode. The raw-size step is
 * isolated so it can be added later without touching normalization.
 */

import {
    assertFiniteNumber,
    assertPositiveFiniteNumber,
    floorToStepSize
} from "./riskUtils.js";

export const POSITION_SIZING_TYPES = Object.freeze([
    "FIXED_QUANTITY",
    "FIXED_USDT",
    "PERCENT_CAPITAL",
    "PERCENT_AVAILABLE_BALANCE"
]);

/** Quantity fell below the market minimum (risk rejection, not a bug). */
export const BELOW_MIN_QUANTITY = "BELOW_MIN_QUANTITY";
/** Notional fell below the market minimum (risk rejection, not a bug). */
export const BELOW_MIN_NOTIONAL = "BELOW_MIN_NOTIONAL";

/**
 * Lenient alias map. Canonical keys are POSITION_SIZING_TYPES; aliases
 * cover naming variants callers may reasonably use. Unknown types throw
 * instead of silently defaulting.
 */
const SIZING_ALIASES = Object.freeze({
    FIXED_QUANTITY: ["FIXED_QUANTITY", "FIXED_QTY", "FIXED_QUANT"],
    FIXED_USDT: ["FIXED_USDT", "FIXED_AMOUNT", "FIXED_NOTIONAL", "FIXED_USDT_AMOUNT", "FIXED_USD"],
    PERCENT_CAPITAL: [
        "PERCENT_CAPITAL",
        "PERCENT_OF_CAPITAL",
        "PERCENTAGE_OF_CAPITAL",
        "PERCENT_PORTFOLIO",
        "PERCENT_OF_PORTFOLIO",
        "PERCENTAGE_OF_PORTFOLIO"
    ],
    PERCENT_AVAILABLE_BALANCE: [
        "PERCENT_AVAILABLE_BALANCE",
        "PERCENT_OF_AVAILABLE_BALANCE",
        "PERCENTAGE_OF_AVAILABLE_BALANCE",
        "PERCENT_AVAILABLE",
        "PERCENT_OF_AVAILABLE",
        "PERCENT_BALANCE",
        "PERCENT_OF_BALANCE"
    ]
});

/**
 * Normalize a sizing type string to its canonical form.
 *
 * @param {unknown} type
 * @returns {string} Canonical sizing type.
 * @throws On unknown types.
 */
export function normalizeSizingType(type) {
    if (typeof type !== "string") {
        throw new Error(
            `Invalid position sizing type: ${type}. ` +
                `Expected one of: ${POSITION_SIZING_TYPES.join(", ")}.`
        );
    }

    const key = type.trim().toUpperCase();

    for (const [canonical, aliases] of Object.entries(SIZING_ALIASES)) {
        if (aliases.includes(key)) {
            return canonical;
        }
    }

    throw new Error(
        `Invalid position sizing type: ${type}. ` +
            `Expected one of: ${POSITION_SIZING_TYPES.join(", ")}.`
    );
}

/**
 * Validate a strategy positionSizing block. Throws on invalid
 * configuration (never coerced to a default size).
 *
 * @param {object} sizing Strategy `positionSizing` object.
 * @returns {{ type: string, value: number }} Canonical type + raw value.
 * @throws On missing/negative/NaN values or allocations above 100%.
 */
export function validateSizingConfig(sizing) {
    if (!sizing || typeof sizing !== "object" || Array.isArray(sizing)) {
        throw new Error("Invalid position sizing: expected an object.");
    }

    const type = normalizeSizingType(sizing.type);

    assertFiniteNumber(sizing.value, "Position sizing value");

    if (!(sizing.value > 0)) {
        throw new Error(
            `Invalid position sizing value: ${sizing.value}. ` +
                "Expected a number greater than 0."
        );
    }

    if (
        (type === "PERCENT_CAPITAL" ||
            type === "PERCENT_AVAILABLE_BALANCE") &&
        sizing.value > 100
    ) {
        throw new Error(
            `Invalid position sizing value: ${sizing.value}. ` +
                "Percentage allocation must not exceed 100."
        );
    }

    return { type, value: sizing.value };
}

/**
 * Read a market-constraints object leniently. Both terse and verbose key
 * spellings are accepted because the future execution layer has not fixed
 * its vocabulary yet; unknown extra keys are ignored.
 *
 * @param {object|undefined|null} constraints
 * @returns {{ minQuantity: number|null, maxQuantity: number|null,
 *   stepSize: number|null, minNotional: number|null,
 *   tickSize: number|null }}
 * @throws On invalid (negative/NaN) constraint values.
 */
export function readMarketConstraints(constraints) {
    const empty = {
        minQuantity: null,
        maxQuantity: null,
        stepSize: null,
        minNotional: null,
        tickSize: null
    };

    if (constraints === undefined || constraints === null) {
        return empty;
    }

    if (typeof constraints !== "object" || Array.isArray(constraints)) {
        throw new Error("Invalid market constraints: expected an object.");
    }

    const pick = (...keys) => {
        for (const key of keys) {
            if (constraints[key] !== undefined && constraints[key] !== null) {
                return constraints[key];
            }
        }

        return null;
    };

    const minQuantity = pick("minQuantity", "minQty", "minimumQuantity");
    const maxQuantity = pick("maxQuantity", "maxQty", "maximumQuantity");
    const stepSize = pick("stepSize", "quantityStep", "lotStep", "step");
    const minNotional = pick(
        "minNotional",
        "minimumNotional",
        "minNotionalValue",
        "notionalMin"
    );
    const tickSize = pick("tickSize", "priceTick", "priceTickSize");

    const resolved = { ...empty };

    if (minQuantity !== null) {
        resolved.minQuantity = assertPositiveFiniteNumber(
            minQuantity,
            "Market minimum quantity"
        );
    }

    if (maxQuantity !== null) {
        resolved.maxQuantity = assertPositiveFiniteNumber(
            maxQuantity,
            "Market maximum quantity"
        );
    }

    if (stepSize !== null) {
        resolved.stepSize = assertPositiveFiniteNumber(
            stepSize,
            "Market quantity step size"
        );
    }

    if (minNotional !== null) {
        resolved.minNotional = assertPositiveFiniteNumber(
            minNotional,
            "Market minimum notional"
        );
    }

    if (tickSize !== null) {
        resolved.tickSize = assertPositiveFiniteNumber(
            tickSize,
            "Market price tick size"
        );
    }

    if (
        resolved.minQuantity !== null &&
        resolved.maxQuantity !== null &&
        resolved.minQuantity > resolved.maxQuantity
    ) {
        throw new Error(
            "Invalid market constraints: minimum quantity exceeds " +
                "maximum quantity."
        );
    }

    return resolved;
}

/**
 * Calculate the RAW position size (before market-constraint normalization).
 * Uses the signal/current entry price -- never a stale or assumed price.
 *
 * @param {object} sizing Strategy `positionSizing` object.
 * @param {object} pricing Runtime pricing context.
 * @param {number} pricing.entryPrice Signal/current entry price (> 0).
 * @param {number} [pricing.portfolioValue] Required for PERCENT_CAPITAL.
 * @param {number} [pricing.availableBalance] Required for
 *   PERCENT_AVAILABLE_BALANCE.
 * @returns {{ quantity: number, notional: number, sizingType: string,
 *   sizingValue: number }}
 * @throws On invalid configuration or missing runtime context.
 */
export function calculateRawPositionSize(
    sizing,
    { entryPrice, portfolioValue, availableBalance }
) {
    const { type, value } = validateSizingConfig(sizing);

    assertPositiveFiniteNumber(entryPrice, "Entry price");

    switch (type) {
        case "FIXED_QUANTITY": {
            const quantity = value;
            return {
                quantity,
                notional: quantity * entryPrice,
                sizingType: type,
                sizingValue: value
            };
        }

        case "FIXED_USDT": {
            const notional = value;
            return {
                quantity: notional / entryPrice,
                notional,
                sizingType: type,
                sizingValue: value
            };
        }

        case "PERCENT_CAPITAL": {
            if (portfolioValue === undefined || portfolioValue === null) {
                throw new Error(
                    "Missing portfolio value: PERCENT_CAPITAL sizing " +
                        "requires context.portfolioValue."
                );
            }

            assertPositiveFiniteNumber(portfolioValue, "Portfolio value");

            const notional = (portfolioValue * value) / 100;
            return {
                quantity: notional / entryPrice,
                notional,
                sizingType: type,
                sizingValue: value
            };
        }

        case "PERCENT_AVAILABLE_BALANCE": {
            if (availableBalance === undefined || availableBalance === null) {
                throw new Error(
                    "Missing available balance: PERCENT_AVAILABLE_BALANCE " +
                        "sizing requires context.availableBalance."
                );
            }

            assertPositiveFiniteNumber(availableBalance, "Available balance");

            const notional = (availableBalance * value) / 100;
            return {
                quantity: notional / entryPrice,
                notional,
                sizingType: type,
                sizingValue: value
            };
        }

        /* istanbul ignore next: guarded by normalizeSizingType */
        default:
            throw new Error(`Invalid position sizing type: ${type}.`);
    }
}

/**
 * Normalize a raw quantity against market constraints:
 *   raw quantity -> step-size floor -> max-quantity cap ->
 *   minimum-quantity check -> minimum-notional check.
 *
 * Values below exchange minimums are explicit rejections (never silently
 * created). Quantities above the maximum are capped down to the maximum.
 *
 * @param {number} rawQuantity Un-normalized quantity (> 0).
 * @param {number} entryPrice Entry price (> 0, for notional math).
 * @param {object|undefined|null} marketConstraints Optional constraints;
 *   absent means "no market limits known yet".
 * @returns {{ ok: true, quantity: number, notional: number,
 *   adjustments: string[] } | { ok: false, reason: string,
 *   quantity: number, notional: number, detail: string }}
 */
export function normalizePositionSize(
    rawQuantity,
    entryPrice,
    marketConstraints
) {
    assertPositiveFiniteNumber(rawQuantity, "Raw quantity");
    assertPositiveFiniteNumber(entryPrice, "Entry price");

    const limits = readMarketConstraints(marketConstraints);
    const adjustments = [];
    let quantity = rawQuantity;

    if (limits.stepSize !== null) {
        const stepped = floorToStepSize(quantity, limits.stepSize);

        if (stepped !== quantity) {
            adjustments.push(
                `STEP_SIZE: ${quantity} -> ${stepped} (step ${limits.stepSize})`
            );
        }

        quantity = stepped;
    }

    if (limits.maxQuantity !== null && quantity > limits.maxQuantity) {
        adjustments.push(
            `MAX_QUANTITY: ${quantity} -> ${limits.maxQuantity}`
        );
        quantity = limits.maxQuantity;
    }

    const notional = quantity * entryPrice;

    if (limits.minQuantity !== null && quantity < limits.minQuantity) {
        return {
            ok: false,
            reason: BELOW_MIN_QUANTITY,
            quantity,
            notional,
            detail:
                `Quantity ${quantity} is below the market minimum ` +
                `${limits.minQuantity}.`
        };
    }

    if (
        limits.minNotional !== null &&
        notional < limits.minNotional
    ) {
        return {
            ok: false,
            reason: BELOW_MIN_NOTIONAL,
            quantity,
            notional,
            detail:
                `Notional ${notional} is below the market minimum ` +
                `${limits.minNotional}.`
        };
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
        return {
            ok: false,
            reason: BELOW_MIN_QUANTITY,
            quantity,
            notional,
            detail: `Quantity ${quantity} is not tradable after normalization.`
        };
    }

    return { ok: true, quantity, notional, adjustments };
}

/**
 * Convenience wrapper: raw sizing + normalization in one call.
 * The risk engine uses the two steps separately (raw size is needed for
 * the capital-allocation check before final validation), so this is
 * exposed for simple callers only.
 */
export function calculatePositionSize(sizing, pricing, marketConstraints) {
    const raw = calculateRawPositionSize(sizing, pricing);
    const normalized = normalizePositionSize(
        raw.quantity,
        pricing.entryPrice,
        marketConstraints
    );

    return { raw, normalized };
}

export default {
    POSITION_SIZING_TYPES,
    BELOW_MIN_QUANTITY,
    BELOW_MIN_NOTIONAL,
    normalizeSizingType,
    validateSizingConfig,
    readMarketConstraints,
    calculateRawPositionSize,
    normalizePositionSize,
    calculatePositionSize
};
