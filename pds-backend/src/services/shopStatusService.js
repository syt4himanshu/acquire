const {
  MAX_QUEUE_COUNT,
  OPEN_STATUS_MAX_AGE_MS,
  QUEUE_STALE_AFTER_MS,
} = require("../config/shopStatus");

// Ages are computed by PostgreSQL (NOW() minus the stored timestamp) rather
// than in Node, so clock skew between the app server and the database cannot
// make a report look fresher or staler than it is.
const STATUS_SELECT = `
  s.shop_name,
  s.is_active,
  s.is_open,
  EXTRACT(EPOCH FROM (NOW() - s.open_status_updated_at))::float8 AS open_age_seconds,
  s.queue_count,
  EXTRACT(EPOCH FROM (NOW() - s.queue_updated_at))::float8 AS queue_age_seconds
`;

const toSeconds = (ms) => Math.round(ms / 1000);

// The single place where a stored report becomes what users are shown.
// - Availability is "unknown" when the shop is inactive, has never reported,
//   or its last report is older than OPEN_STATUS_MAX_AGE_MS. An old "Open" or
//   "Closed" must never be presented as current.
// - A queue estimate is "current" within QUEUE_STALE_AFTER_MS, otherwise
//   "last_reported". It is never presented as live.
const buildShopStatus = (row) => {
  const openAge = row.open_age_seconds ?? null;
  const openTrusted =
    row.is_active !== false &&
    openAge !== null &&
    openAge * 1000 <= OPEN_STATUS_MAX_AGE_MS;

  const queueAge = row.queue_age_seconds ?? null;
  const hasQueue = row.queue_count !== null && row.queue_count !== undefined;
  let freshness = "none";
  if (hasQueue) {
    freshness =
      queueAge !== null && queueAge * 1000 <= QUEUE_STALE_AFTER_MS
        ? "current"
        : "last_reported";
  }

  return {
    shop_name: row.shop_name,
    availability: {
      status: openTrusted ? (row.is_open ? "open" : "closed") : "unknown",
      updated_age_seconds: openAge === null ? null : Math.round(openAge),
    },
    queue: {
      count: hasQueue ? Number(row.queue_count) : null,
      updated_age_seconds: hasQueue && queueAge !== null ? Math.round(queueAge) : null,
      freshness,
    },
    thresholds: {
      open_status_max_age_seconds: toSeconds(OPEN_STATUS_MAX_AGE_MS),
      queue_stale_after_seconds: toSeconds(QUEUE_STALE_AFTER_MS),
      queue_max: MAX_QUEUE_COUNT,
    },
  };
};

const getShopStatusById = async (db, shopId) => {
  const result = await db.query(
    `SELECT ${STATUS_SELECT} FROM shops s WHERE s.id = $1`,
    [shopId],
  );
  if (result.rows.length === 0) return null;
  return buildShopStatus(result.rows[0]);
};

// shopId always comes from the authenticated shopkeeper's assigned shop
// (getAssignedShop), never from the request body.
const setOpenStatus = async (db, shopId, isOpen) => {
  await db.query(
    `UPDATE shops SET is_open = $2, open_status_updated_at = NOW() WHERE id = $1`,
    [shopId, isOpen],
  );
  return getShopStatusById(db, shopId);
};

const setQueueCount = async (db, shopId, queueCount) => {
  await db.query(
    `UPDATE shops SET queue_count = $2, queue_updated_at = NOW() WHERE id = $1`,
    [shopId, queueCount],
  );
  return getShopStatusById(db, shopId);
};

// A beneficiary's FPS is the shop of the ration card they are head of
// household on. Returns null when the user has no card.
const getBeneficiaryFpsShopId = async (db, userId) => {
  const result = await db.query(
    `SELECT rc.shop_id
       FROM family_members fm
       JOIN ration_cards rc ON rc.id = fm.ration_card_id
      WHERE fm.user_id = $1 AND fm.is_head = true
      LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.shop_id || null;
};

module.exports = {
  buildShopStatus,
  getShopStatusById,
  setOpenStatus,
  setQueueCount,
  getBeneficiaryFpsShopId,
};
