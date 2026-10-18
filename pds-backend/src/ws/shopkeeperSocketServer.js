const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const logger = require("../config/logger");
const dispenseSessionBus = require("../services/dispenseSessionBus");
const { logStateDelivery } = require("../services/stabilityDebug"); // TEMPORARY
const { shopkeeperSubscribeFrameSchema } = require("../validators/iotFrames");

const extractSubprotocol = (req) => {
    const header = req.headers["sec-websocket-protocol"];
    if (!header) return null;
    return header.split(",")[0].trim() || null;
};

// Creates the shopkeeper-facing WebSocket server for /ws/shopkeeper/live —
// pushes dispense-session state-machine events (weighing/confirming
// countdown/committed/cancelled/device_lost/failed_insufficient_balance) to
// the shopkeeper's own dispense screen. Same auth pattern as
// adminSocketServer.js (JWT via Sec-WebSocket-Protocol, since a browser
// WebSocket can't set an Authorization header), just a different role.
const createShopkeeperSocketServer = () => {
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (ws, req, shopkeeper) => {
        logger.info("[IoT] Shopkeeper dispense-session view connected", { shopkeeperId: shopkeeper.id });

        let unsubscribe = null;

        ws.on("message", (raw) => {
            let parsed;
            try {
                parsed = JSON.parse(raw.toString());
            } catch (err) {
                logger.warn("[IoT] Dropped malformed shopkeeper frame", { shopkeeperId: shopkeeper.id });
                return;
            }

            const { error, value } = shopkeeperSubscribeFrameSchema.validate(parsed);
            if (error) {
                logger.warn("[IoT] Dropped invalid shopkeeper frame", {
                    shopkeeperId: shopkeeper.id,
                    message: error.message,
                });
                return;
            }

            if (unsubscribe) {
                unsubscribe();
            }

            // TEMPORARY diagnostics: state events only.
            logStateDelivery({ stage: "subscribe_frame", sessionId: value.sessionId, state: null, extra: { shopkeeperId: shopkeeper.id } });
            logger.info("[WS-DIAG] shopkeeper subscribed", { sessionId: value.sessionId, shopkeeperId: shopkeeper.id });
            unsubscribe = dispenseSessionBus.subscribe(value.sessionId, (payload) => {
                if (payload.type !== "state") {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(payload));
                    }
                    return;
                }
                if (ws.readyState === ws.OPEN) {
                    logStateDelivery({ stage: "deliver", sessionId: value.sessionId, state: payload.state, extra: { readyState: ws.readyState } });
                    ws.send(JSON.stringify(payload));
                } else {
                    logStateDelivery({ stage: "deliver_skipped", sessionId: value.sessionId, state: payload.state, extra: { readyState: ws.readyState } });
                }
            });
        });

        ws.on("close", (code, reason) => {
            // TEMPORARY [WS-DIAG]: close code tells us why the socket ended.
            logger.info("[WS-DIAG] shopkeeper socket closed", {
                shopkeeperId: shopkeeper.id,
                code,
                reason: reason ? reason.toString() : null,
            });
            if (unsubscribe) {
                unsubscribe();
            }
            logger.info("[IoT] Shopkeeper dispense-session view disconnected", { shopkeeperId: shopkeeper.id });
        });

        ws.on("error", (err) => {
            logger.error("[IoT] Shopkeeper socket error", { shopkeeperId: shopkeeper.id, message: err.message });
        });
    });

    const handleUpgrade = (req, socket, head) => {
        const token = extractSubprotocol(req);
        // TEMPORARY [WS-DIAG]: the token itself is never logged, only whether it was sent.
        logger.info("[WS-DIAG] shopkeeper handshake", {
            path: req.url,
            hasSubprotocolToken: Boolean(token),
            origin: req.headers.origin || null,
        });

        if (!token) {
            logger.warn("[WS-DIAG] shopkeeper handshake rejected", { reason: "no_token" });
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            logger.warn("[IoT] Rejected shopkeeper WS handshake", { message: err.message });
            logger.warn("[WS-DIAG] shopkeeper handshake rejected", { reason: "token_invalid", message: err.message });
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        if (decoded.role !== "shopkeeper") {
            logger.warn("[IoT] Rejected shopkeeper WS handshake: wrong role", { role: decoded.role });
            logger.warn("[WS-DIAG] shopkeeper handshake rejected", { reason: "wrong_role", role: decoded.role });
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req, decoded);
        });
    };

    return { wss, handleUpgrade };
};

module.exports = { createShopkeeperSocketServer };
