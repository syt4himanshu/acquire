/* eslint-disable camelcase */
// Shop availability (Open/Closed) and the shopkeeper's queue estimate, stored
// on the shop row. The shop already carries the shopkeeper link
// (shops.shopkeeper_id) and beneficiaries reach it through ration_cards.shop_id,
// so no new relationship is introduced.
//
// Safe defaults: a new shop is is_open = false with no timestamp, and the API
// reports that as "not reported" rather than "closed". Existing shops are
// backfilled the same way, so nothing is shown as current until a shopkeeper
// reports it.
exports.up = (pgm) => {
  pgm.addColumns("shops", {
    is_open: { type: "boolean", notNull: true, default: false },
    open_status_updated_at: { type: "timestamp" },
    queue_count: { type: "integer" },
    queue_updated_at: { type: "timestamp" },
  });

  // Keep in sync with MAX_QUEUE_COUNT in src/config/shopStatus.js.
  pgm.addConstraint("shops", "shops_queue_count_range", {
    check: "queue_count IS NULL OR (queue_count >= 0 AND queue_count <= 500)",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("shops", "shops_queue_count_range");
  pgm.dropColumns("shops", [
    "is_open",
    "open_status_updated_at",
    "queue_count",
    "queue_updated_at",
  ]);
};
