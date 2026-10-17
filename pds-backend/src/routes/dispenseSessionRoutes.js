const express = require("express");
const { verifyToken, requireRole } = require("../middleware/auth");
const validate = require("../middleware/validate");
const {
  createSessionSchema,
  attachSchema,
} = require("../validators/dispenseSession");
const {
  createSession,
  attachSession,
  cancelSession,
  captureMeasurement,
  confirmSession,
  getSession,
  getDeviceStatus,
} = require("../controllers/dispenseSessionController");

const router = express.Router();

router.use(verifyToken, requireRole("shopkeeper"));

router.get("/device-status", getDeviceStatus);
router.post("/session", validate(createSessionSchema), createSession);
router.get("/session/:id", getSession);
router.post("/session/:id/attach", validate(attachSchema), attachSession);
router.post("/session/:id/cancel", cancelSession);
router.post("/session/:id/capture", captureMeasurement);
router.post("/session/:id/confirm", confirmSession);

module.exports = router;
