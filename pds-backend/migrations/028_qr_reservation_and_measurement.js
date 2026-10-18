/* eslint-disable camelcase */
// One QR authorises one complete distribution, which can span several
// commodity weighings (rice, then wheat). The QR is therefore RESERVED by the
// first weighing session it opens and only CONSUMED (is_used) when the
// distribution is finalised. This migration adds the reservation window, the
// captured measurement the finaliser needs, and a database-level guard so a
// QR can never have two live sessions for the same commodity.
exports.up = (pgm) => {
  pgm.addColumns("qr_sessions", {
    reserved_at: { type: "timestamp" },
    reserved_until: { type: "timestamp" },
  });

  pgm.addColumn("dispense_sessions", {
    measured_grams: { type: "integer" },
  });

  // A session that has been cancelled or failed releases its commodity slot so
  // the shopkeeper can re-weigh. Every other state holds it.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS dispense_sessions_qr_commodity_live_unique
      ON dispense_sessions (qr_session_id, commodity)
      WHERE qr_session_id IS NOT NULL
        AND state IN ('active','attached','weighing','confirming','captured','committed');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS dispense_sessions_qr_commodity_live_unique;`);
  pgm.dropColumn("dispense_sessions", "measured_grams");
  pgm.dropColumns("qr_sessions", ["reserved_at", "reserved_until"]);
};
