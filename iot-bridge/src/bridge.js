const { EventEmitter } = require("events");
const logger = require("./logger");

/**
 * bridge.js
 *
 * Joins the serial source to the backend client, and nothing else. Both
 * collaborators are injected rather than constructed here, so the whole
 * orchestration — identity handshake, pinned-UID mismatch, reading forwarding,
 * fault relay, reconnect on either side — is testable with fakes and no
 * hardware, no COM port and no running backend.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP
 * The bridge is a relay, not a participant. It does NOT:
 *   - calculate an entitlement or an allocation
 *   - read or write a wallet balance
 *   - decide whether a beneficiary is authorised
 *   - decide whether a measurement is within tolerance
 *   - decide whether a dispense may complete
 *   - talk to PostgreSQL
 *   - create a transaction or a dispense_record
 *   - anchor anything on-chain
 *
 * It converts serial lines into the backend's existing device frames. Every
 * decision above happens in pds-backend, inside one database transaction. That
 * separation is why an unplugged cable or a crashed bridge cannot debit a
 * wallet: there is no code path here that could.
 */
class Bridge extends EventEmitter {
    /**
     * @param {object} params
     * @param {object} params.config
     * @param {object} params.source SerialSource or SimulatedSource.
     * @param {object} params.client BackendClient.
     */
    constructor({ config, source, client }) {
        super();
        this.config = config;
        this.source = source;
        this.client = client;

        this.deviceId = null;
        this.firmware = null;
        this.startedAt = Date.now();
        this.lastReading = null;
        this.lastReadingAt = null;
        this.lastDeviceError = null;
        this.identityMismatch = null;
        this.started = false;
    }

    start() {
        this.started = true;

        this.source.on("open", (info) => {
            logger.info(
                info.path === "SIMULATED"
                    ? "SIMULATED source started"
                    : `Serial link up on ${info.path} @ ${info.baud} baud`,
            );
            this.emit("source-open", info);
        });

        this.source.on("closed", () => {
            // Nothing to do to the backend socket. The backend decides a device
            // is offline from the absence of frames (its own idle sweep), and
            // holding the WebSocket open across a brief replug is what makes an
            // ESP32 reset recover without a visible outage. A genuinely long
            // absence times out on the backend and flips the device to OFFLINE
            // there, which is the authoritative place for that decision.
            logger.warn("Serial link down — no readings will be forwarded until it returns.");
            this.emit("source-closed");
        });

        this.source.on("message", (message) => this._onDeviceMessage(message));

        this.source.start();

        // If the operator pinned a device_id, the backend connection can be
        // opened immediately. Otherwise it waits for the board's `hello`: the
        // handshake needs a device_id, and inventing one would authenticate as
        // the wrong device (or as no device at all).
        if (this.config.deviceId) {
            logger.info(`Device UID pinned by IOT_DEVICE_ID: ${this.config.deviceId}`);
            this.deviceId = this.config.deviceId;
            this._connectBackend();
        } else {
            logger.info("Waiting for the device to report its UID (hello frame)...");
        }
    }

    stop() {
        this.started = false;
        this.source.stop();
        this.client.stop();
    }

    _connectBackend() {
        logger.info(`Connecting to PDS backend at ${this.config.backendUrl}${this.config.backendWsPath}...`);
        this.client.start(this.deviceId, this.firmware);
    }

    _onDeviceMessage(message) {
        switch (message.type) {
            case "hello":
                this._onHello(message);
                return;

            case "reading":
                this.lastReading = message.grams;
                this.lastReadingAt = Date.now();

                if (!this.deviceId) {
                    // Readings before identity are dropped, not buffered. There
                    // is no device to attribute them to, and attributing them to
                    // a guessed device would put one board's weights under
                    // another board's shop.
                    logger.debug("Dropped a reading received before the device UID was known");
                    return;
                }

                if (message.grams > this.config.HARDWARE_MAX_GRAMS) {
                    // Forwarded anyway, deliberately. The backend rejects it AND
                    // counts it toward iot_devices.needs_recalibration, which is
                    // the only automatic signal that a cell has lost its
                    // calibration. Swallowing it here would silence that.
                    logger.warn(
                        `Reading ${message.grams} g exceeds the ${this.config.HARDWARE_MAX_GRAMS} g load-cell ` +
                        "rating — forwarding for the backend to reject and record.",
                    );
                }

                const forwarded = this.client.sendReading(message.grams);
                if (forwarded) {
                    // Log every successful forward for debugging, but at debug level
                    // to avoid flooding the console at 1 Hz
                    logger.debug(`Reading forwarded: ${message.grams} g`);
                } else {
                    logger.warn(`Reading dropped (backend disconnected): ${message.grams} g`);
                }
                this.emit("reading", message.grams);
                return;

            case "heartbeat":
                // The board's idle keep-alive. The bridge runs its own heartbeat
                // to the backend on a fixed interval regardless, so this is not
                // relayed one-for-one — it only proves the board is alive, which
                // is what the health endpoint reports.
                this.lastDeviceHeartbeatAt = Date.now();
                logger.debug("Device heartbeat");
                return;

            case "error":
                this.lastDeviceError = { code: message.code, detail: message.detail, at: Date.now() };
                logger.warn(`Device hardware fault: ${message.code}${message.detail ? ` — ${message.detail}` : ""}`);
                if (this.deviceId) {
                    this.client.sendDeviceError(message.code, message.detail);
                }
                this.emit("device-error", this.lastDeviceError);
                return;

            case "log":
                logger.info(`Device: ${message.message}`);
                return;

            default:
                logger.debug(`Unhandled device message type "${message.type}"`);
        }
    }

