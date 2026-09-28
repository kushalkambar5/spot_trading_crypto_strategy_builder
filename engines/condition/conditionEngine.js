/**
 * Condition (expression) engine: evaluates a single atomic strategy
 * condition of the form LEFT OPERAND + OPERATOR + RIGHT OPERAND
 * (models/strategy.model.js `conditionSchema`).
 *
 * Pure, deterministic module: no database, network, exchange, order,
 * backtest, or frontend logic.
 *
 * Flow per evaluation:
 *   resolve left operand  --operandResolver--> value (or null when missing)
 *   resolve right operand --operandResolver--> value (or null when missing)
 *   for CROSSES_* also resolve both operands one bar back
 *   apply comparator      --comparatorEngine--> boolean
 *
 * Missing values (indicator warmup, insufficient history, data gaps)
 * evaluate to `false`, never to an accidental `true`. Invalid
 * configuration throws explicit errors instead of becoming `false`.
 */

import { resolveOperandValue } from "./operandResolver.js";
import {
    applyComparator,
    isCrossoverOperator,
    isSupportedOperator
} from "./comparatorEngine.js";

/**
 * Extract the operator, tolerating the `comparator` / `op` aliases for the
 * canonical `operator` field stored by the schema.
 *
 * @param {object} condition
 * @returns {unknown}
 */
function readOperator(condition) {
    if (condition.operator !== undefined && condition.operator !== null) {
        return condition.operator;
    }

    if (condition.comparator !== undefined && condition.comparator !== null) {
        return condition.comparator;
    }

    return condition.op;
}

/**
 * Validate the atomic condition shape (schema: type "condition" with
 * left/operator/right).
 *
 * @param {unknown} condition
 * @returns {{ left: object, operator: string, right: object }}
 * @throws On malformed conditions or unknown operators.
 */
function assertConditionShape(condition) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
        throw new Error("Invalid condition: expected an object.");
    }

    if (
        condition.type !== undefined &&
        condition.type !== null &&
        condition.type !== "condition"
    ) {
        throw new Error(
            `Invalid condition type: ${condition.type}. Expected "condition".`
        );
    }

    if (condition.left === undefined || condition.left === null) {
        throw new Error("Invalid condition: missing left operand.");
    }

    if (condition.right === undefined || condition.right === null) {
        throw new Error("Invalid condition: missing right operand.");
    }

    const operator = readOperator(condition);

    if (!isSupportedOperator(operator)) {
        throw new Error(
            `Invalid operator: ${operator}. Expected one of: ` +
                "GREATER_THAN, LESS_THAN, GREATER_THAN_OR_EQUAL, " +
                "LESS_THAN_OR_EQUAL, EQUAL, CROSSES_ABOVE, CROSSES_BELOW."
        );
    }

    return { left: condition.left, operator, right: condition.right };
}

/**
 * Evaluate one atomic condition with full audit detail.
 *
 * @param {object} condition `{ type: "condition", left, operator, right }`.
 * @param {object} context Evaluation context (see operandResolver.js).
 * @param {number} [barOffset=0] 0 = current bar, 1 = previous bar.
 * @returns {{ result: boolean, operator: string, left: *, right: *,
 *   previousLeft: (*|undefined), previousRight: (*|undefined) }}
 *   Resolved operand values are included verbatim (`null` = unavailable).
 */
export function evaluateConditionDetailed(
    condition,
    context,
    barOffset = 0
) {
    const { left, operator, right } = assertConditionShape(condition);

    if (!Number.isInteger(barOffset) || barOffset < 0) {
        throw new Error(
            `Invalid barOffset: ${barOffset}. Expected a non-negative integer.`
        );
    }

    const leftValue = resolveOperandValue(left, context, barOffset);
    const rightValue = resolveOperandValue(right, context, barOffset);

    let previousLeft;
    let previousRight;

    if (isCrossoverOperator(operator)) {
        previousLeft = resolveOperandValue(left, context, barOffset + 1);
        previousRight = resolveOperandValue(right, context, barOffset + 1);
    }

    const result = applyComparator(
        operator,
        leftValue,
        rightValue,
        previousLeft,
        previousRight
    );

    return {
        result,
        operator,
        left: leftValue,
        right: rightValue,
        previousLeft,
        previousRight
    };
}

/**
 * Evaluate one atomic condition to a boolean.
 *
 * @param {object} condition `{ type: "condition", left, operator, right }`.
 * @param {object} context Evaluation context (see operandResolver.js).
 * @param {number} [barOffset=0] 0 = current bar, 1 = previous bar.
 * @returns {boolean}
 */
export function evaluateCondition(condition, context, barOffset = 0) {
    return evaluateConditionDetailed(condition, context, barOffset).result;
}

export default {
    evaluateCondition,
    evaluateConditionDetailed
};
