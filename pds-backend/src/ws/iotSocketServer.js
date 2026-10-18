const { WebSocketServer } = require("ws");
const logger = require("../config/logger");
const deviceRegistryService = require("../services/deviceRegistryService");
const liveReadingBus = require("../services/liveReadingBus");
const iotController = require("../controllers/iotController");
const {
  deviceReadingFrameSchema,
  deviceHelloFrameSchema,
  deviceHeartbeatFrameSchema,
  deviceErrorFrameSchema,
} = require("../validators/iotFrames");
const dispenseSessionService = require("../services/dispenseSessionService");
const dispenseSessionBus = require("../services/dispenseSessionBus");
const stabilityDetectorService = require("../services/stabilityDetectorService");
const { logStabilityEvaluation, whyNotStable } = require("../services/stabilityDebug"); // TEMPORARY
const deviceConnectionRegistry = require("../services/deviceConnectionRegistry");
const metrics = require("../config/metrics");
const { DEVICE_IDLE_TIMEOUT_MS } = require("../config/iot");

// The client — the USB IoT bridge (iot-bridge/), or the Wi-Fi firmware's
// ws_client.cpp — sends a heartbeat every 15s. If nothing at all (reading,
// heartbeat or ping) has arrived for 3 missed intervals, treat the socket as
// dead and terminate it rather than waiting on TCP to notice. Terminating
// fires the 'close' handler, which is what actually flips the device to
// OFFLINE and releases any session it was gating.
const STALE_SWEEP_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = DEVICE_IDLE_TIMEOUT_MS;

const extractSubprotocol = (req) => {
  const header = req.headers["sec-websocket-protocol"];
  if (!header) return null;
  return header.split(",")[0].trim() || null;
};