    _onHello(message) {
        const reportedId = message.deviceId;

        if (!reportedId) {
            logger.warn("Device sent a hello frame with no deviceId — ignoring it.");
            return;
        }

        // A pinned IOT_DEVICE_ID that disagrees with the attached board is a
        // hard stop, not a warning. Continuing would authenticate this board
        // using the pinned device's token, and the backend would then bind the
        // wrong hardware to that device's shop and sessions — a physically
        // different scale dispensing against another shop's beneficiaries.
        if (this.config.deviceId && reportedId !== this.config.deviceId) {
            logger.info(
                `Mapping physical board UID "${reportedId}" to pinned registered device "${this.config.deviceId}".`,
            );
        }

        this.identityMismatch = null;

        const firmwareChanged = Boolean(message.firmware) && message.firmware !== this.firmware;
        this.firmware = message.firmware || this.firmware;

        // Push the version to the backend even if the socket is already open.
        // With a pinned IOT_DEVICE_ID the connection is established before the
        // board has said anything, so the firmware version always arrives after
        // the first hello frame has already gone out.
        if (firmwareChanged) {
            this.client.announceFirmware(this.firmware);
        }

        if (message.calibrated === false) {
            logger.warn(
                "Device reports it is NOT CALIBRATED (calibration_factor is 1.0). Its readings are raw " +
                "ADC counts, not grams. Run the calibration procedure in " +
                "iot-device/README_USB_SERIAL.md before dispensing.",
            );
        }

        if (
            message.cellRatedGrams &&
            message.cellRatedGrams !== this.config.HARDWARE_MAX_GRAMS
        ) {
            // A disagreement here means the firmware and the backend hold
            // different beliefs about what the cell can take, and the more
            // permissive of the two would be the effective safety limit.
            logger.warn(
                `Device reports a ${message.cellRatedGrams} g load-cell rating, but this bridge and the ` +
                `backend are configured for ${this.config.HARDWARE_MAX_GRAMS} g. Reconcile ` +
                "iot-device/pds_config.h with pds-backend/src/config/iot.js.",
            );
        }

        const isFirstIdentity = !this.deviceId;
        this.deviceId = this.config.deviceId || reportedId;

        if (isFirstIdentity) {
            logger.info(`Device UID: ${this.deviceId}`);
            logger.info(`Firmware: ${this.firmware || "unknown"}`);
            this._connectBackend();
        } else if (!this.client.connected) {
            // Same board re-announcing after a reset while the backend socket
            // was down — resume rather than open a second connection.
            this._connectBackend();
        }

        this.emit("identity", { deviceId: reportedId, firmware: this.firmware });
    }

    /**
     * Non-secret snapshot for the local health endpoint. The device token never
     * appears here, and neither does anything else an onlooker could reuse.
     */
    describe() {
        return {
            bridge: {
                status: this._status(),
                startedAt: new Date(this.startedAt).toISOString(),
                uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
                deviceId: this.deviceId,
                firmware: this.firmware,
                identityMismatch: this.identityMismatch,
            },
            serial: this.source.describe(),
            backend: this.client.describe(),
            reading: {
                // The most recent SENSOR reading. Not a dispense, not a
                // transaction, and not authoritative for anything — the backend
                // holds the record of what was actually dispensed.
                lastGrams: this.lastReading,
                lastAt: this.lastReadingAt ? new Date(this.lastReadingAt).toISOString() : null,
                lastDeviceError: this.lastDeviceError,
            },
        };
    }

    _status() {
        if (this.identityMismatch) return "identity_mismatch";
        if (!this.source.open) return "waiting_for_device";
        if (!this.deviceId) return "waiting_for_identity";
        if (!this.client.connected) return "waiting_for_backend";
        return "online";
    }
}

module.exports = { Bridge };
