/**
 * Strategy-level risk constraints: the gates a BUY signal must pass
 * before any capital math runs.
 *
 * Pure, deterministic module: no database, network, exchange, indicator,
 * order, backtest, or frontend logic. Daily PnL/equity, position counts,
 * deployed capital, and timestamps arrive through the runtime context --
 * this module never queries them.
 *
 * Each check returns `{ passed: true }` or
 * `{ passed: false, reason, detail }`. Invalid strategy configuration
 * throws (never coerced to pass/fail). A `passed: false` result is a
 * normal risk rejection, distinct from a configuration error.
 *
 * Daily-loss semantics (explicit assumption -- the project does not yet
 * define daily PnL semantics anywhere else):
 *   dailyLoss = dailyStartingEquity - currentEquity   (when both provided)
 *           = -(dailyPnL)                              (when dailyPnL given)
 *           = -(realizedDailyPnL + unrealizedPnL)      (fallback sum)
 * A positive dailyLoss is money lost. Entries are blocked when
 * dailyLoss >= the configured limit ("reaches or exceeds").
 *
 * Limit vocabulary (strategy schema stores absolute/percent numbers;
 * object forms are accepted leniently):
 *   riskManagement.maxDailyLoss            absolute amount (schema field)
 *   riskManagement.maxDailyLossPercent     percent of dailyStartingEquity
 *   riskManagement.maxDailyLossType: "PERCENTAGE" switches maxDailyLoss
 *     to percent-of-starting-equity interpretation
 */

import {
    assertFiniteNumber,
    assertNonNegativeFiniteNumber,
    assertPositiveFiniteNumber,
    toEpochMs,
    cooldownUnitToMs
} from "./riskUtils.js";

/**
 * Normal risk rejections (business outcomes) plus the entry-validation
 * rejections owned by the risk engine. Configuration errors are NOT in
 * this enum -- they throw `Error("Invalid ...")` instead.
 */
export const RISK_REJECTION_REASONS = Object.freeze({
    NO_SIGNAL: "NO_SIGNAL",
    INVALID_SIGNAL: "INVALID_SIGNAL",
    STRATEGY_DISABLED: "STRATEGY_DISABLED",
    COOLDOWN_ACTIVE: "COOLDOWN_ACTIVE",
    MAX_POSITIONS_REACHED: "MAX_POSITIONS_REACHED",
    MAX_TRADES_PER_DAY_REACHED: "MAX_TRADES_PER_DAY_REACHED",
    MAX_DAILY_LOSS_REACHED: "MAX_DAILY_LOSS_REACHED",
    MAX_CAPITAL_ALLOCATION_REACHED: "MAX_CAPITAL_ALLOCATION_REACHED",
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
    BELOW_MIN_QUANTITY: "BELOW_MIN_QUANTITY",
    BELOW_MIN_NOTIONAL: "BELOW_MIN_NOTIONAL"
});

/**
 * Read the strategy riskManagement block leniently (absent block means
 * "no strategy-level constraints configured").
 *
 * @param {object|undefined|null} strategy
 * @returns {object} Risk block or empty object.
 * @throws When strategy is not an object.
 */
export function readRiskBlock(strategy) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
        throw new Error("Invalid strategy: expected an object.");
    }

    const risk = strategy.riskManagement;

    if (risk === undefined || risk === null) {
        return {};
    }

    if (typeof risk !== "object" || Array.isArray(risk)) {
        throw new Error(
            "Invalid risk management configuration: expected an object."
        );
    }

    return risk;
}

/**
 * Count open positions from either an array or an explicit count.
 *
 * @param {object} context Runtime context (`openPositions` array and/or
 *   `openPositionCount` number).
 * @returns {number}
 */
function readOpenPositionCount(context) {
    const source = context && typeof context === "object" ? context : {};

    if (Array.isArray(source.openPositions)) {
        return source.openPositions.length;
    }

    if (
        source.openPositionCount !== undefined &&
        source.openPositionCount !== null
    ) {
        assertFiniteNumber(source.openPositionCount, "Open position count");

        if (
            !Number.isInteger(source.openPositionCount) ||
            source.openPositionCount < 0
        ) {
            throw new Error(
                "Invalid open position count: expected a non-negative integer."
            );
        }

        return source.openPositionCount;
    }

    return 0;
}

/**
 * Maximum open positions gate.
 *
 * @param {object} risk Strategy riskManagement block (or empty object).
 * @param {object} context Runtime context.
 * @returns {{ passed: boolean, reason?: string, detail?: string,
 *   current?: number, max?: number }}
 * @throws On invalid configuration.
 */
