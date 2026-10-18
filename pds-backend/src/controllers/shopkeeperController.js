const pool = require("../config/db");
const logger = require("../config/logger");
const { recordDispense } = require("../services/blockchainService");
const { buildRowHash } = require("../services/chainRowBuilder");
const {
  assertClaimable,
  asMonthlyClaimError,
  MonthlyClaimError,
} = require("../services/monthlyClaimService");
const {
  getCardAllocation,
  allocationGramsFor,
  kgToGrams,
} = require("../services/allocationPolicyService");

// One allocation -> one complete transaction. A manual dispense may cover one
// commodity or both, but whichever commodities it covers must be dispensed in
// FULL: a partial manual dispense consumes the month's claim for that
// commodity and strands the rest of the allocation, which is the same defect
// the IoT session path guards against (IOT_PARTIAL_ALLOCATION). Enforced here
// too, otherwise the invariant is bypassable simply by using this endpoint.
const assertCompleteAllocation = async (client, rationCardId, quantities) => {
  const allocation = await getCardAllocation(client, rationCardId);
  if (!allocation) {
    const err = new Error("No allocation policy for this ration card");
    err.statusCode = 404;
    throw err;
  }

  for (const [commodity, qtyKg] of Object.entries(quantities)) {
    if (qtyKg <= 0) continue; // not being dispensed in this transaction
    const requestedGrams = kgToGrams(qtyKg);
    const allocationGrams = allocationGramsFor(allocation, commodity);
    if (requestedGrams !== allocationGrams) {
      const err = new Error(
        `A dispense must cover the complete ${commodity} allocation of ${allocationGrams} g ` +
        `for this ration card (requested ${requestedGrams} g). Partial dispensing is not supported.`,
      );
      err.statusCode = 400;
      err.detail = "PARTIAL_ALLOCATION";
      throw err;
    }
  }
};

// Returns a refusal message if a weighing session may NOT authorise this
// distribution, otherwise null. A session must be this QR's own, for the
// expected commodity and this card and shop, and must have been captured with a
// measurement inside tolerance. Only a captured session can be finalised.
const captureFailure = (
  session,
  { label, commodity, rationCardId, shopId, qrSessionId },
) => {
  if (session.ration_card_id !== rationCardId || session.shop_id !== shopId) {
    return `${label} IoT session does not match ration card or shop`;
  }
  if (session.commodity !== commodity) {
    return `Invalid commodity for ${label} session`;
  }
  if (session.qr_session_id !== qrSessionId) {
    return `${label} IoT session was not authorised by this QR`;
  }
  if (session.state !== "captured") {
    return `${label} weighing has not been successfully verified by IoT scale`;
  }
  const measured = session.measured_grams;
  if (
    measured === null ||
    Math.abs(Number(measured) - Number(session.entitled_grams)) >
      Number(session.tolerance_grams)
  ) {
    return `${label} measurement is outside tolerance`;
  }
  return null;
};

const toNumber = (value) => Number.parseFloat(value || 0);

