/* eslint-disable camelcase */
// Auto-finalized IoT distribution: bind each commodity session to the scanned
// QR, retain the server measurement timestamp, and allow both commodity audit
// rows to link to their one canonical distribution transaction.
exports.up = (pgm) => {
  pgm.addColumn("dispense_sessions", {
    qr_session_id: {
      type: "varchar(150)",
      references: "qr_sessions(session_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addColumn("dispense_records", {
    measured_at: { type: "timestamp" },
  });
  pgm.sql(`DROP INDEX IF EXISTS dispense_records_transaction_id_unique_index;`);
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS dispense_records_transaction_id_index ON dispense_records (transaction_id) WHERE transaction_id IS NOT NULL;`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS dispense_records_transaction_id_index;`);
  pgm.sql(
    `CREATE UNIQUE INDEX IF NOT EXISTS dispense_records_transaction_id_unique_index ON dispense_records (transaction_id) WHERE transaction_id IS NOT NULL;`,
  );
  pgm.dropColumn("dispense_records", "measured_at");
  pgm.dropColumn("dispense_sessions", "qr_session_id");
};