export function checkMaxPositions(risk, context) {
    const max = risk.maxOpenPositions;

    if (max === undefined || max === null) {
        return { passed: true };
    }

    assertFiniteNumber(max, "Maximum open positions");

    if (!Number.isInteger(max) || max < 1) {
        throw new Error(
            `Invalid maximum open positions: ${max}. ` +
                "Expected a positive integer."
        );
    }

    const current = readOpenPositionCount(context ?? {});

    if (current >= max) {
        return {
            passed: false,
            reason: RISK_REJECTION_REASONS.MAX_POSITIONS_REACHED,
            detail: `Open positions (${current}) reached the maximum (${max}).`,
            current,
            max
        };
    }

    return { passed: true, current, max };
}

/**
 * Maximum trades-per-day gate (schema-supported: `maxTradesPerDay`).
 *
 * @param {object} risk Strategy riskManagement block (or empty object).
 * @param {object} context Runtime context (`tradesTodayCount` or
 *   `tradesToday` array).
 */
export function checkMaxTradesPerDay(risk, context) {
    const max = risk.maxTradesPerDay;

    if (max === undefined || max === null) {
        return { passed: true };
    }

    assertFiniteNumber(max, "Maximum trades per day");

    if (!Number.isInteger(max) || max < 1) {
        throw new Error(
            `Invalid maximum trades per day: ${max}. ` +
                "Expected a positive integer."
        );
    }

    const source = context && typeof context === "object" ? context : {};
    let count = 0;

    if (Array.isArray(source.tradesToday)) {
        count = source.tradesToday.length;
    } else if (
        source.tradesTodayCount !== undefined &&
        source.tradesTodayCount !== null
    ) {
        assertFiniteNumber(source.tradesTodayCount, "Trades today count");

        if (
            !Number.isInteger(source.tradesTodayCount) ||
            source.tradesTodayCount < 0
        ) {
            throw new Error(
                "Invalid trades today count: expected a non-negative integer."
            );
        }

        count = source.tradesTodayCount;
    }

    if (count >= max) {
        return {
            passed: false,
            reason: RISK_REJECTION_REASONS.MAX_TRADES_PER_DAY_REACHED,
            detail: `Trades today (${count}) reached the maximum (${max}).`,
            current: count,
            max
        };
    }

    return { passed: true, current: count, max };
}

/**
 * Resolve the configured daily-loss limit to an absolute amount.
 *
 * @param {object} risk Strategy riskManagement block.
 * @param {number|undefined|null} dailyStartingEquity Needed for
 *   percentage interpretation.
 * @returns {number|null} Absolute limit, or null when unconfigured.
 * @throws On invalid configuration.
 */
function resolveDailyLossLimit(risk, dailyStartingEquity) {
    const percentRaw =
        risk.maxDailyLossPercent !== undefined &&
        risk.maxDailyLossPercent !== null
            ? risk.maxDailyLossPercent
            : risk.maxDailyLossType === "PERCENTAGE"
              ? risk.maxDailyLoss
              : null;

    if (percentRaw !== null) {
        assertFiniteNumber(percentRaw, "Maximum daily loss percent");

        if (!(percentRaw > 0)) {
            throw new Error(
                `Invalid maximum daily loss percent: ${percentRaw}. ` +
                    "Expected a number greater than 0."
            );
        }

        if (dailyStartingEquity === undefined || dailyStartingEquity === null) {
            throw new Error(
                "Missing daily starting equity: percentage daily-loss " +
                    "limit requires context.dailyStartingEquity."
            );
        }

        assertPositiveFiniteNumber(
            dailyStartingEquity,
            "Daily starting equity"
        );

        return (dailyStartingEquity * percentRaw) / 100;
    }

    const absolute = risk.maxDailyLoss;

    if (absolute === undefined || absolute === null) {
        return null;
    }

    assertNonNegativeFiniteNumber(absolute, "Maximum daily loss");

    return absolute;
}

/**
 * Resolve the current daily loss (positive = money lost) from whichever
 * equity/PnL context the caller provided.
 *
 * @param {object} context Runtime context.
 * @returns {number|null} Daily loss, or null when no usable context.
 * @throws On invalid (non-finite) context values.
 */
