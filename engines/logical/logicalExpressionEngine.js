/**
 * Logical expression engine: recursively evaluates nested AND/OR groups
 * over atomic conditions (models/strategy.model.js `conditionTreeSchema`
 * groups containing `conditionSchema` leaves).
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic.
 *
 * Canonical shapes (exactly as stored by the schema):
 *   condition: { type: "condition", left, operator, right }
 *   group:     { type: "group", logic: "AND" | "OR", children: [...] }
 *
 * Tolerated aliases (same DSL, lenient reading -- not a second DSL):
 *   group `operator` is read as `logic` (the plan doc uses `operator`
 *     for groups, the schema stores `logic`).
 *
 * Group nesting is evaluated recursively and never flattened, so
 * `A AND (B OR C)` keeps its semantics and never becomes `(A AND B) OR C`.
 *
 * All children of a group are always evaluated (no short-circuiting) so
 * that invalid configurations surface deterministically regardless of
 * child order or the truth value of earlier siblings.
 */

import { evaluateCondition } from "../condition/conditionEngine.js";

export const LOGIC_OPERATORS = Object.freeze(["AND", "OR"]);

/**
 * @param {unknown} node
 * @returns {boolean} True for atomic condition nodes.
 */
export function isConditionNode(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
        return false;
    }

    if (node.type === "condition") {
        return true;
    }

    return (
        node.left !== undefined &&
        node.right !== undefined &&
        (node.operator !== undefined ||
            node.comparator !== undefined ||
            node.op !== undefined)
    );
}

/**
 * @param {unknown} node
 * @returns {boolean} True for AND/OR group nodes.
 */
export function isGroupNode(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
        return false;
    }

    if (node.type === "group") {
        return true;
    }

    return (
        Array.isArray(node.children) &&
        (node.logic !== undefined || node.operator !== undefined)
    );
}

/**
 * @param {object} node Group node.
 * @returns {string} Canonical "AND" / "OR".
 * @throws On invalid logical operators.
 */
function readLogic(node) {
    const logic =
        node.logic !== undefined && node.logic !== null
            ? node.logic
            : node.operator;

    if (logic !== "AND" && logic !== "OR") {
        throw new Error(
            `Invalid logical operator: ${logic}. Expected "AND" or "OR".`
        );
    }

    return logic;
}

/**
 * Recursively evaluate a condition tree to a boolean.
 *
 * @param {object} node Condition or group node.
 * @param {object} context Evaluation context (see operandResolver.js).
 * @param {number} [barOffset=0] Forwarded to every atomic condition so the
 *   whole tree can be evaluated one bar back (edge-trigger support).
 * @returns {boolean}
 * @throws On malformed groups/conditions, invalid logic, or any invalid
 *   nested configuration. Invalid configuration is never coerced to false.
 */
export function evaluateExpression(node, context, barOffset = 0) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
        throw new Error(
            "Invalid expression node: expected a condition " +
                "{ left, operator, right } or a group { logic, children }."
        );
    }

    if (isConditionNode(node)) {
        return evaluateCondition(node, context, barOffset);
    }

    if (node.type === "group" || Array.isArray(node.children)) {
        const logic = readLogic(node);

        if (!Array.isArray(node.children) || node.children.length === 0) {
            throw new Error(
                "Invalid logical group: children must be a non-empty array."
            );
        }

        const results = node.children.map(child =>
            evaluateExpression(child, context, barOffset)
        );

        return logic === "AND"
            ? results.every(Boolean)
            : results.some(Boolean);
    }

    throw new Error(
        "Invalid expression node: expected a condition " +
            "{ left, operator, right } or a group { logic, children }."
    );
}

export default {
    LOGIC_OPERATORS,
    isConditionNode,
    isGroupNode,
    evaluateExpression
};
