// TEMPORARY stability diagnostics for the weighing -> confirming transition.
// Set STABILITY_DEBUG to false (or delete the calls in ws/iotSocketServer.js)
// once the cause is confirmed. Logs only numbers and ids: no tokens, no
// personal data.
const STABILITY_DEBUG = true;
const appLogger = require("../config/logger");

const round2 = (n) => Math.round(n * 100) / 100;
const { STABILITY_WINDOW_MS, STABILITY_MIN_READINGS, STABILITY_MAX_SPREAD_GRAMS } = require("../config/iot");

// readings: the window actually evaluated (already filtered to STABILITY_WINDOW_MS).
const logStabilityEvaluation = ({
  logger,
  deviceId,
  sessionId,
  state,
  readings,
  nowMs,
  entitledGrams,
  toleranceGrams,
  stable,
  decision,
}) => {
  if (!STABILITY_DEBUG) return;
  const values = readings.map((r) => r.gramsInt);
  const count = values.length;
  const max = count ? Math.max(...values) : null;
  const min = count ? Math.min(...values) : null;
  const mean = count ? round2(values.reduce((a, b) => a + b, 0) / count) : null;
  logger.info("[IOT-STABILITY-DEBUG] evaluate", {
    deviceId,
    sessionId,
    state,
    windowMs: STABILITY_WINDOW_MS,
    minReadingsRequired: STABILITY_MIN_READINGS,
    maxSpreadGrams: STABILITY_MAX_SPREAD_GRAMS,
    sampleCount: count,
    // Age of each sample in the window, newest first. Shows the real cadence.
    sampleAgesMs: readings.map((r) => nowMs - r.takenAtMs).sort((a, b) => a - b),
    spreadGrams: count ? max - min : null,
    meanGrams: mean,
    entitledGrams,
    toleranceGrams,
    meanDiffGrams: mean === null ? null : round2(mean - entitledGrams),
    stable,
    decision,
  });
};

module.exports = { logStabilityEvaluation, STABILITY_DEBUG };

// Mirrors isStable's checks so the log can say WHICH condition failed.
// Diagnostic only: the real decision is still made by stabilityDetectorService.
const whyNotStable = (readings, entitledGrams, toleranceGrams) => {
  if (readings.length < STABILITY_MIN_READINGS) {
    return `too_few_samples(${readings.length}<${STABILITY_MIN_READINGS})`;
  }
  const values = readings.map((r) => r.gramsInt);
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > STABILITY_MAX_SPREAD_GRAMS) {
    return `spread_too_wide(${spread}>${STABILITY_MAX_SPREAD_GRAMS})`;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (Math.abs(mean - entitledGrams) > toleranceGrams) {
    return `mean_out_of_tolerance(${round2(mean - entitledGrams)}g vs ±${toleranceGrams})`;
  }
  return null;
};

module.exports.whyNotStable = whyNotStable;

// Bus and WebSocket delivery of STATE events only (readings are too frequent).
// stage: "publish" | "replay" | "deliver" | "deliver_skipped" | "subscribe_frame"
const logStateDelivery = ({ stage, sessionId, state, extra = {} }) => {
  if (!STABILITY_DEBUG) return;
  appLogger.info(`[IOT-STABILITY-DEBUG] ${stage}`, { sessionId, state, ...extra });
};

module.exports.logStateDelivery = logStateDelivery;