function resolveCurrentDailyLoss(context) {
    const source = context && typeof context === "object" ? context : {};
    const {
        dailyStartingEquity,
        currentEquity,
        dailyPnL,
        realizedDailyPnL,
        unrealizedPnL,
        unrealizedDailyPnL
    } = source;

    if (
        dailyStartingEquity !== undefined &&
        dailyStartingEquity !== null &&
        currentEquity !== undefined &&
        currentEquity !== null
    ) {
        assertFiniteNumber(dailyStartingEquity, "Daily starting equity");
        assertFiniteNumber(currentEquity, "Current equity");
        return dailyStartingEquity - currentEquity;
    }

    if (dailyPnL !== undefined && dailyPnL !== null) {
        assertFiniteNumber(dailyPnL, "Daily PnL");
        return -dailyPnL;
    }

    if (
        (realizedDailyPnL !== undefined && realizedDailyPnL !== null) ||
        (unrealizedPnL !== undefined && unrealizedPnL !== null) ||
        (unrealizedDailyPnL !== undefined && unrealizedDailyPnL !== null)
    ) {
        const realized =
            realizedDailyPnL !== undefined && realizedDailyPnL !== null
                ? assertFiniteNumber(realizedDailyPnL, "Realized daily PnL")
                : 0;
        const unrealized =
            unrealizedPnL !== undefined && unrealizedPnL !== null
                ? assertFiniteNumber(unrealizedPnL, "Unrealized PnL")
                : unrealizedDailyPnL !== undefined &&
                    unrealizedDailyPnL !== null
                  ? assertFiniteNumber(unrealizedDailyPnL, "Unrealized daily PnL")
                  : 0;
        return -(realized + unrealized);
    }

    return null;
}

/**
 * Maximum daily-loss gate. Per-trade stop loss and daily loss are
 * separate controls: this checks portfolio-level daily damage, not the
 * distance to any single stop.
 *
 * @param {object} risk Strategy riskManagement block (or empty object).
 * @param {object} context Runtime context (equity/PnL fields).
 * @throws On invalid configuration or missing context when a limit is set.
 */
export function checkMaxDailyLoss(risk, context) {
    const source = context && typeof context === "object" ? context : {};
    const limit = resolveDailyLossLimit(risk, source.dailyStartingEquity);

    if (limit === null) {
        return { passed: true };
    }

    const loss = resolveCurrentDailyLoss(source);

    if (loss === null) {
        throw new Error(
            "Missing daily PnL context: max daily loss is configured but " +
                "no equity/PnL context was provided (need dailyStartingEquity " +
                "+ currentEquity, dailyPnL, or realized/unrealized PnL)."
        );
    }

    if (loss >= limit) {
        return {
            passed: false,
            reason: RISK_REJECTION_REASONS.MAX_DAILY_LOSS_REACHED,
            detail:
                `Daily loss (${loss}) reached the limit (${limit}). ` +
                "New entries are blocked.",
            dailyLoss: loss,
            limit
        };
    }

    return { passed: true, dailyLoss: loss, limit };
}

/**
 * Read deployed (already-used) capital from the context.
 *
 * @param {object} context Runtime context (`deployedCapital`,
 *   `openNotional`, `currentAllocation`, or summed `openPositions`).
 * @returns {number}
 */
function readDeployedCapital(context) {
    const source = context && typeof context === "object" ? context : {};

    for (const key of ["deployedCapital", "openNotional", "currentAllocation", "allocatedCapital"]) {
        if (source[key] !== undefined && source[key] !== null) {
            assertNonNegativeFiniteNumber(source[key], "Deployed capital");
            return source[key];
        }
    }

    if (Array.isArray(source.openPositions)) {
        let total = 0;

        for (const position of source.openPositions) {
            if (!position || typeof position !== "object") {
                continue;
            }

            const notional =
                position.notional !== undefined && position.notional !== null
                    ? position.notional
                    : typeof position.quantity === "number" &&
                        typeof (position.entryPrice ?? position.averageEntryPrice) ===
                            "number"
                      ? position.quantity *
                        (position.entryPrice ?? position.averageEntryPrice)
                      : 0;

            assertNonNegativeFiniteNumber(notional, "Open position notional");
            total += notional;
        }

        return total;
    }

    return 0;
}

/**
 * Maximum capital-allocation gate: total deployed capital (existing +
 * proposed) must not exceed maxCapitalAllocation % of the portfolio.
 * This is different from position sizing (which sizes THIS trade).
 *
 * @param {object} risk Strategy riskManagement block (or empty object).
 * @param {object} context Runtime context (portfolio + deployed capital).
 * @param {number} newNotional Proposed trade notional (> 0).
 * @throws On invalid configuration or missing portfolio context.
 */
