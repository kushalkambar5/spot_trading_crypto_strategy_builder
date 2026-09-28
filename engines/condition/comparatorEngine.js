/**
 * Comparator engine.
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic.
 *
 * Supported operators mirror `models/strategy.model.js` exactly:
 *   GREATER_THAN, LESS_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL,
 *   EQUAL, CROSSES_ABOVE, CROSSES_BELOW
 *
 * Crossover semantics (matches the strategy contract):
 *   CROSSES_ABOVE: previousLeft <= previousRight AND currentLeft > currentRight
 *   CROSSES_BELOW: previousLeft >= previousRight AND currentLeft < currentRight
 *
 * Missing-value rule:
 *   undefined / null / NaN (or any non-finite number) on a required side
 *   makes the comparison return `false` -- never `true`. Missing data must
 *   never produce a signal. Callers that need to distinguish "valid false"
 *   from "invalid configuration" rely on this module throwing for invalid
 *   configuration (unknown operators, non-numeric ordering comparisons)
 *   while returning `false` for unavailable data.
 */

export const OPERATORS = Object.freeze([
    "GREATER_THAN",
    "LESS_THAN",
    "GREATER_THAN_OR_EQUAL",
    "LESS_THAN_OR_EQUAL",
    "EQUAL",
    "CROSSES_ABOVE",
    "CROSSES_BELOW"
]);

const OPERATOR_SET = new Set(OPERATORS);

const CROSSOVER_SET = new Set(["CROSSES_ABOVE", "CROSSES_BELOW"]);

/**
 * @param {unknown} operator
 * @returns {boolean}
 */
export function isSupportedOperator(operator) {
    return typeof operator === "string" && OPERATOR_SET.has(operator);
}

/**
 * @param {unknown} operator
 * @returns {boolean}
 */
export function isCrossoverOperator(operator) {
    return typeof operator === "string" && CROSSOVER_SET.has(operator);
}

/**
 * A value counts as "missing" when it cannot participate in a comparison:
 * null / undefined (indicator warmup, out-of-range index, data gap) or a
 * non-finite number (NaN, Infinity). Missing values yield `false`, never
 * an accidental `true` and never silent coercion to zero.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isMissingValue(value) {
    if (value === null || value === undefined) {
        return true;
    }

    return typeof value === "number" && !Number.isFinite(value);
}

/**
 * Apply a deterministic comparison.
 *
 * @param {string} operator One of OPERATORS.
 * @param {unknown} left Current-bar left value.
 * @param {unknown} right Current-bar right value.
 * @param {unknown} [previousLeft] Previous-bar left value (crossovers only).
 * @param {unknown} [previousRight] Previous-bar right value (crossovers only).
 * @returns {boolean}
 * @throws When the operator is unknown or the operand value types are
 *   incompatible with the operator (e.g. ordering comparison on strings).
 */
export function applyComparator(
    operator,
    left,
    right,
    previousLeft,
    previousRight
) {
    if (!isSupportedOperator(operator)) {
        throw new Error(
            `Invalid operator: ${operator}. ` +
                `Expected one of: ${OPERATORS.join(", ")}.`
        );
    }

    if (isCrossoverOperator(operator)) {
        if (
            isMissingValue(left) ||
            isMissingValue(right) ||
            isMissingValue(previousLeft) ||
            isMissingValue(previousRight)
        ) {
            return false;
        }

        if (
            typeof left !== "number" ||
            typeof right !== "number" ||
            typeof previousLeft !== "number" ||
            typeof previousRight !== "number"
        ) {
            throw new Error(
                `Operator ${operator} requires numeric operands ` +
                    `but received (${typeof previousLeft}, ${typeof previousRight}) ` +
                    `-> (${typeof left}, ${typeof right}).`
            );
        }

        if (operator === "CROSSES_ABOVE") {
            return previousLeft <= previousRight && left > right;
        }

        return previousLeft >= previousRight && left < right;
    }

    if (operator === "EQUAL") {
        // null == null must NOT become true: unavailable data is false.
        if (isMissingValue(left) || isMissingValue(right)) {
            return false;
        }

        // String equality supports string indicator outputs
        // (e.g. SUPERTREND "direction" compared against another "direction"
        // series). Mixed-type equality is a valid `false`, not an error.
        if (typeof left !== typeof right) {
            return false;
        }

        return left === right;
    }

    if (isMissingValue(left) || isMissingValue(right)) {
        return false;
    }

    if (typeof left !== "number" || typeof right !== "number") {
        throw new Error(
            `Operator ${operator} requires numeric operands ` +
                `but received (${typeof left}, ${typeof right}).`
        );
    }

    switch (operator) {
        case "GREATER_THAN":
            return left > right;

        case "LESS_THAN":
            return left < right;

        case "GREATER_THAN_OR_EQUAL":
            return left >= right;

        case "LESS_THAN_OR_EQUAL":
            return left <= right;

        /* istanbul ignore next: guarded by isSupportedOperator above */
        default:
            throw new Error(`Invalid operator: ${operator}.`);
    }
}

export default {
    OPERATORS,
    isSupportedOperator,
    isCrossoverOperator,
    applyComparator
};
