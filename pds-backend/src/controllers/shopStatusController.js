const pool = require("../config/db");
const logger = require("../config/logger");
const { getAssignedShop } = require("./shopkeeperController");
const {
  getShopStatusById,
  setOpenStatus,
  setQueueCount,
  getBeneficiaryFpsShopId,
} = require("../services/shopStatusService");

// The shop is ALWAYS the one assigned to the authenticated shopkeeper. No shop
// id is read from the request, so a shopkeeper cannot touch another shop by
// changing a parameter or body field.

// GET /api/shopkeeper/shop-status
const getMyShopStatus = async (req, res, next) => {
  try {
    const shop = await getAssignedShop(pool, req.user.id);
    if (!shop) {
      return res.status(404).json({ error: "No active shop assigned" });
    }
    const status = await getShopStatusById(pool, shop.id);
    return res.status(200).json({ status });
  } catch (err) {
    return next(err);
  }
};

// PUT /api/shopkeeper/shop-status/open   body: { is_open: boolean }
const updateMyOpenStatus = async (req, res, next) => {
  try {
    const shop = await getAssignedShop(pool, req.user.id);
    if (!shop) {
      return res.status(404).json({ error: "No active shop assigned" });
    }
    const status = await setOpenStatus(pool, shop.id, req.body.is_open);
    logger.info("[Shop] Open status updated", {
      shopId: shop.id,
      isOpen: req.body.is_open,
    });
    return res.status(200).json({ status });
  } catch (err) {
    return next(err);
  }
};

// PUT /api/shopkeeper/shop-status/queue   body: { queue_count: integer }
const updateMyQueueCount = async (req, res, next) => {
  try {
    const shop = await getAssignedShop(pool, req.user.id);
    if (!shop) {
      return res.status(404).json({ error: "No active shop assigned" });
    }
    const status = await setQueueCount(pool, shop.id, req.body.queue_count);
    return res.status(200).json({ status });
  } catch (err) {
    return next(err);
  }
};

// GET /api/beneficiary/fps-status
// Returns only the status of the FPS the beneficiary's own ration card is
// assigned to. The shop is derived from the token's user, never a parameter.
const getMyFpsStatus = async (req, res, next) => {
  try {
    const shopId = await getBeneficiaryFpsShopId(pool, req.user.id);
    if (!shopId) {
      return res.status(404).json({ error: "No FPS assigned to this beneficiary" });
    }
    const status = await getShopStatusById(pool, shopId);
    if (!status) {
      return res.status(404).json({ error: "FPS not found" });
    }
    return res.status(200).json({ status });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  getMyShopStatus,
  updateMyOpenStatus,
  updateMyQueueCount,
  getMyFpsStatus,
};