const getAssignedShop = async (client, userId) => {
  const result = await client.query(
    `
      SELECT
        s.id,
        s.shop_code,
        s.shop_name,
        s.area_id,
        a.name AS area_name
      FROM shops s
      LEFT JOIN areas a ON a.id = s.area_id
      WHERE s.shopkeeper_id = $1
        AND COALESCE(s.is_active, true) = true
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
};

const getMe = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const userResult = await pool.query(
      `
        SELECT id, name, email, mobile, role, is_active
        FROM users
        WHERE id = $1
          AND role = 'shopkeeper'
          AND COALESCE(is_active, true) = true
        LIMIT 1
      `,
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Shopkeeper profile not found" });
    }

    const shop = await getAssignedShop(pool, userId);
    if (!shop) {
      return res.status(404).json({ error: "No active shop assigned" });
    }

    const countResult = await pool.query(
      `
        SELECT COUNT(*)::int AS today_count
        FROM transactions
        WHERE shop_id = $1
          AND DATE(created_at) = CURRENT_DATE
      `,
      [shop.id],
    );

    const user = userResult.rows[0];

    return res.status(200).json({
      shopkeeper: {
        id: user.id,
        name: user.name || user.email?.split("@")[0] || "Shopkeeper",
        email: user.email,
        mobile: user.mobile,
      },
      shop: {
        id: shop.id,
        name: shop.shop_name,
        code: shop.shop_code,
        area: shop.area_name,
      },
      today_transactions: countResult.rows[0]?.today_count || 0,
    });
  } catch (error) {
    return next(error);
  }
};

const getBeneficiaryByRationCardId = async (req, res, next) => {
  try {
    const rationCardId = req.params.id;
    const sessionId = req.query.sessionId;
    const shop = await getAssignedShop(pool, req.user.id);

    if (!shop) {
      return res.status(404).json({ error: "No active shop assigned" });
    }

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const qrSessionResult = await pool.query(
      `
        SELECT
          session_id,
          ration_card_id,
          shop_id,
          issued_to_user_id,
          expires_at,
          is_used
        FROM qr_sessions
        WHERE session_id = $1
        LIMIT 1
      `,
      [sessionId],
    );

    if (qrSessionResult.rows.length === 0) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const qrSession = qrSessionResult.rows[0];
    if (qrSession.ration_card_id !== rationCardId) {
      return res.status(400).json({ error: "QR does not match ration card" });
    }
    if (qrSession.shop_id !== shop.id) {
      return res.status(403).json({ error: "QR session belongs to another shop" });
    }
    const beneficiaryUserId =
      req.query?.beneficiary_user_id ||
      req.body?.beneficiary_user_id ||
      qrSession.issued_to_user_id;
    if (!qrSession.issued_to_user_id || qrSession.issued_to_user_id !== beneficiaryUserId) {
      return res.status(403).json({ error: "QR session belongs to another user" });
    }
    if (qrSession.is_used) {
      return res.status(409).json({ error: "QR session already used" });
    }
    if (new Date(qrSession.expires_at) < new Date()) {
      return res.status(401).json({ error: "QR session expired" });
    }

    const result = await pool.query(
      `
        SELECT
          rc.id AS ration_card_id,
          rc.card_number,
          rc.category,
          rc.shop_id,
          s.shop_name,
          a.name AS area_name,
          fm_head.name AS beneficiary_name,
          u.mobile,
          (
            SELECT COUNT(*)
            FROM family_members fm
            WHERE fm.ration_card_id = rc.id
          )::int AS family_size,
          w.rice_balance_kg,
          w.wheat_balance_kg
        FROM ration_cards rc
        JOIN shops s ON s.id = rc.shop_id
        LEFT JOIN areas a ON a.id = rc.area_id
        JOIN family_members fm_head
          ON fm_head.ration_card_id = rc.id
         AND fm_head.is_head = true
        LEFT JOIN users u ON u.id = fm_head.user_id
        JOIN wallets w ON w.ration_card_id = rc.id
        WHERE rc.id = $1
          AND COALESCE(rc.is_active, true) = true
        LIMIT 1
      `,
      [rationCardId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Beneficiary not found" });
    }

    const row = result.rows[0];

    if (row.shop_id !== shop.id) {
      return res
        .status(403)
        .json({ error: "Beneficiary belongs to a different shop" });
    }

    // The household's authoritative allocation for this month, resolved from
    // its category's policy — the same allocationPolicyService call that
    // createSession and commitSession use, so the screen cannot show a figure
    // the backend would then reject.
    //
    // The dispense screen needs this because one allocation is fulfilled by ONE
    // complete transaction: the quantity is not a shopkeeper input, it IS the
    // allocation. Previously the screen had no source for it and left the
    // quantity fields at 0, which made "Weigh on Scale" unreachable and
    // "Confirm Dispense" a guaranteed validation error.
    //
    // Sent alongside the wallet, not instead of it: the allocation is what the
    // card is entitled to this month, the wallet is what is still unclaimed.
    // They differ exactly when the month's claim has already been taken, and
    // the screen has to be able to say so.
    let allocation = null;
    try {
      const cardAllocation = await getCardAllocation(pool, rationCardId);
      if (cardAllocation) {
        allocation = {
          category: cardAllocation.category,
          rice_grams: cardAllocation.riceGrams,
          wheat_grams: cardAllocation.wheatGrams,
          rice_kg: cardAllocation.riceKg,
          wheat_kg: cardAllocation.wheatKg,
        };
      }
    } catch (allocationError) {
      // A policy row that violates the allocation invariant is a configuration
      // fault, not a reason to refuse to show the beneficiary. Reported as a
      // null allocation, which the screen renders as "allocation unavailable"
      // rather than as 0 g (which would look like a legitimate zero).
      logger.error("Failed to resolve card allocation for dispense screen", {
        rationCardId,
        message: allocationError.message,
      });
    }

    return res.status(200).json({
      beneficiary: {
        ration_card_id: row.ration_card_id,
        card_number: row.card_number,
        name: row.beneficiary_name,
        category: row.category,
        mobile: row.mobile,
        family_size: row.family_size,
        shop_name: row.shop_name,
        area_name: row.area_name,
      },
      wallet: {
        rice_balance_kg: toNumber(row.rice_balance_kg),
        wheat_balance_kg: toNumber(row.wheat_balance_kg),
      },
      allocation,
    });
  } catch (error) {
    return next(error);
  }
};

const dispense = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const {
      ration_card_id: rationCardId,
      session_id: sessionId,
      beneficiary_user_id: beneficiaryUserId,
      rice_session_id: riceSessionId,
      wheat_session_id: wheatSessionId,
      rice_qty_kg: riceQtyRaw,
      wheat_qty_kg: wheatQtyRaw,
    } = req.body;

    if (!rationCardId || !sessionId) {
      return res
        .status(400)
        .json({ error: "ration_card_id and session_id are required" });
    }

    if (!riceSessionId || !wheatSessionId) {
      return res.status(400).json({
        error: "Both Rice and Wheat must be successfully verified by IoT scale before final dispense.",
      });
    }

    await client.query("BEGIN");

    const shop = await getAssignedShop(client, req.user.id);
    if (!shop) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No active shop assigned" });
    }

    const sessionResult = await client.query(
      `
        SELECT
          session_id,
          ration_card_id,
          shop_id,
          issued_to_user_id,
          expires_at,
          reserved_until,
          is_used
        FROM qr_sessions
        WHERE session_id = $1
        FOR UPDATE
      `,
      [sessionId],
    );

    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(401).json({ error: "Invalid session" });
    }

    const session = sessionResult.rows[0];
    if (session.ration_card_id !== rationCardId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "QR does not match ration card" });
    }
    if (session.shop_id !== shop.id) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "QR session belongs to another shop" });
    }
    const servedBeneficiaryUserId = beneficiaryUserId || session.issued_to_user_id;
    if (!session.issued_to_user_id || session.issued_to_user_id !== servedBeneficiaryUserId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "QR session belongs to another user" });
    }
    if (session.is_used) {
      // A retry of a distribution that already committed (for example, the
      // response was lost) gets the original transaction back. Nothing is
      // debited or written a second time. Any other reuse of this QR is refused.
      const completed = await client.query(
        `SELECT t.id, t.rice_qty_kg, t.wheat_qty_kg, t.created_at
           FROM dispense_records dr
           JOIN dispense_sessions ds ON ds.id = dr.session_id
           JOIN transactions t ON t.id = dr.transaction_id
          WHERE ds.qr_session_id = $1
          LIMIT 1`,
        [sessionId],
      );
      await client.query("ROLLBACK");
      if (completed.rows.length > 0) {
        const existing = completed.rows[0];
        return res.status(200).json({
          message: "Distribution already completed",
          replayed: true,
          transaction: { id: existing.id, created_at: existing.created_at },
          dispensed: {
            rice_qty_kg: Number(existing.rice_qty_kg),
            wheat_qty_kg: Number(existing.wheat_qty_kg),
          },
        });
      }
      return res.status(409).json({ error: "QR session already used" });
    }
    // Once a weighing has reserved the QR, its reservation window governs
    // expiry. Before any weighing, the QR's own scan expiry does.
    const qrExpired = session.reserved_until
      ? new Date(session.reserved_until) < new Date()
      : new Date(session.expires_at) < new Date();
    if (qrExpired) {
      await client.query("ROLLBACK");
      return res.status(401).json({ error: "QR session expired" });
    }

    // Verify the Rice and Wheat IoT sessions. Each must be captured, belong to
    // this QR, and hold a measurement within tolerance. The session row is the
    // only source of the measurement, never the request body.
    const commodityFailures = [];
    const verifiedSessions = {};
    for (const [commodity, sessionKey] of [
      ["rice", riceSessionId],
      ["wheat", wheatSessionId],
    ]) {
      const label = commodity === "rice" ? "Rice" : "Wheat";
      const result = await client.query(
        `SELECT id, shop_id, ration_card_id, commodity, entitled_grams, tolerance_grams,
                measured_grams, state, qr_session_id
         FROM dispense_sessions WHERE id = $1 FOR UPDATE`,
        [sessionKey],
      );
      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `${label} IoT weighing session not found` });
      }
      const failure = captureFailure(result.rows[0], {
        label,
        commodity,
        rationCardId,
        shopId: shop.id,
        qrSessionId: sessionId,
      });
      if (failure) commodityFailures.push(failure);
      verifiedSessions[commodity] = result.rows[0];
    }
    if (commodityFailures.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: commodityFailures[0] });
    }
    const riceSession = verifiedSessions.rice;
    const wheatSession = verifiedSessions.wheat;

    const riceQty = riceQtyRaw !== undefined ? Number(riceQtyRaw) : (riceSession.entitled_grams / 1000);
    const wheatQty = wheatQtyRaw !== undefined ? Number(wheatQtyRaw) : (wheatSession.entitled_grams / 1000);

    // Monthly eligibility check for both commodities inside transaction
    await assertClaimable(client, rationCardId, ["rice", "wheat"]);
    await assertCompleteAllocation(client, rationCardId, { rice: riceQty, wheat: wheatQty });

    const walletResult = await client.query(
      `
        SELECT
          w.id,
          w.ration_card_id,
          w.rice_balance_kg,
          w.wheat_balance_kg,
          rc.shop_id,
          rc.card_number
        FROM wallets w
        JOIN ration_cards rc ON rc.id = w.ration_card_id
        WHERE w.ration_card_id = $1
        FOR UPDATE
      `,
      [rationCardId],
    );

    if (walletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Wallet not found" });
    }

    const wallet = walletResult.rows[0];
    if (wallet.shop_id !== shop.id) {
      await client.query("ROLLBACK");
      logger.warn('Shop mismatch', { shopkeeper_id: req.user.id, ration_card_id: rationCardId });
      return res.status(403).json({ error: "Wallet belongs to another shop" });
    }

    const riceBalance = toNumber(wallet.rice_balance_kg);
    const wheatBalance = toNumber(wallet.wheat_balance_kg);

    if (riceQty > riceBalance || wheatQty > wheatBalance) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Requested quantity exceeds wallet balance",
        wallet: {
          rice_balance_kg: riceBalance,
          wheat_balance_kg: wheatBalance,
        },
      });
    }

    const remainingRice = Number((riceBalance - riceQty).toFixed(2));
    const remainingWheat = Number((wheatBalance - wheatQty).toFixed(2));

    await client.query(
      `
        UPDATE wallets
        SET
          rice_balance_kg = $1,
          wheat_balance_kg = $2,
          updated_at = NOW()
        WHERE ration_card_id = $3
      `,
      [remainingRice, remainingWheat, rationCardId],
    );

    const txResult = await client.query(
      `
        INSERT INTO transactions (
          ration_card_id,
          shop_id,
          rice_qty_kg,
          wheat_qty_kg,
          served_by
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
      `,
      [rationCardId, shop.id, riceQty, wheatQty, req.user.id],
    );
    const transactionId = txResult.rows[0].id;

    // Write the audit record for each captured measurement, linked to this ONE
    // transaction, under the shop's hash-chain lock. clock_timestamp() gives the
    // two rows distinct ordering keys, so the next chain lookup is unambiguous.
    const chainResult = await client.query(
      `SELECT row_hash FROM dispense_records WHERE shop_id = $1 ORDER BY committed_at DESC LIMIT 1 FOR UPDATE`,
      [shop.id],
    );
    let prevHash = chainResult.rows[0]?.row_hash || null;
    for (const session of [riceSession, wheatSession]) {
      const rowHash = buildRowHash(prevHash, {
        sessionId: session.id,
        rationCardId,
        shopId: shop.id,
        commodity: session.commodity,
        entitledGrams: session.entitled_grams,
        measuredGrams: session.measured_grams,
      });
      await client.query(
        `INSERT INTO dispense_records
           (session_id, ration_card_id, shop_id, commodity, entitled_grams, measured_grams, prev_hash, row_hash, transaction_id, committed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, clock_timestamp())`,
        [
          session.id,
          rationCardId,
          shop.id,
          session.commodity,
          session.entitled_grams,
          session.measured_grams,
          prevHash,
          rowHash,
          transactionId,
        ],
      );
      await client.query(
        `UPDATE dispense_sessions SET state = 'committed', committed_at = NOW() WHERE id = $1`,
        [session.id],
      );
      prevHash = rowHash;
    }

    // Consume the QR. It was row-locked at the top of this transaction and
    // checked not used, so this update must match exactly one row.
    const consumed = await client.query(
      `
        UPDATE qr_sessions
        SET
          is_used = true,
          used_at = NOW()
        WHERE session_id = $1 AND is_used = false
      `,
      [sessionId],
    );
    if (consumed.rowCount !== 1) {
      throw new Error("QR session could not be consumed exactly once");
    }

    await client.query("COMMIT");

    logger.info('Dispense success', { ration_card_id: rationCardId, rice_qty: riceQty, wheat_qty: wheatQty, transaction_id: transactionId });

    // ── Blockchain recording (fire-and-forget after DB commit) ──────────────
    const txRow = txResult.rows[0];
    recordDispense({
      transactionId: txRow.id,
      cardNumber: wallet.card_number || rationCardId,
      shopCode: shop.shop_code,
      riceQtyKg: riceQty,
      wheatQtyKg: wheatQty,
      timestamp: Math.floor(new Date(txRow.created_at).getTime() / 1000),
    }).then(({ success, txHash, error }) => {
      if (success) {
        pool.query(
          "UPDATE transactions SET blockchain_tx_hash = $1 WHERE id = $2",
          [txHash, txRow.id]
        ).catch((dbErr) =>
          logger.error("[Blockchain] Failed to save tx hash to DB", {
            error: dbErr.message, transactionId: txRow.id,
          })
        );
        logger.info("[Blockchain] Hash stored", { txHash, transactionId: txRow.id });
      } else {
        logger.warn("[Blockchain] Recording failed — DB transaction unaffected", {
          error, transactionId: txRow.id,
        });
      }
    }).catch((err) =>
      logger.error("[Blockchain] Unexpected error in recordDispense", {
        error: err.message, transactionId: txRow.id,
      })
    );

    return res.status(200).json({
      message: "Dispensed successfully",
      transaction: txResult.rows[0],
      dispensed: {
        rice_qty_kg: riceQty,
        wheat_qty_kg: wheatQty,
      },
      remaining_wallet: {
        rice_balance_kg: remainingRice,
        wheat_balance_kg: remainingWheat,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Ignore rollback failures and surface original error.
    }

    const claimError = error instanceof MonthlyClaimError ? error : asMonthlyClaimError(error);
    if (claimError) {
      return res.status(400).json({ error: claimError.message, detail: claimError.detail });
    }

    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    }

    return next(error);
  } finally {
    client.release();
  }
};

// POST /api/shopkeeper/transactions — blockchain-stable endpoint
// Shape is final: never rename fields, never remove fields.
const createTransaction = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const {
      ration_card_id: rationCardId,
      rice_qty: riceQtyRaw = 0,
      wheat_qty: wheatQtyRaw = 0,
    } = req.body;

    const riceQty = Number(riceQtyRaw);
    const wheatQty = Number(wheatQtyRaw);

    await client.query('BEGIN');

    // Same shared, per-commodity rule as /dispense — inside the transaction.
    const requestedCommodities = [];
    if (riceQty > 0) requestedCommodities.push('rice');
    if (wheatQty > 0) requestedCommodities.push('wheat');
    await assertClaimable(client, rationCardId, requestedCommodities);
    await assertCompleteAllocation(client, rationCardId, { rice: riceQty, wheat: wheatQty });

    const shop = await getAssignedShop(client, req.user.id);
    if (!shop) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active shop assigned' });
    }

    // Wallet + shop ownership check
    const walletResult = await client.query(
      `SELECT w.id, w.ration_card_id, w.rice_balance_kg, w.wheat_balance_kg,
              rc.shop_id, rc.card_number
       FROM wallets w
       JOIN ration_cards rc ON rc.id = w.ration_card_id
       WHERE w.ration_card_id = $1
       FOR UPDATE`,
      [rationCardId],
    );

    if (walletResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const wallet = walletResult.rows[0];
    if (wallet.shop_id !== shop.id) {
      await client.query('ROLLBACK');
      logger.warn('[Transaction] Shop mismatch', { shopkeeper_id: req.user.id, ration_card_id: rationCardId });
      return res.status(403).json({ error: 'Beneficiary belongs to a different shop' });
    }

    const riceBalance = toNumber(wallet.rice_balance_kg);
    const wheatBalance = toNumber(wallet.wheat_balance_kg);

    if (riceQty > riceBalance || wheatQty > wheatBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Requested quantity exceeds wallet balance',
        wallet: { rice_balance_kg: riceBalance, wheat_balance_kg: wheatBalance },
      });
    }

    const remainingRice = Number((riceBalance - riceQty).toFixed(2));
    const remainingWheat = Number((wheatBalance - wheatQty).toFixed(2));

    await client.query(
      `UPDATE wallets
       SET rice_balance_kg = $1, wheat_balance_kg = $2, updated_at = NOW()
       WHERE ration_card_id = $3`,
      [remainingRice, remainingWheat, rationCardId],
    );

    const txResult = await client.query(
      `INSERT INTO transactions (ration_card_id, shop_id, rice_qty_kg, wheat_qty_kg, served_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, ration_card_id, shop_id, served_by, rice_qty_kg, wheat_qty_kg, created_at`,
      [rationCardId, shop.id, riceQty, wheatQty, req.user.id],
    );

    await client.query('COMMIT');

    const tx = txResult.rows[0];
    logger.info('[Transaction] Success', { ration_card_id: rationCardId, transaction_id: tx.id });

    // ── Blockchain recording (fire-and-forget after DB commit) ──────────────
    // Blockchain failure NEVER rolls back the DB transaction or blocks the response.
    recordDispense({
      transactionId: tx.id,
      cardNumber: wallet.card_number || rationCardId,
      shopCode: shop.shop_code,
      riceQtyKg: riceQty,
      wheatQtyKg: wheatQty,
      timestamp: Math.floor(new Date(tx.created_at).getTime() / 1000),
    }).then(({ success, txHash, error }) => {
      if (success) {
        pool.query(
          "UPDATE transactions SET blockchain_tx_hash = $1 WHERE id = $2",
          [txHash, tx.id]
        ).catch((dbErr) =>
          logger.error("[Blockchain] Failed to save tx hash to DB", {
            error: dbErr.message, transactionId: tx.id,
          })
        );
        logger.info("[Blockchain] Hash stored", { txHash, transactionId: tx.id });
      } else {
        logger.warn("[Blockchain] Recording failed — DB transaction unaffected", {
          error, transactionId: tx.id,
        });
      }
    }).catch((err) =>
      logger.error("[Blockchain] Unexpected error in recordDispense", {
        error: err.message, transactionId: tx.id,
      })
    );

    // Stable blockchain payload — field names and shape are final
    return res.status(200).json({
      success: true,
      transaction: {
        id: tx.id,
        ration_card_id: tx.ration_card_id,
        card_number: wallet.card_number,
        shop_id: tx.shop_id,
        served_by: tx.served_by,
        rice_qty_kg: toNumber(tx.rice_qty_kg),
        wheat_qty_kg: toNumber(tx.wheat_qty_kg),
        created_at: tx.created_at,
        blockchain_tx_hash: null,
      },
      remaining_wallet: {
        rice_balance_kg: remainingRice,
        wheat_balance_kg: remainingWheat,
      },
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { }

    // Either the in-transaction pre-check found an existing claim, or the
    // database's partial unique index rejected a concurrent one. Both mean the
    // same thing to the caller, so both produce the same 400.
    const claimError = error instanceof MonthlyClaimError ? error : asMonthlyClaimError(error);
    if (claimError) {
      return res.status(400).json({ error: claimError.message, detail: claimError.detail });
    }

    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message, detail: error.detail });
    }

    return next(error);
  } finally {
    client.release();
  }
};

module.exports = {
  getMe,
  getBeneficiaryByRationCardId,
  dispense,
  createTransaction,
  getAssignedShop,
};
