/**
 * iot.js
 *
 * Named thresholds for the IoT weighing subsystem. Centralised here (mirrors
 * blockchainHealth.js's pattern) rather than scattered as magic numbers in
 * iotController.js/iotSocketServer.js.
 */
module.exports = {
    // ---- HARDWARE SAFETY LAYER -------------------------------------------
    // "Is this physical measurement safe/credible for the sensor?"
    //
    // This is NOT the business allocation rule (that is
    // MAX_DISPENSE_TRANSACTION_GRAMS = 4000 in config/allocation.js) and NOT
    // the measurement-deviation rule (that is the commodity_tolerances
    // table). All three stay separate on purpose:
    //
    //   3900 g -> hardware-safe, business-valid for a 4000 g allocation
    //   4100 g -> hardware-safe, business-invalid (never auto-confirms)
    //   4900 g -> hardware-safe, business-invalid
    //   5100 g -> HARDWARE-INVALID: frame rejected, recalibration counter++
    //
    // ASSUMPTION, stated because it cannot be established from the repo:
    // iot-device/README.md is referenced by the firmware for the wiring and
    // calibration procedure but does not exist here, so there is no datasheet,
    // load-cell model or ADC gain recorded anywhere. What IS established:
    // an HX711 24-bit amplifier, a calibration factor derived from an
    // operator-supplied reference weight, and a 5 kg cell. A standard 5 kg
    // strain-gauge cell is rated for 5000 g, tolerates ~120% (6000 g) without
    // permanent damage and is destroyed around ~150% (7500 g).
    //
    // The ceiling is therefore set at the RATED CAPACITY rather than at the
    // safe-overload margin: a reading above the cell's rating is not credible
    // measurement data even though it is not yet physically destructive, and
    // stopping there leaves ~1000 g of margin before any risk of deforming
    // the strain gauge. The previous value of 10000 g was twice the cell's
    // rating and would have accepted readings the sensor cannot produce
    // meaningfully.
    LOAD_CELL_RATED_GRAMS: 5000,

    MIN_VALID_GRAMS: 0,
    // Frames outside [MIN_VALID_GRAMS, MAX_VALID_GRAMS] are rejected, not
    // persisted, and counted toward the needs_recalibration threshold below.
    MAX_VALID_GRAMS: 5000,

    // Phase 2 — a device that racks up this many rejected (out-of-range)
    // readings within this rolling window is flagged needs_recalibration.
    RECALIBRATION_REJECT_THRESHOLD: 3,
    RECALIBRATION_REJECT_WINDOW_MS: 60_000,

    // Phase 2 — auto-confirm stability rule (stabilityDetectorService.js).
    // Window must contain at least this many readings...
    STABILITY_MIN_READINGS: 3,
    // ...spanning at most this window...
    STABILITY_WINDOW_MS: 3_000,
    // ...with a max-min spread no more than this...
    STABILITY_MAX_SPREAD_GRAMS: 5,

    // Phase 2 — once the stability rule first holds, how long the
    // "confirming" countdown runs before committing (cancelled if the rule
    // breaks before this elapses).
    CONFIRM_COUNTDOWN_MS: 3_000,

    // Phase 3 — device fleet "stale" threshold: no live WS connection, but
    // last_seen_at is more recent than this -> likely mid-reconnect rather
    // than genuinely offline.
    DEVICE_STALE_THRESHOLD_MS: 2 * 60 * 1000,

    // USB/serial phase — how often a streaming device's last_seen_at is
    // refreshed (deviceRegistryService.touchLastSeenThrottled). Must stay well
    // under DEVICE_STALE_THRESHOLD_MS above, or a device that is genuinely
    // connected would age into 'stale' between touches. 30 s against a 120 s
    // threshold leaves 4 touches of margin.
    //
    // Not per-reading: the ESP32 samples at 10 Hz and the fleet view tolerates
    // minutes of staleness, so an UPDATE per sample would be pure write
    // amplification.
    LAST_SEEN_TOUCH_INTERVAL_MS: 30 * 1000,

    // USB/serial phase — the ESP32 is wired to the PC, so a dropped USB cable
    // or a closed bridge is detected by the socket closing, not by silence.
    // This is the belt-and-braces sweep for a bridge process that was SIGKILLed
    // or a laptop that slept: no frame of any kind (reading, heartbeat, ping)
    // within this window and the connection is terminated, which fires the
    // 'close' handler and flips the device to OFFLINE.
    //
    // The bridge sends a heartbeat every BRIDGE heartbeat interval (15 s, see
    // iot-bridge/src/config.js), so 45 s is 3 missed heartbeats.
    DEVICE_IDLE_TIMEOUT_MS: 45 * 1000,

    // Phase 3 — a rotated device token keeps working for this long
    // afterward, so a device already mid-reconnect-backoff with the old
    // token isn't hard-locked out the instant an admin rotates it.
    TOKEN_ROTATION_GRACE_MS: 5 * 60 * 1000,

    // Phase 3 — per-IP rate limit on /ws/iot connection *attempts*
    // (upgrade requests), separate from express-rate-limit since that
    // middleware can't run on a raw http.Server 'upgrade' event.
    WS_UPGRADE_RATE_LIMIT_WINDOW_MS: 60 * 1000,
    WS_UPGRADE_RATE_LIMIT_MAX: 20,

    // Phase 3 — how often the streaming anomaly-rules engine runs.
    ANOMALY_RULES_INTERVAL_MINUTES: 5,
};
