const express = require("express");
const { verifyToken, requireRole } = require("../middleware/auth");
const {
    getMe,
    getWallet,
    getFamily,
    getTransactions,
    createQrSession,
} = require("../controllers/beneficiaryController");
const { getMyFpsStatus } = require("../controllers/shopStatusController");

const router = express.Router();

router.use(verifyToken, requireRole("beneficiary"));

router.get("/me", getMe);
router.get("/profile", getMe);
router.get("/wallet", getWallet);
router.get("/family", getFamily);
router.get("/transactions", getTransactions);
router.post("/qr-session", createQrSession);
router.get("/fps-status", getMyFpsStatus);

module.exports = router;
