const express = require("express");
const { verifyToken, requireRole } = require("../middleware/auth");
const validate = require("../middleware/validate");
const {
  dispenseSchema,
  transactionSchema,
  openStatusSchema,
  queueCountSchema,
} = require("../validators/shopkeeper");
const {
  getMe,
  getBeneficiaryByRationCardId,
  dispense,
  createTransaction,
  getTransactionReceipt,
} = require("../controllers/shopkeeperController");
const {
  getMyShopStatus,
  updateMyOpenStatus,
  updateMyQueueCount,
} = require("../controllers/shopStatusController");

const router = express.Router();

router.use(verifyToken, requireRole("shopkeeper"));

router.get("/me", getMe);
router.get("/beneficiary/:id", getBeneficiaryByRationCardId);
router.post("/dispense", validate(dispenseSchema), dispense);
router.post("/transactions", validate(transactionSchema), createTransaction);
router.get("/transactions/:id/receipt", getTransactionReceipt);
router.get("/shop-status", getMyShopStatus);
router.put("/shop-status/open", validate(openStatusSchema), updateMyOpenStatus);
router.put("/shop-status/queue", validate(queueCountSchema), updateMyQueueCount);

module.exports = router;
