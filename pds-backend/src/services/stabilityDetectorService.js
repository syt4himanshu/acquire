const {
    STABILITY_MIN_READINGS,
    STABILITY_WINDOW_MS,
    STABILITY_MAX_SPREAD_GRAMS,
    CAPTURE_MAX_READING_AGE_MS,
    CAPTURE_MAX_CLOCK_SKEW_MS,
    MIN_VALID_GRAMS,
    MAX_VALID_GRAMS,
} = require("../config/iot");

// Keeps only readings within the last `windowMs` of `nowMs`. Readings must
// have a numeric `takenAtMs` field (epoch ms).
const filterToWindow = (readings, nowMs, windowMs = STABILITY_WINDOW_MS) =>
    readings.filter((reading) => nowMs - reading.takenAtMs <= windowMs);

// Pure evaluation of the auto-confirm rule against an already-windowed set
// of readings (see filterToWindow above) — no time-dependence, so this is
// directly unit-testable: stable iff the window has enough readings, they're
// tightly clustered, and their mean sits within tolerance of what's expected.
const isStable = (windowReadings, entitledGrams, toleranceGrams) => {
    if (!Array.isArray(windowReadings) || windowReadings.length < STABILITY_MIN_READINGS) {
        return false;
    }

    const values = windowReadings.map((reading) => reading.gramsInt);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

    return (max - min) <= STABILITY_MAX_SPREAD_GRAMS && Math.abs(mean - entitledGrams) <= toleranceGrams;
};

// PROTOTYPE: single-reading capture. A capture is accepted from the newest
// reading alone, so it is NOT proof of a settled weight. The multi-sample rule
// above (isStable) is still what moves a session into 'confirming'; this only
// decides whether the latest value is usable for a capture right now.
//
// `latest` is the newest reading ({ gramsInt, takenAtMs }) or null. Returns
// { ok: true, grams } or { ok: false, code, message } with a stable, specific
// code the shopkeeper UI and the API can show.
const evaluateCaptureReading = (latest, nowMs, entitledGrams, toleranceGrams) => {
    if (!latest) {
        return {
            ok: false,
            code: "IOT_MEASUREMENT_MISSING",
            message: "No scale reading has been received for this session",
        };
    }

    const ageMs = nowMs - latest.takenAtMs;
    if (ageMs > CAPTURE_MAX_READING_AGE_MS || ageMs < -CAPTURE_MAX_CLOCK_SKEW_MS) {
        return {
            ok: false,
            code: "IOT_MEASUREMENT_STALE",
            message: "The latest scale reading is too old. Wait for a fresh reading and try again",
        };
    }

    const grams = latest.gramsInt;
    // Zero is rejected explicitly: an empty pan is never a measurement of rice
    // or wheat, even if the entitlement were ever set to a value near zero.
    if (!Number.isInteger(grams) || grams <= 0 || grams < MIN_VALID_GRAMS || grams > MAX_VALID_GRAMS) {
        return {
            ok: false,
            code: "IOT_MEASUREMENT_INVALID",
            message: "The latest scale reading is not a valid weight",
        };
    }

    if (Math.abs(grams - entitledGrams) > toleranceGrams) {
        return {
            ok: false,
            code: "IOT_MEASUREMENT_OUT_OF_TOLERANCE",
            message: `The weight is outside the allowed ${toleranceGrams} g tolerance`,
        };
    }

    return { ok: true, grams };
};

module.exports = { isStable, filterToWindow, evaluateCaptureReading };
