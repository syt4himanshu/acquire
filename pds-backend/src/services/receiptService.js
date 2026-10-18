const pool = require("../config/db");

// Read-only receipt view of one COMMITTED distribution. Everything here comes
// from rows the dispense transaction already wrote (transactions,
// dispense_records, dispense_sessions) plus the registered beneficiary and
// shop. Nothing is recomputed from the request, and nothing is written.
//
// Scoped by shop: a transaction is returned only to the shop that served it.
// A miss and another shop's transaction both return null, so the caller cannot
// tell whether a foreign transaction exists.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
// Sepolia testnet explorer. The receipt links here only for a well-formed hash.
const SEPOLIA_EXPLORER_TX_URL = "https://sepolia.etherscan.io/tx/";

// Shows only the last four digits, e.g. "••••••••5678". Never the full number.
const maskCardNumber = (cardNumber) => {
  if (!cardNumber) return null;
  const digits = String(cardNumber);
  return `${"•".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
};

const toGrams = (value) => Number(value);

const buildCommodityRow = (row) => {
  const entitledGrams = toGrams(row.entitled_grams);
  const measuredGrams = toGrams(row.measured_grams);
  const toleranceGrams = toGrams(row.tolerance_grams);
  const differenceGrams = measuredGrams - entitledGrams;
  return {
    commodity: row.commodity,
    entitledGrams,
    measuredGrams,
    differenceGrams,
    toleranceGrams,
    withinTolerance: Math.abs(differenceGrams) <= toleranceGrams,
  };
};

const blockchainFor = (txHash, anchorError) => {
  if (txHash && TX_HASH_PATTERN.test(txHash)) {
    return {
      status: "recorded",
      txHash,
      explorerUrl: `${SEPOLIA_EXPLORER_TX_URL}${txHash}`,
    };
  }
  // A hash is written only after the DB commit, asynchronously. An anchor error
  // with no hash means recording has failed for good, not that it is pending.
  if (anchorError) {
    return { status: "unavailable", txHash: null, explorerUrl: null };
  }
  return { status: "pending", txHash: null, explorerUrl: null };
};

// Returns the receipt for a transaction served by `shopId`, or null.
const getShopReceipt = async (transactionId, shopId) => {
  if (!UUID_PATTERN.test(String(transactionId))) return null;

  const headerResult = await pool.query(
    `SELECT t.id, t.created_at, t.blockchain_tx_hash, t.ration_card_id,
            s.shop_code, s.shop_name,
            rc.card_number, rc.category,
            head.name AS beneficiary_name
       FROM transactions t
       JOIN shops s ON s.id = t.shop_id
       JOIN ration_cards rc ON rc.id = t.ration_card_id
       JOIN users head ON head.id = rc.head_user_id
      WHERE t.id = $1 AND t.shop_id = $2`,
    [transactionId, shopId],
  );
  if (headerResult.rows.length === 0) return null;
  const header = headerResult.rows[0];

  const recordsResult = await pool.query(
    `SELECT dr.commodity, dr.entitled_grams, dr.measured_grams, dr.committed_at,
            dr.last_anchor_error,
            ds.tolerance_grams, ds.state AS session_state
       FROM dispense_records dr
       JOIN dispense_sessions ds ON ds.id = dr.session_id
      WHERE dr.transaction_id = $1
      ORDER BY CASE dr.commodity WHEN 'rice' THEN 0 ELSE 1 END`,
    [header.id],
  );

  const familyResult = await pool.query(
    `SELECT COUNT(*)::int AS family_size FROM family_members WHERE ration_card_id = $1`,
    [header.ration_card_id],
  );

  const commodities = recordsResult.rows.map(buildCommodityRow);
  const anchorError = recordsResult.rows.some((row) => row.last_anchor_error);
  const measuredTotalGrams = commodities.reduce((sum, row) => sum + row.measuredGrams, 0);
  const entitledTotalGrams = commodities.reduce((sum, row) => sum + row.entitledGrams, 0);

  return {
    reference: header.id,
    issuedAt: header.created_at,
    status: "completed",
    shop: { code: header.shop_code, name: header.shop_name },
    beneficiary: {
      name: header.beneficiary_name,
      maskedCardNumber: maskCardNumber(header.card_number),
      category: header.category,
      familySize: familyResult.rows[0]?.family_size ?? null,
    },
    commodities,
    totals: {
      entitledGrams: entitledTotalGrams,
      measuredGrams: measuredTotalGrams,
    },
    blockchain: blockchainFor(header.blockchain_tx_hash, anchorError),
  };
};

module.exports = { getShopReceipt, maskCardNumber, blockchainFor, buildCommodityRow };
