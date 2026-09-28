/**
 * Risk engine shared utilities: numeric validation and market-constraint
 * rounding helpers.
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic.
 *
 * Precision rule (used by every risk module):
 *   calculate -> validate -> normalize to market constraints -> final round.
 * Intermediate values are never rounded; only the final quantity/price
 * handed toward the order layer is snapped to step/tick sizes.
 */

/**
 * Assert a finite number.
 *
 * @param {unknown} value
 * @param {string} fieldName Used verbatim in the error message.
 * @returns {number}
 * @throws When the value is not a finite number.
 */
export function assertFiniteNumber(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${fieldName} must be a finite number.`);
    }

    return value;
}

/**
 * Assert a finite number greater than zero.
 *
 * @param {unknown} value
 * @param {string} fieldName Used verbatim in the error message.
 * @returns {number}
 * @throws When the value is not a finite number > 0.
 */
export function assertPositiveFiniteNumber(value, fieldName) {
    assertFiniteNumber(value, fieldName);

    if (value <= 0) {
        throw new Error(`${fieldName} must be greater than 0.`);
    }

    return value;
}

/**
 * Assert a finite number greater than or equal to zero.
 *
 * @param {unknown} value
 * @param {string} fieldName Used verbatim in the error message.
 * @returns {number}
 * @throws When the value is not a finite number >= 0.
 */
export function assertNonNegativeFiniteNumber(value, fieldName) {
    assertFiniteNumber(value, fieldName);

    if (value < 0) {
        throw new Error(`${fieldName} must be greater than or equal to 0.`);
    }

    return value;
}

/**
 * Count the decimals implied by a step/tick size (e.g. 0.001 -> 3).
 * Used to repair binary floating-point residue after step snapping.
 *
 * @param {number} step Finite number > 0.
 * @returns {number}
 */
function decimalsForStep(step) {
    const text = String(step);

    if (text.includes("e") || text.includes("E")) {
        const [, exponent = "0"] = text.toLowerCase().split("e");
        return Math.max(0, -Number(exponent));
    }

    const dot = text.indexOf(".");

    return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Round a value to a fixed decimal count without returning a string.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundToDecimals(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

/**
 * Floor a quantity down to the exchange quantity step size.
 * Always rounds DOWN so the normalized size never exceeds the requested
 * (affordable) size.
 *
 * @param {number} quantity Finite number > 0.
 * @param {number} stepSize Finite number > 0.
 * @returns {number} Snapped quantity (>= 0).
 */
export function floorToStepSize(quantity, stepSize) {
    assertPositiveFiniteNumber(quantity, "Quantity");
    assertPositiveFiniteNumber(stepSize, "Step size");

    const steps = Math.floor(quantity / stepSize + Number.EPSILON);
    const snapped = steps * stepSize;

    return roundToDecimals(snapped, decimalsForStep(stepSize));
}

/**
 * Snap a price to the exchange price tick size (nearest tick).
 * Risk trigger levels (SL/TP/trailing) are informational until the order
 * layer places real stop orders, so nearest-tick rounding is documented
 * and deterministic.
 *
 * @param {number} price Finite number > 0.
 * @param {number} tickSize Finite number > 0.
 * @returns {number}
 */
export function roundToTickSize(price, tickSize) {
    assertPositiveFiniteNumber(price, "Price");
    assertPositiveFiniteNumber(tickSize, "Tick size");

    const snapped = Math.round(price / tickSize) * tickSize;

    return roundToDecimals(snapped, decimalsForStep(tickSize));
}

/**
 * Coerce a Date / ISO string / epoch number / epoch-ms number to epoch ms.
 *
 * @param {unknown} value
 * @param {string} fieldName Used verbatim in the error message.
 * @returns {number} Epoch milliseconds.
 * @throws When the value cannot be interpreted as a timestamp.
 */
export function toEpochMs(value, fieldName) {
    if (value instanceof Date) {
        const time = value.getTime();

        if (!Number.isFinite(time)) {
            throw new Error(`${fieldName} must be a valid timestamp.`);
        }

        return time;
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`${fieldName} must be a valid timestamp.`);
        }

        // Heuristic: values below 1e12 are epoch seconds.
        return value < 1e12 ? value * 1000 : value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const time = Date.parse(value);

        if (!Number.isFinite(time)) {
            throw new Error(`${fieldName} must be a valid timestamp.`);
        }

        return time;
    }

    throw new Error(`${fieldName} must be a valid timestamp.`);
}

/**
 * Convert a strategy cooldown unit to milliseconds.
 *
 * @param {unknown} unit One of "SECONDS" | "MINUTES" | "HOURS".
 * @returns {number}
 * @throws On unknown units.
 */
export function cooldownUnitToMs(unit) {
    switch (unit) {
        case "SECONDS":
            return 1000;

        case "MINUTES":
            return 60 * 1000;

        case "HOURS":
            return 60 * 60 * 1000;

        default:
            throw new Error(
                `Invalid cooldown unit: ${unit}. ` +
                    "Expected one of: SECONDS, MINUTES, HOURS."
            );
    }
}

/**
 * Calculate the monetary risk of a long spot position from the distance
 * between entry and stop loss.
 *
 * Capital allocation (quantity * entry) and risk amount
 * ((entry - stop) * quantity) are intentionally separate values.
 *
 * @param {object} params
 * @param {number} params.entryPrice
 * @param {number} params.stopLossPrice
 * @param {number} params.quantity
 * @param {number|undefined|null} params.portfolioValue Optional, for
 *   risk-percentage. When absent, riskPercent is null (never fabricated).
 * @returns {{ riskPerUnit: number, totalRisk: number, riskPercent: number|null }}
 */
export function calculateRiskAmount({
    entryPrice,
    stopLossPrice,
    quantity,
    portfolioValue
}) {
    assertPositiveFiniteNumber(entryPrice, "Entry price");
    assertPositiveFiniteNumber(stopLossPrice, "Stop-loss price");
    assertPositiveFiniteNumber(quantity, "Quantity");

    if (stopLossPrice >= entryPrice) {
        throw new Error(
            "Invalid stop-loss price for risk calculation: " +
                "stop loss must be below the entry price for a long position."
        );
    }

    const riskPerUnit = entryPrice - stopLossPrice;
    const totalRisk = riskPerUnit * quantity;

    let riskPercent = null;

    if (portfolioValue !== undefined && portfolioValue !== null) {
        assertPositiveFiniteNumber(portfolioValue, "Portfolio value");
        riskPercent = (totalRisk / portfolioValue) * 100;
    }

    return { riskPerUnit, totalRisk, riskPercent };
}

export default {
    assertFiniteNumber,
    assertPositiveFiniteNumber,
    assertNonNegativeFiniteNumber,
    floorToStepSize,
    roundToTickSize,
    toEpochMs,
    cooldownUnitToMs,
    calculateRiskAmount
};
