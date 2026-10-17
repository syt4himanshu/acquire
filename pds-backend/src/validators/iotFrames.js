const Joi = require("joi");
const { MIN_VALID_GRAMS, MAX_VALID_GRAMS } = require("../config/iot");

// Centralizes every inbound WebSocket frame schema (device + admin +
// shopkeeper) in one place, all validated the same way (Joi — already the
// established validator throughout this project; no second library added
// for this). Payload validation on every inbound frame, reject-and-log
// rather than crash, per Phase 3's hardening requirement.

// Device -> /ws/iot, one per debounced reading.
const deviceReadingFrameSchema = Joi.object({
  type: Joi.string().valid("reading").required(),
  // Hardware safety ceiling, sourced from config/iot.js rather than
  // repeated here — this schema and iotController.persistReading must never
  // be able to disagree about what the load cell can credibly report.
  // Joi already rejects NaN, Infinity, non-numeric and non-integer values.
  grams: Joi.number()
    .integer()
    .min(MIN_VALID_GRAMS)
    .max(MAX_VALID_GRAMS)
    .required(),
  ts: Joi.number().integer().min(0).required(),
  sessionId: Joi.string().max(150).allow(null).default(null),
});

// Device/bridge -> /ws/iot, once per connection, immediately after the
// handshake. Carries the firmware version the board reported over USB serial
// (iot_devices.firmware_version) and the transport that carried it, so the
// Admin Panel can show what is actually running on the hardware.
//
// Deliberately carries NO business fields. A device may not name its own shop,
// session, ration card, entitlement or wallet: the backend derives shop from
// the registered device row and session from dispense_sessions, and anything a
// device asserted about those would be an authorisation bypass.
const deviceHelloFrameSchema = Joi.object({
  type: Joi.string().valid("hello").required(),
  // Free-form but bounded — matches iot_devices.firmware_version's VARCHAR(50).
  firmware: Joi.string().max(50).allow("", null).default(null),
  // 'serial' for the USB bridge; the pre-existing Wi-Fi/WSS firmware path
  // reports 'wifi'. Recorded in logs only — it grants nothing.
  transport: Joi.string().valid("serial", "wifi").default("serial"),
  // Echoed back for log correlation only. The authenticated device_id from
  // the handshake is the identity; this field is never trusted over it.
  deviceId: Joi.string().max(100).allow(null).default(null),
});

// Device/bridge -> /ws/iot, periodically, while the scale is idle. Keeps
// last_seen_at advancing (and the idle sweep satisfied) without fabricating a
// weight reading, which is why it is a distinct frame type rather than a 0 g
// reading: a 0 g reading is a measurement and would land in sensor_readings.
const deviceHeartbeatFrameSchema = Joi.object({
  type: Joi.string().valid("heartbeat").required(),
  ts: Joi.number().integer().min(0).required(),
});

// Device/bridge -> /ws/iot when the hardware itself reports a fault
// (HX711/load-cell overload or a disconnected/reversed cell). Logged and
// surfaced; it deliberately carries no grams value that could be mistaken for
// a measurement — an overload reported as 4000 g would fabricate a perfect
// dispense out of a hardware fault.
const deviceErrorFrameSchema = Joi.object({
  type: Joi.string().valid("error").required(),
  code: Joi.string()
    .valid("OVERLOAD", "SENSOR_FAULT", "NOT_CALIBRATED", "HX711_NOT_READY")
    .required(),
  ts: Joi.number().integer().min(0).default(0),
  detail: Joi.string().max(200).allow("", null).default(null),
});

// Browser (admin) -> /ws/admin/live, to scope live-reading updates to one shop.
const adminSubscribeFrameSchema = Joi.object({
  type: Joi.string().valid("subscribe").required(),
  shopId: Joi.string().uuid().required(),
});

// Browser (shopkeeper) -> /ws/shopkeeper/live, to scope dispense-session
// state updates to the session currently being weighed.
const shopkeeperSubscribeFrameSchema = Joi.object({
  type: Joi.string().valid("subscribe").required(),
  sessionId: Joi.string().uuid().required(),
});

module.exports = {
  deviceReadingFrameSchema,
  deviceHelloFrameSchema,
  deviceHeartbeatFrameSchema,
  deviceErrorFrameSchema,
  adminSubscribeFrameSchema,
  shopkeeperSubscribeFrameSchema,
};
