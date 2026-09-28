const pool = require("../config/db");
const logger = require("../config/logger");
const dispenseSessionService = require("../services/dispenseSessionService");
const auditLogService = require("../services/auditLogService");
const deviceFleetService = require("../services/deviceFleetService");
const { getAssignedShop } = require("./shopkeeperController");

const sendServiceError = (res, result) => res.status(result.status || 400).json({ error: result.message, code: result.code });

// POST /api/dispense/session
const createSession = async (req, res, next) => {
    try {
        const shop = await getAssignedShop(pool, req.user.id);
        if (!shop) {
            return res.status(404).json({ error: "No active shop assigned" });
        }

        const {
            ration_card_id: rationCardId,
            commodity,
            entitled_grams: entitledGrams,
            qr_session_id: qrSessionId,
        } = req.body;

        const result = await dispenseSessionService.createSession({
            shopId: shop.id,
            rationCardId,
            commodity,
            entitledGrams,
            qrSessionId,
        });

        if (!result.ok) {
            logger.warn("[IoT] createSession rejected", { shopId: shop.id, code: result.code });
            return sendServiceError(res, result);
        }

        return res.status(201).json({
            session_id: result.sessionId,
            session_jwt: result.sessionJwt,
            expires_at: result.expiresAt,
            tolerance_grams: result.toleranceGrams,
        });
    } catch (err) {
        return next(err);
    }
};

// POST /api/dispense/session/:id/attach
const attachSession = async (req, res, next) => {
    try {
        const shop = await getAssignedShop(pool, req.user.id);
        if (!shop) {
            return res.status(404).json({ error: "No active shop assigned" });
        }

        const { session_jwt: sessionJwt } = req.body;
        const result = await dispenseSessionService.attachSession(req.params.id, sessionJwt, shop.id);

        if (!result.ok) {
            return sendServiceError(res, result);
        }

        return res.status(200).json({
            session_id: result.sessionId,
            device_id: result.deviceId,
            state: result.state,
        });
    } catch (err) {
        return next(err);
    }
};

// POST /api/dispense/session/:id/cancel
const cancelSession = async (req, res, next) => {
    try {
        const shop = await getAssignedShop(pool, req.user.id);
        if (!shop) {
            return res.status(404).json({ error: "No active shop assigned" });
        }

        const result = await dispenseSessionService.cancelSession(req.params.id, shop.id);
        if (!result.ok) {
            return sendServiceError(res, result);
        }

        logger.info("[IoT] Dispense session cancelled by shopkeeper", {
            shopId: shop.id,
            sessionId: req.params.id,
        });
        auditLogService.record({
            actorType: "shopkeeper",
            actorId: req.user?.id,
            action: "cancel_session",
            target: req.params.id,
            meta: { shopId: shop.id },
        });

        return res.status(200).json({ session_id: result.sessionId, state: result.state });
    } catch (err) {
        return next(err);
    }
};

// POST /api/dispense/session/:id/confirm
// Immediately commits a session that is in the 'confirming' state when the
// shopkeeper manually clicks OK. This short-circuits the backend's auto-commit
// countdown timer (which would otherwise commit the session after 3 seconds of
// stable weight). The measured grams are derived from the average of the
// backend's stability window — the same calculation the auto-timer uses.
const confirmSession = async (req, res, next) => {
    try {
        const shop = await getAssignedShop(pool, req.user.id);
        if (!shop) {
            return res.status(404).json({ error: "No active shop assigned" });
        }

        const result = await dispenseSessionService.manualConfirm(req.params.id, shop.id);
        if (!result.ok) {
            return sendServiceError(res, result);
        }

        logger.info("[IoT] Dispense session manually confirmed by shopkeeper", {
            shopId: shop.id,
            sessionId: req.params.id,
            measuredGrams: result.measuredGrams,
        });

        return res.status(200).json({
            session_id: result.sessionId,
            state: result.state,
            measured_grams: result.measuredGrams,
            dispense_record_id: result.dispenseRecordId,
        });
    } catch (err) {
        return next(err);
    }
};

// GET /api/dispense/device-status — lets the shopkeeper's dispense screen
// know whether to offer the IoT weighing path at all for its own shop, and
// show the scale as ONLINE/OFFLINE.
//
// `active` (registry lifecycle) and `connectivity` (is the USB bridge actually
// connected right now) are reported as separate fields on purpose. A device row
// existing in PostgreSQL is not evidence that anything is plugged in, so the
// screen shows ONLINE only when `connectivity === 'online'` — i.e. only when
// there is a live /ws/iot socket for this shop's device.
//
// The response deliberately contains no token, no COM port and no serial
// detail. The shopkeeper does not configure hardware; they weigh grain.
const getDeviceStatus = async (req, res, next) => {
    try {
        const shop = await getAssignedShop(pool, req.user.id);
        if (!shop) {
            return res.status(404).json({ error: "No active shop assigned" });
        }

        const result = await pool.query(
            `SELECT d.device_id, d.device_name, d.last_seen_at,
              r.grams_int AS current_weight_grams, r.taken_at AS current_weight_at
         FROM iot_devices d
         LEFT JOIN LATERAL (
           SELECT grams_int, taken_at FROM sensor_readings sr
            WHERE sr.device_id = d.device_id
            ORDER BY sr.taken_at DESC LIMIT 1
         ) r ON true
        WHERE d.shop_id = $1 AND d.status = 'active'
        LIMIT 1`,
            [shop.id],
        );

        const device = result.rows[0] || null;

        return res.status(200).json({
            active: Boolean(device),
            device_id: device?.device_id || null,
            device_name: device?.device_name || null,
            connectivity: device ? deviceFleetService.deriveStatus(device.device_id, device.last_seen_at) : "offline",
            last_seen_at: device?.last_seen_at || null,
            // Current SENSOR reading, not a dispense. Displaying it can never
            // debit a wallet — only commitSession does that, and only for an
            // authorised session.
            current_weight_grams: device?.current_weight_grams ?? null,
            current_weight_at: device?.current_weight_at || null,
        });
    } catch (err) {
        return next(err);
    }
};

// GET /api/dispense/session/:id
const getSession = async (req, res, next) => {
    try {
        const shop = await getAssignedShop(pool, req.user.id);
        if (!shop) {
            return res.status(404).json({ error: "No active shop assigned" });
        }

        await dispenseSessionService.expireIfStale(req.params.id);

        const result = await dispenseSessionService.getSessionStatus(req.params.id, shop.id);
        if (!result.ok) {
            return sendServiceError(res, result);
        }

        return res.status(200).json({ session: result.session });
    } catch (err) {
        return next(err);
    }
};

module.exports = { createSession, attachSession, cancelSession, confirmSession, getSession, getDeviceStatus };