// Creates the device-facing WebSocket server for /ws/iot. `noServer: true`
// because it shares the existing Express HTTP server (src/server.js) rather
// than listening on its own port; the returned `handleUpgrade` is called from
// server.js's single 'upgrade' dispatcher once the URL path matches.
const createIotSocketServer = () => {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req, device) => {
    ws.lastActivity = Date.now();

    // Phase 2 dispense-session gating state, scoped to this one device
    // connection (one ESP32 = one connection = at most one active
    // session at a time) — no module-level map needed, and it's
    // naturally garbage-collected when the connection closes.
    let currentSessionId = null;
    let sessionReadings = [];
    const resetSessionTracking = () => {
      currentSessionId = null;
      sessionReadings = [];
    };

    logger.info("[IoT] Device connected", {
      deviceId: device.device_id,
      shopId: device.shop_id,
    });

    deviceConnectionRegistry.registerConnection(device.device_id, ws);
    if (
      deviceConnectionRegistry.consumePendingRecalibration(device.device_id)
    ) {
      ws.send(JSON.stringify({ type: "recalibrate" }));
      logger.info("[IoT] Resent queued recalibration request", {
        deviceId: device.device_id,
      });
    }

    deviceRegistryService.touchLastSeen(device.device_id).catch((err) => {
      logger.error("[IoT] Failed to update last_seen_at", {
        deviceId: device.device_id,
        message: err.message,
      });
    });

    liveReadingBus.publish(device.shop_id, {
      type: "device_status",
      online: true,
      deviceId: device.device_id,
    });

    ws.on("ping", () => {
      ws.lastActivity = Date.now();
    });

    // ---- FRAME HANDLERS ---------------------------------------------
    // One handler per frame type, each validated against its own schema in
    // validators/iotFrames.js. Anything unrecognised or malformed is
    // dropped with a log line; a device frame never crashes the socket.
    //
    // No handler reads a business field off the frame. Shop comes from the
    // authenticated `device` row, session from dispense_sessions, and
    // entitlement from the session — a device that asserted any of those
    // would be asserting its own authorisation.

    // `hello` — sent once per connection by the USB bridge (or the Wi-Fi
    // firmware) right after the handshake. Its only persistent effect is
    // recording the firmware version the board reported over serial.
    const handleHello = (frame) => {
      const { error, value } = deviceHelloFrameSchema.validate(frame);
      if (error) {
        logger.warn("[IoT] Dropped invalid hello frame", {
          deviceId: device.device_id,
          message: error.message,
        });
        return;
      }

      logger.info("[IoT] Device hello", {
        deviceId: device.device_id,
        shopId: device.shop_id,
        firmware: value.firmware,
        transport: value.transport,
      });

      deviceRegistryService
        .recordFirmwareVersion(device.device_id, value.firmware)
        .catch((err) =>
          logger.error("[IoT] Failed to record firmware version", {
            deviceId: device.device_id,
            message: err.message,
          }),
        );
    };

    // `heartbeat` — keeps last_seen_at advancing while the scale sits idle.
    // Deliberately NOT persisted as a 0 g reading: sensor_readings is the
    // measurement log, and a heartbeat is not a measurement.
    const handleHeartbeat = (frame) => {
      const { error } = deviceHeartbeatFrameSchema.validate(frame);
      if (error) {
        logger.warn("[IoT] Dropped invalid heartbeat frame", {
          deviceId: device.device_id,
          message: error.message,
        });
        return;
      }
      deviceRegistryService.touchLastSeenThrottled(device.device_id);
    };

    // `error` — the hardware reporting its own fault (overload, cell
    // disconnected/reversed, uncalibrated). Surfaced to the shop's live
    // view so an admin/shopkeeper sees why readings stopped, and counted
    // toward the needs_recalibration signal for a sensor fault. It carries
    // no grams value, so it can never be mistaken for a dispense.
    const handleDeviceError = async (frame) => {
      const { error, value } = deviceErrorFrameSchema.validate(frame);
      if (error) {
        logger.warn("[IoT] Dropped invalid error frame", {
          deviceId: device.device_id,
          message: error.message,
        });
        return;
      }

      logger.warn("[IoT] Device reported a hardware fault", {
        deviceId: device.device_id,
        code: value.code,
        detail: value.detail,
      });

      // An overload/underrange fault means the cell produced a value
      // outside its credible range — the same signal an out-of-range
      // frame carries, so it feeds the same recalibration counter.
      if (value.code === "OVERLOAD" || value.code === "SENSOR_FAULT") {
        iotController.recordRejectionAndMaybeFlag(device.device_id);
      }

      liveReadingBus.publish(device.shop_id, {
        type: "device_error",
        deviceId: device.device_id,
        code: value.code,
        detail: value.detail,
      });

      try {
        const session =
          await dispenseSessionService.findAttachedSessionForDevice(
            device.device_id,
          );
        if (session) {
          dispenseSessionBus.publish(session.id, {
            type: "device_error",
            code: value.code,
            detail: value.detail,
          });
        }
      } catch (err) {
        logger.error(
          "[IoT] Failed to relay hardware fault to the active session",
          {
            deviceId: device.device_id,
            message: err.message,
          },
        );
      }
    };

    const handleReading = async (frame) => {
      const { error, value } = deviceReadingFrameSchema.validate(frame);
      if (error) {
        logger.warn("[IoT] Dropped invalid frame", {
          deviceId: device.device_id,
          message: error.message,
        });
        // The sanity-ceiling rejection counter needs to see frames
        // rejected here too — Joi's own max on `grams`
        // (MAX_VALID_GRAMS, config/iot.js) means out-of-range readings
        // are normally caught at this layer, never reaching
        // iotController.persistReading's own check.
        if (error.details?.some((detail) => detail.path.includes("grams"))) {
          iotController.recordRejectionAndMaybeFlag(device.device_id);
        }
        return;
      }

      deviceRegistryService.touchLastSeenThrottled(device.device_id);

      const takenAt = new Date(value.ts);

      // Phase 2 — dispense-session gating. Looked up fresh each
      // reading (cheap, indexed on (device_id, state)) rather than
      // cached, since attach/cancel happen over HTTP and this is the
      // simplest way to always see current truth. Looked up *before*
      // persisting so the real session UUID (not the device frame's
      // own always-null sessionId — Phase 1 firmware has no concept
      // of sessions) gets stamped onto sensor_readings.session_id,
      // which Phase 3's session-forensics reading trace depends on.
      const session = await dispenseSessionService.findAttachedSessionForDevice(
        device.device_id,
      );

      const result = await iotController.persistReading(
        device.device_id,
        value.grams,
        session ? session.id : null,
        takenAt,
      );

      if (!result.success) {
        logger.warn("[IoT] Reading rejected", {
          deviceId: device.device_id,
          error: result.error,
        });
        return;
      }

      metrics.readingsCounter.inc({ device_id: device.device_id });

      liveReadingBus.publish(result.shopId, {
        type: "reading",
        deviceId: device.device_id,
        gramsInt: result.reading.grams_int,
        takenAt: result.reading.taken_at,
      });

      if (!session) {
        if (currentSessionId) {
          resetSessionTracking();
        }
        return;
      }

      if (session.id !== currentSessionId) {
        resetSessionTracking();
        currentSessionId = session.id;
      }

      if (session.state === "attached") {
        await dispenseSessionService.beginWeighing(session.id);
      }

      const nowMs = Date.now();
      sessionReadings.push({ gramsInt: value.grams, takenAtMs: nowMs });
      sessionReadings = stabilityDetectorService.filterToWindow(
        sessionReadings,
        nowMs,
      );

      dispenseSessionBus.publish(session.id, {
        type: "reading",
        gramsInt: value.grams,
        takenAt: takenAt.toISOString(),
      });

      const stable = stabilityDetectorService.isStable(
        sessionReadings,
        session.entitled_grams,
        session.tolerance_grams,
      );

      // TEMPORARY stability diagnostics (see services/stabilityDebug.js).
      const stableReason = stable
        ? null
        : whyNotStable(sessionReadings, session.entitled_grams, session.tolerance_grams);
      logStabilityEvaluation({
        logger,
        deviceId: device.device_id,
        sessionId: session.id,
        state: session.state,
        readings: sessionReadings,
        nowMs,
        entitledGrams: session.entitled_grams,
        toleranceGrams: session.tolerance_grams,
        stable,
        decision: stable
          ? session.state === "confirming"
            ? "already_confirming"
            : "begin_confirming"
          : session.state === "confirming"
          ? `revert_to_weighing:${stableReason}`
          : `not_stable:${stableReason}`,
      });

      // Debug logging for stability detection
      logger.debug("[IoT] Stability check", {
        deviceId: device.device_id,
        sessionId: session.id,
        readingsCount: sessionReadings.length,
        isStable: stable,
        currentState: session.state,
        entitledGrams: session.entitled_grams,
        toleranceGrams: session.tolerance_grams,
        latestGrams: value.grams,
      });

      if (stable && session.state !== "confirming") {
        logger.info("[IoT] Weight stable - transitioning to confirming state", {
          deviceId: device.device_id,
          sessionId: session.id,
          readingsCount: sessionReadings.length,
        });
        const began = await dispenseSessionService.beginConfirming(session.id);
        logger.info("[IOT-STABILITY-DEBUG] beginConfirming", {
          deviceId: device.device_id,
          sessionId: session.id,
          applied: began,
          reason: began ? "row_was_weighing" : "row_was_not_weighing_or_gone",
        });
        if (began) {
          const sessionIdAtConfirmStart = session.id;
          dispenseSessionBus.publish(session.id, {
            type: "state",
            state: "confirming",
          });
          logger.info(
            "[IoT] Stable measurement awaits explicit Phase 1 capture",
            {
              deviceId: device.device_id,
              sessionId: sessionIdAtConfirmStart,
            },
          );
        }
      } else if (!stable && session.state === "confirming") {
        await dispenseSessionService.revertToWeighing(session.id);
      }
    };

    ws.on("message", async (raw) => {
      ws.lastActivity = Date.now();

      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch (err) {
        logger.warn("[IoT] Dropped malformed (non-JSON) frame", {
          deviceId: device.device_id,
        });
        return;
      }

      switch (parsed?.type) {
        case "hello":
          handleHello(parsed);
          return;
        case "heartbeat":
          handleHeartbeat(parsed);
          return;
        case "error":
          await handleDeviceError(parsed);
          return;
        case "reading":
          await handleReading(parsed);
          return;
        default:
          logger.warn("[IoT] Dropped frame with unknown type", {
            deviceId: device.device_id,
            type:
              typeof parsed?.type === "string"
                ? parsed.type.slice(0, 40)
                : typeof parsed?.type,
          });
      }
    });

    ws.on("close", (code, reasonBuf) => {
      logger.info("[IoT] Device disconnected", {
        deviceId: device.device_id,
        code,
        reason: reasonBuf?.toString() || "",
      });
      deviceConnectionRegistry.unregisterConnection(device.device_id, ws);
      liveReadingBus.publish(device.shop_id, {
        type: "device_status",
        online: false,
        deviceId: device.device_id,
      });

      // Phase 2 — no partial commits on disconnect: any session this
      // device was gating moves to a terminal 'device_lost' state
      // rather than being left attached/weighing/confirming forever.
      dispenseSessionService.markDeviceLost(device.device_id).catch((err) => {
        logger.error("[IoT] Failed to mark device_lost on disconnect", {
          deviceId: device.device_id,
          message: err.message,
        });
      });
    });

    ws.on("error", (err) => {
      logger.error("[IoT] Device socket error", {
        deviceId: device.device_id,
        message: err.message,
      });
    });
  });

  const staleSweep = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (Date.now() - (ws.lastActivity || 0) > STALE_THRESHOLD_MS) {
        logger.warn("[IoT] Terminating stale device connection (no heartbeat)");
        ws.terminate();
      }
    });
  }, STALE_SWEEP_INTERVAL_MS);
  wss.on("close", () => clearInterval(staleSweep));

  // Validates the device's Sec-WebSocket-Protocol bearer token *before*
  // completing the WS handshake — an invalid token never gets a WS
  // connection at all, just a plain HTTP 401.
  const handleUpgrade = async (req, socket, head) => {
    const url = new URL(req.url, "http://internal");
    const deviceId = url.searchParams.get("deviceId");
    const token = extractSubprotocol(req);

    if (!deviceId || !token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let validation;
    try {
      validation = await deviceRegistryService.validateToken(deviceId, token);
    } catch (err) {
      logger.error("[IoT] Device token validation errored", {
        deviceId,
        message: err.message,
      });
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!validation.ok) {
      logger.warn("[IoT] Rejected device WS handshake", {
        deviceId,
        reason: validation.reason,
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, validation.device);
    });
  };

  return { wss, handleUpgrade };
};

module.exports = { createIotSocketServer };