export function checkMaxCapitalAllocation(risk, context, newNotional) {
    const max = risk.maxCapitalAllocation;

    if (max === undefined || max === null) {
        return { passed: true };
    }

    assertFiniteNumber(max, "Maximum capital allocation");

    if (!(max > 0) || max > 100) {
        throw new Error(
            `Invalid maximum capital allocation: ${max}. ` +
                "Expected a percentage in (0, 100]."
        );
    }

    const source = context && typeof context === "object" ? context : {};
    const portfolioValue = source.portfolioValue ?? source.portfolio;

    if (portfolioValue === undefined || portfolioValue === null) {
        throw new Error(
            "Missing portfolio value: max capital allocation requires " +
                "context.portfolioValue."
        );
    }

    assertPositiveFiniteNumber(portfolioValue, "Portfolio value");
    assertPositiveFiniteNumber(newNotional, "New trade notional");

    const deployed = readDeployedCapital(source);
    const maxDeployed = (portfolioValue * max) / 100;
    const projected = deployed + newNotional;

    if (projected > maxDeployed) {
        return {
            passed: false,
            reason: RISK_REJECTION_REASONS.MAX_CAPITAL_ALLOCATION_REACHED,
            detail:
                `Projected allocation (${projected}) exceeds the maximum ` +
                `(${maxDeployed}, ${max}% of ${portfolioValue}).`,
            deployed,
            newNotional,
            projected,
            maxDeployed
        };
    }

    return { passed: true, deployed, newNotional, projected, maxDeployed };
}

/**
 * Read the last-trade timestamp from the context.
 *
 * @param {object} context Runtime context (`lastTradeTimestamp`,
 *   `lastExitTimestamp`, `lastEntryTimestamp`, `lastCloseTimestamp`).
 * @returns {number|null} Epoch ms, or null when no prior trade is known.
 */
function readLastTradeTimestamp(context) {
    const source = context && typeof context === "object" ? context : {};

    for (const key of [
        "lastTradeTimestamp",
        "lastExitTimestamp",
        "lastCloseTimestamp",
        "lastEntryTimestamp",
        "lastTradeAt",
        "lastTradeTime"
    ]) {
        if (source[key] !== undefined && source[key] !== null) {
            return toEpochMs(source[key], "Last trade timestamp");
        }
    }

    return null;
}

/**
 * Cooldown gate. Deterministic and backtestable: the current time comes
 * from `context.currentTimestamp` -- system time is never read here.
 *
 * @param {object} risk Strategy riskManagement block (or empty object).
 *   Cooldown shape: `{ enabled, value, unit: "SECONDS"|"MINUTES"|"HOURS" }`.
 * @param {object} context Runtime context (`currentTimestamp` required
 *   when cooldown is enabled).
 * @throws On invalid configuration or missing current timestamp.
 */
export function checkCooldown(risk, context) {
    const cooldown = risk.cooldown;

    if (
        cooldown === undefined ||
        cooldown === null ||
        cooldown.enabled === false
    ) {
        return { passed: true };
    }

    if (typeof cooldown !== "object" || Array.isArray(cooldown)) {
        throw new Error("Invalid cooldown configuration: expected an object.");
    }

    if (!cooldown.enabled) {
        return { passed: true };
    }

    assertFiniteNumber(cooldown.value, "Cooldown value");

    if (!(cooldown.value >= 0)) {
        throw new Error(
            `Invalid cooldown value: ${cooldown.value}. ` +
                "Expected a number greater than or equal to 0."
        );
    }

    if (cooldown.value === 0) {
        return { passed: true };
    }

    const cooldownMs = cooldown.value * cooldownUnitToMs(cooldown.unit);
    const source = context && typeof context === "object" ? context : {};
    const lastTrade = readLastTradeTimestamp(source);

    if (lastTrade === null) {
        return { passed: true };
    }

    if (
        source.currentTimestamp === undefined ||
        source.currentTimestamp === null
    ) {
        throw new Error(
            "Missing current timestamp: cooldown is enabled but " +
                "context.currentTimestamp was not provided."
        );
    }

    const now = toEpochMs(source.currentTimestamp, "Current timestamp");

    if (now < lastTrade) {
        throw new Error(
            "Invalid timestamps: currentTimestamp is before lastTradeTimestamp."
        );
    }

    const elapsed = now - lastTrade;

    // Boundary is inclusive: at exactly cooldown expiry the trade is allowed.
    if (elapsed < cooldownMs) {
        return {
            passed: false,
            reason: RISK_REJECTION_REASONS.COOLDOWN_ACTIVE,
            detail:
                `Cooldown active: ${elapsed}ms elapsed of ${cooldownMs}ms ` +
                `(${cooldown.value} ${cooldown.unit}).`,
            elapsedMs: elapsed,
            cooldownMs,
            remainingMs: cooldownMs - elapsed
        };
    }

    return { passed: true, elapsedMs: elapsed, cooldownMs };
}

export default {
    RISK_REJECTION_REASONS,
    readRiskBlock,
    checkMaxPositions,
    checkMaxTradesPerDay,
    checkMaxDailyLoss,
    checkMaxCapitalAllocation,
    checkCooldown
};
