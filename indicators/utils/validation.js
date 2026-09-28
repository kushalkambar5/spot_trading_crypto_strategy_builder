/**
 * Reusable validation helpers for the indicator calculation layer.
 *
 * Pure module: no database, network, exchange, strategy, order,
 * backtest, or frontend logic.
 *
 * Rules:
 * - Defaults apply only when a setting is omitted (undefined/null).
 * - Invalid user settings are never silently replaced with defaults;
 *   they throw descriptive errors.
 */

import { SUPPORTED_SOURCES } from "./source.js";

/**
 * Validate that a value is a positive integer (>= 1).
 *
 * @param {unknown} value
 * @param {string} fieldName Used verbatim in the error message,
 *   e.g. "EMA period" -> "EMA period must be a positive integer."
 */
export function validatePositiveInteger(value, fieldName) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`${fieldName} must be a positive integer.`);
    }

    return value;
}

/**
 * Validate that a value is a positive finite number (> 0).
 *
 * @param {unknown} value
 * @param {string} fieldName Used verbatim in the error message.
 */
export function validatePositiveNumber(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${fieldName} must be a positive number.`);
    }

    return value;
}

/**
 * Validate a price-source selection.
 *
 * @param {unknown} source
 * @throws `Unsupported source: <source>.` when invalid.
 */
export function validateSource(source) {
    if (typeof source !== "string" || !SUPPORTED_SOURCES.includes(source)) {
        throw new Error(`Unsupported source: ${source}.`);
    }

    return source;
}

/**
 * Ensure a settings object exists and contains the given required fields.
 * Intended for settings that have no default value.
 *
 * @param {unknown} settings
 * @param {string[]} fields
 * @throws When settings is not an object or a field is missing.
 */
export function validateRequiredSettings(settings, fields) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw new Error("Settings must be an object.");
    }

    for (const field of fields) {
        if (settings[field] === undefined || settings[field] === null) {
            throw new Error(`${field} is required.`);
        }
    }

    return settings;
}

/**
 * Validate the candle container itself (not individual candles).
 * Empty arrays are valid and produce empty output series.
 *
 * @param {unknown} candles
 * @throws When candles is not an array.
 */
export function validateCandles(candles) {
    if (!Array.isArray(candles)) {
        throw new Error("Candles must be an array.");
    }

    return candles;
}

/**
 * Assert a finite number (used for candle/volume/timestamp checks).
 *
 * @param {unknown} value
 * @param {string} fieldName Used verbatim in the error message.
 */
export function assertFiniteNumber(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${fieldName} must be a finite number.`);
    }

    return value;
}

/**
 * Merge user settings over defaults.
 * Defaults apply only when a key is omitted (undefined).
 * Unknown extra keys are ignored so strategy payloads carrying
 * metadata (e.g. timeframe) cannot leak into calculations.
 *
 * @param {unknown} settings User settings (null/undefined allowed).
 * @param {object} defaults Default settings for the indicator.
 * @returns {object} Resolved settings (new object, input never mutated).
 */
export function applyDefaults(settings, defaults) {
    const input =
        settings === undefined || settings === null ? {} : settings;

    if (typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Settings must be an object.");
    }

    const resolved = { ...defaults };

    for (const key of Object.keys(defaults)) {
        if (input[key] !== undefined) {
            resolved[key] = input[key];
        }
    }

    return resolved;
}

export default {
    validatePositiveInteger,
    validatePositiveNumber,
    validateSource,
    validateRequiredSettings,
    validateCandles,
    assertFiniteNumber,
    applyDefaults
};
