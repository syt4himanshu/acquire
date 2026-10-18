const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const logger = require("../config/logger");
const { buildRowHash } = require("./chainRowBuilder");
const { enqueueAnchor } = require("./anchorEnqueuer");
const dispenseSessionBus = require("./dispenseSessionBus");
const stabilityDetectorService = require("./stabilityDetectorService");

// States from which a measurement may be captured. See captureMeasurement.
const CAPTURABLE_SESSION_STATES = ["weighing", "confirming"];
const {
  MAX_DISPENSE_TRANSACTION_GRAMS,
  getCardAllocation,
  allocationGramsFor,
  gramsToKg,
} = require("./allocationPolicyService");
const {
  assertClaimable,
  asMonthlyClaimError,
  MonthlyClaimError,
} = require("./monthlyClaimService");
const metrics = require("../config/metrics");

const SESSION_TTL_MS = 120 * 1000;

// How long a QR stays valid for a distribution once its first weighing has
// reserved it. Long enough to weigh every commodity on the card, short enough
// that a stale QR cannot be used later. This is a policy value: change it here,
// not at each call site.
const QR_RESERVATION_WINDOW_MS = 10 * 60 * 1000;

// States in which a session still holds its commodity slot on a QR. Must match
// the partial unique index in migration 028 and tests/setup.js.
const LIVE_SESSION_STATES = [
  "active",
  "attached",
  "weighing",
  "confirming",
  "captured",
  "committed",
];

const COMMODITY_BALANCE_COLUMN = {
  rice: "rice_balance_kg",
  wheat: "wheat_balance_kg",
};

const toNumber = (value) => Number.parseFloat(value || 0);

// Raised when a commodity has no tolerance configuration. Kept distinct from
// a generic failure so createSession can report a configuration fault rather
// than a transient error.
class ToleranceConfigurationError extends Error {
  constructor(commodity) {
    super(`No tolerance configuration for commodity "${commodity}"`);
    this.name = "ToleranceConfigurationError";
    this.code = "IOT_TOLERANCE_NOT_CONFIGURED";
  }
}

// FAILS CLOSED. This value decides whether a physical measurement is accepted
// as a completed dispense, so a missing row is a configuration fault, not
// something to paper over. This used to fall back to a hardcoded
// { 20 g, 1.00% } whenever the lookup returned nothing, which meant a
// database bootstrapped from schema.sql (which created the table but never
// seeded it) dispensed against an undocumented default while a
// migration-bootstrapped database used the configured one — the same code
// applying two different physical tolerances with nothing in the logs.
//
// Refusing to open the session is safe in practice: the rows are guaranteed
// by schema.sql's seed, migration 011, migration 024 and tests/setup.js, so
// reaching this throw means the deployment is genuinely misconfigured.
const computeToleranceGrams = async (commodity, entitledGrams) => {
  const result = await pool.query(
    `SELECT min_tolerance_grams, tolerance_pct FROM commodity_tolerances WHERE commodity = $1`,
    [commodity],
  );

  const row = result.rows[0];
  if (!row) {
    logger.error(
      "[IoT] Missing commodity tolerance configuration — refusing to open a session",
      {
        commodity,
        hint: "Seed commodity_tolerances (schema.sql section 5, or npm run migrate:up)",
      },
    );
    throw new ToleranceConfigurationError(commodity);
  }

  const pctBased = Math.round(
    (entitledGrams * Number(row.tolerance_pct)) / 100,
  );
  return Math.max(Number(row.min_tolerance_grams), pctBased);
};

// POST /api/dispense/session — called by the shopkeeper's own screen AFTER
// they've already scanned + validated the beneficiary's existing qr_sessions
// QR (see iot-device/PHASE2_DONE.md for why no new QR is introduced here).
// Re-validates and consumes that same qr_sessions row, ties this new
// session's identity assurance to the proven QR mechanism.
const createSession = async ({
  shopId,
  rationCardId,
  commodity,
  entitledGrams,
  qrSessionId,
}) => {
  if (!COMMODITY_BALANCE_COLUMN[commodity]) {
    return {
      ok: false,
      status: 400,
      code: "IOT_INVALID_COMMODITY",
      message: "commodity must be rice or wheat",
    };
  }

  // Business ceiling, checked here as well as in the Joi schema so the
  // service is safe for non-HTTP callers. This is the allocation rule
  // ("what may this household receive in the one transaction that fulfils
  // it"), NOT the load cell's plausibility ceiling (MAX_VALID_GRAMS in
  // config/iot.js), which stays where it is and rejects garbage frames.
  if (
    entitledGrams !== undefined &&
    entitledGrams !== null &&
    Number(entitledGrams) > MAX_DISPENSE_TRANSACTION_GRAMS
  ) {
    return {
      ok: false,
      status: 400,
      code: "IOT_ALLOCATION_EXCEEDED",
      message: `A single dispensing transaction cannot exceed ${MAX_DISPENSE_TRANSACTION_GRAMS} g`,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const qrResult = await client.query(
      `SELECT session_id, ration_card_id, shop_id, is_used, expires_at, reserved_until
       FROM qr_sessions WHERE session_id = $1 FOR UPDATE`,
      [qrSessionId],
    );
    if (qrResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 401,
        code: "IOT_QR_INVALID",
        message: "Invalid QR session",
      };
    }
    const qr = qrResult.rows[0];
    if (qr.ration_card_id !== rationCardId || qr.shop_id !== shopId) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 400,
        code: "IOT_QR_MISMATCH",
        message: "QR does not match beneficiary/shop",
      };
    }
    if (qr.is_used) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "IOT_SESSION_ALREADY_USED",
        message: "QR session already used",
      };
    }
    // Before the first weighing the QR is bound by its scan expiry. Once a
    // session has reserved it, the reservation window governs instead, so the
    // second commodity of the same distribution can still be weighed.
    const qrExpired = qr.reserved_until
      ? new Date(qr.reserved_until) < new Date()
      : new Date(qr.expires_at) < new Date();
    if (qrExpired) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 410,
        code: "IOT_SESSION_EXPIRED",
        message: "QR session expired",
      };
    }

    // Monthly eligibility, checked up front so the shopkeeper is told
    // BEFORE they pour grain onto the scale. commitSession re-checks — this
    // is a usability guard, not the guarantee.
    try {
      await assertClaimable(client, rationCardId, [commodity]);
    } catch (err) {
      if (err instanceof MonthlyClaimError) {
        await client.query("ROLLBACK");
        return { ok: false, status: 400, code: err.code, message: err.detail };
      }
      throw err;
    }

    // BUG 1 FIX — the session's entitled_grams is DERIVED, never accepted.
    //
    // The business model is one allocation -> one complete transaction, so
    // a session must be opened for the household's whole authorised
    // allocation for that commodity. Previously this number came straight
    // from the request body, so a caller could open a session for 1000 g
    // against a 3000 g allocation: it committed, consumed the month's rice
    // claim, and stranded 2000 g in the wallet that could never be
    // claimed. The value is now read from the authoritative policy and a
    // mismatched client value is rejected outright — not clamped, not
    // Math.min'd, not silently ignored.
    const allocation = await getCardAllocation(client, rationCardId);
    if (!allocation) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "IOT_ALLOCATION_NOT_FOUND",
        message: "No allocation policy for this ration card",
      };
    }
    const allocationGrams = allocationGramsFor(allocation, commodity);

    if (
      entitledGrams !== undefined &&
      entitledGrams !== null &&
      Number(entitledGrams) !== allocationGrams
    ) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 400,
        code: "IOT_PARTIAL_ALLOCATION",
        message:
          `A dispensing session must cover the complete ${commodity} allocation of ` +
          `${allocationGrams} g for this ration card (requested ${Number(
            entitledGrams,
          )} g). ` +
          `Partial dispensing is not supported.`,
      };
    }

    const walletResult = await client.query(
      `SELECT rice_balance_kg, wheat_balance_kg FROM wallets WHERE ration_card_id = $1`,
      [rationCardId],
    );
    if (walletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "IOT_WALLET_NOT_FOUND",
        message: "Wallet not found",
      };
    }
    const balanceKg = toNumber(
      walletResult.rows[0][COMMODITY_BALANCE_COLUMN[commodity]],
    );
    // The wallet must still hold the whole allocation. If it does not, the
    // card has already been served (or was funded off-policy) and this
    // session could not complete in one transaction.
    if (allocationGrams > balanceKg * 1000) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 400,
        code: "IOT_INSUFFICIENT_BALANCE",
        message: "Entitled amount exceeds wallet balance",
      };
    }

    const toleranceGrams = await computeToleranceGrams(
      commodity,
      allocationGrams,
    );
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    // The QR row lock above serialises concurrent creates for this QR, so this
    // check cannot race another create. A cancelled or failed session releases
    // its commodity so the shopkeeper can re-weigh; every other state holds it.
    const liveResult = await client.query(
      `SELECT id FROM dispense_sessions
       WHERE qr_session_id = $1 AND commodity = $2 AND state = ANY($3::text[])`,
      [qrSessionId, commodity, LIVE_SESSION_STATES],
    );
    if (liveResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "IOT_SESSION_IN_PROGRESS",
        message: `A ${commodity} weighing already exists for this QR`,
      };
    }

    const sessionResult = await client.query(
      `INSERT INTO dispense_sessions (shop_id, ration_card_id, commodity, entitled_grams, tolerance_grams, expires_at, qr_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, expires_at`,
      [
        shopId,
        rationCardId,
        commodity,
        allocationGrams,
        toleranceGrams,
        expiresAt,
        qrSessionId,
      ],
    );
    const session = sessionResult.rows[0];

    // Reserve, do not consume. The QR is marked used only by the final
    // distribution (POST /api/shopkeeper/dispense). The reservation starts at
    // the first weighing and is written once, so later commodities cannot
    // extend it.
    await client.query(
      `UPDATE qr_sessions
       SET reserved_at = COALESCE(reserved_at, NOW()),
           reserved_until = COALESCE(reserved_until, NOW() + ($2 * INTERVAL '1 millisecond'))
       WHERE session_id = $1`,
      [qrSessionId, QR_RESERVATION_WINDOW_MS],
    );

    const jti = crypto.randomUUID();
    const sessionJwt = jwt.sign(
      { sessionId: session.id, jti },
      process.env.JWT_SECRET,
      {
        expiresIn: Math.floor(SESSION_TTL_MS / 1000),
      },
    );

    await client.query("COMMIT");

    metrics.sessionsCounter.inc({ shop_id: shopId });
    logger.info("[IoT] Dispense session created", {
      shopId,
      sessionId: session.id,
      commodity,
      entitledGrams: allocationGrams,
    });

    return {
      ok: true,
      sessionId: session.id,
      sessionJwt,
      expiresAt: session.expires_at,
      entitledGrams: allocationGrams,
      toleranceGrams,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore rollback failure, surface the original error
    }
    if (err instanceof ToleranceConfigurationError) {
      return {
        ok: false,
        status: 500,
        code: err.code,
        message: "Dispensing tolerance is not configured for this commodity",
      };
    }
    // The partial unique index is the backstop if two creates ever reach the
    // INSERT together: the loser gets the same answer as the lock-based check.
    if (err.code === "23505") {
      return {
        ok: false,
        status: 409,
        code: "IOT_SESSION_IN_PROGRESS",
        message: `A ${commodity} weighing already exists for this QR`,
      };
    }
    logger.error("[IoT] createSession failed", {
      shopId,
      message: err.message,
    });
    return {
      ok: false,
      status: 500,
      code: "IOT_SESSION_CREATE_FAILED",
      message: "Failed to create session",
    };
  } finally {
    client.release();
  }
};

// POST /api/dispense/session/:id/attach
const attachSession = async (sessionId, sessionJwt, shopId) => {
  let decoded;
  try {
    decoded = jwt.verify(sessionJwt, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return {
        ok: false,
        status: 410,
        code: "IOT_SESSION_EXPIRED",
        message: "Session expired",
      };
    }
    return {
      ok: false,
      status: 401,
      code: "IOT_SESSION_INVALID",
      message: "Invalid session token",
    };
  }

  if (decoded.sessionId !== sessionId) {
    return {
      ok: false,
      status: 400,
      code: "IOT_SESSION_MISMATCH",
      message: "Token does not match session",
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jtiCheck = await client.query(
      `SELECT jti FROM used_jtis WHERE jti = $1`,
      [decoded.jti],
    );
    if (jtiCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "IOT_SESSION_ALREADY_USED",
        message: "Session token already used",
      };
    }

    const sessionResult = await client.query(
      `SELECT id, shop_id, state, expires_at FROM dispense_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "IOT_SESSION_NOT_FOUND",
        message: "Session not found",
      };
    }
    const session = sessionResult.rows[0];
    if (session.shop_id !== shopId) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 403,
        code: "IOT_SESSION_WRONG_SHOP",
        message: "Session belongs to another shop",
      };
    }
    if (session.state !== "active") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "IOT_SESSION_NOT_ACTIVE",
        message: `Session is ${session.state}`,
      };
    }
    if (new Date(session.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      await pool.query(
        `UPDATE dispense_sessions SET state = 'expired' WHERE id = $1`,
        [sessionId],
      );
      return {
        ok: false,
        status: 410,
        code: "IOT_SESSION_EXPIRED",
        message: "Session expired",
      };
    }

    const deviceResult = await client.query(
      `SELECT device_id FROM iot_devices WHERE shop_id = $1 AND status = 'active' LIMIT 1`,
      [shopId],
    );
    if (deviceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "IOT_DEVICE_NOT_FOUND",
        message: "No active IoT device for this shop",
      };
    }
    const deviceId = deviceResult.rows[0].device_id;

    await client.query(
      `INSERT INTO used_jtis (jti, session_id) VALUES ($1, $2)`,
      [decoded.jti, sessionId],
    );
    await client.query(
      `UPDATE dispense_sessions SET state = 'attached', device_id = $1, attached_at = NOW() WHERE id = $2`,
      [deviceId, sessionId],
    );

    await client.query("COMMIT");

    dispenseSessionBus.publish(sessionId, { type: "state", state: "attached" });

    return { ok: true, sessionId, deviceId, state: "attached" };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore rollback failure, surface the original error
    }
    logger.error("[IoT] attachSession failed", {
      message: err.message,
      sessionId,
    });
    return {
      ok: false,
      status: 500,
      code: "IOT_ATTACH_FAILED",
      message: "Failed to attach session",
    };
  } finally {
    client.release();
  }
};

// POST /api/dispense/session/:id/cancel — the shopkeeper's Cancel button,
// available any time before commit.
const cancelSession = async (sessionId, shopId) => {
  const result = await pool.query(
    `UPDATE dispense_sessions
     SET state = 'cancelled'
     WHERE id = $1 AND shop_id = $2
       AND state IN ('active','attached','weighing','confirming')
     RETURNING id`,
    [sessionId, shopId],
  );

  if (result.rows.length === 0) {
    return {
      ok: false,
      status: 409,
      code: "IOT_SESSION_NOT_CANCELLABLE",
      message: "Session cannot be cancelled in its current state",
    };
  }

  dispenseSessionBus.publish(sessionId, { type: "state", state: "cancelled" });
  return { ok: true, sessionId, state: "cancelled" };
};

// Phase 1 capture: validate and freeze a physical measurement, then close only
// the weighing session. PROTOTYPE: the measurement is the newest reading for the
// session, accepted only if it is fresh, valid and within tolerance. It is not
// the multi-sample stability check, so it is less reliable than a confirmed
// 'confirming' state. This deliberately does not call commitSession,
// create a dispense_record, debit a wallet, or create a ration transaction.
const captureMeasurement = async (sessionId, shopId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT id, shop_id, state, entitled_grams, tolerance_grams, commodity
         FROM dispense_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "IOT_SESSION_NOT_FOUND",
        message: "Session not found",
      };
    }

    const session = sessionResult.rows[0];
    if (session.shop_id !== shopId) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 403,
        code: "IOT_SESSION_WRONG_SHOP",
        message: "Session belongs to another shop",
      };
    }
    // Capturable from 'weighing' (prototype: a single fresh in-range reading)
    // or 'confirming' (the multi-sample stability rule already passed). The
    // row lock above serialises concurrent captures: the second one reads
    // 'captured' here and is refused.
    if (!CAPTURABLE_SESSION_STATES.includes(session.state)) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "IOT_MEASUREMENT_NOT_STABLE",
        message: "This session is not open for a scale measurement",
      };
    }

    // Only the newest reading for THIS session is judged. Readings from other
    // sessions or devices never reach this check, because sensor_readings is
    // stamped with session_id at ingestion.
    const latestResult = await client.query(
      `SELECT grams_int, taken_at FROM sensor_readings
         WHERE session_id = $1
         ORDER BY taken_at DESC
         LIMIT 1`,
      [sessionId],
    );
    const nowMs = Date.now();
    const latest = latestResult.rows[0]
      ? {
          gramsInt: Number(latestResult.rows[0].grams_int),
          takenAtMs: new Date(latestResult.rows[0].taken_at).getTime(),
        }
      : null;

    const check = stabilityDetectorService.evaluateCaptureReading(
      latest,
      nowMs,
      Number(session.entitled_grams),
      Number(session.tolerance_grams),
    );
    if (!check.ok) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: check.code,
        message: check.message,
      };
    }

    const measuredGrams = check.grams;

    // The frozen measurement is stored on the session so the final distribution
    // reads what was captured, not a figure the client sends back. The state
    // guard in WHERE makes this atomic with the check above: a session that
    // changed under us is not captured.
    const captured = await client.query(
      `UPDATE dispense_sessions SET state = 'captured', measured_grams = $3
         WHERE id = $1 AND shop_id = $2 AND state IN ('weighing', 'confirming')`,
      [sessionId, shopId, measuredGrams],
    );
    if (captured.rowCount !== 1) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "IOT_MEASUREMENT_NOT_STABLE",
        message: "This session is not open for a scale measurement",
      };
    }
    await client.query("COMMIT");

    dispenseSessionBus.publish(sessionId, {
      type: "state",
      state: "captured",
      measuredGrams,
    });

    return {
      ok: true,
      sessionId,
      commodity: session.commodity,
      entitledGrams: Number(session.entitled_grams),
      toleranceGrams: Number(session.tolerance_grams),
      measuredGrams,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve the original failure.
    }
    logger.error("[IoT] captureMeasurement failed", {
      message: err.message,
      sessionId,
    });
    return {
      ok: false,
      status: 500,
      code: "IOT_MEASUREMENT_CAPTURE_FAILED",
      message: "Could not capture the scale reading",
    };
  } finally {
    client.release();
  }
};

// GET /api/dispense/session/:id — status fallback for reconnects.
const getSessionStatus = async (sessionId, shopId) => {
  const result = await pool.query(
    `SELECT id, state, commodity, entitled_grams, tolerance_grams, device_id, expires_at
     FROM dispense_sessions WHERE id = $1 AND shop_id = $2`,
    [sessionId, shopId],
  );
  if (result.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "IOT_SESSION_NOT_FOUND",
      message: "Session not found",
    };
  }
  return { ok: true, session: result.rows[0] };
};

// Called by ws/iotSocketServer.js on every reading to find the session (if
// any) currently gating this device — the exact lookup the (device_id,
// state) index on dispense_sessions exists for.
const findAttachedSessionForDevice = async (deviceId) => {
  const result = await pool.query(
    `SELECT id, state, entitled_grams, tolerance_grams, ration_card_id, shop_id, commodity
     FROM dispense_sessions
     WHERE device_id = $1 AND state IN ('attached','weighing','confirming')
     LIMIT 1`,
    [deviceId],
  );
  return result.rows[0] || null;
};

// State-machine transitions driven by ws/iotSocketServer.js as readings
// arrive. Each returns true iff it actually applied (guards against racing
// with a cancel/device_lost that happened in between).
const beginWeighing = async (sessionId) => {
  const result = await pool.query(
    `UPDATE dispense_sessions SET state = 'weighing' WHERE id = $1 AND state = 'attached' RETURNING id`,
    [sessionId],
  );
  if (result.rows.length > 0) {
    dispenseSessionBus.publish(sessionId, { type: "state", state: "weighing" });
    return true;
  }
  return false;
};

const beginConfirming = async (sessionId) => {
  const result = await pool.query(
    `UPDATE dispense_sessions SET state = 'confirming' WHERE id = $1 AND state = 'weighing' RETURNING id`,
    [sessionId],
  );
  return result.rows.length > 0;
};

const revertToWeighing = async (sessionId) => {
  const result = await pool.query(
    `UPDATE dispense_sessions SET state = 'weighing' WHERE id = $1 AND state = 'confirming' RETURNING id`,
    [sessionId],
  );
  if (result.rows.length > 0) {
    dispenseSessionBus.publish(sessionId, { type: "state", state: "weighing" });
    return true;
  }
  return false;
};

// Called by ws/iotSocketServer.js when a device with an attached session
// disconnects — no partial commits, session moves to a terminal state.
const markDeviceLost = async (deviceId) => {
  const result = await pool.query(
    `UPDATE dispense_sessions
     SET state = 'device_lost'
     WHERE device_id = $1 AND state IN ('attached','weighing','confirming')
     RETURNING id`,
    [deviceId],
  );
  for (const row of result.rows) {
    dispenseSessionBus.publish(row.id, { type: "state", state: "device_lost" });
  }
};

// Lazily expires an 'active' (never attached) session found past its TTL —
// avoided adding a dedicated sweep cron for this since attach/create already
// check expiry inline; this just keeps the state field accurate for readers.
const expireIfStale = async (sessionId) => {
  await pool.query(
    `UPDATE dispense_sessions SET state = 'expired'
     WHERE id = $1 AND state = 'active' AND expires_at < NOW()`,
    [sessionId],
  );
};

// The single-transaction commit: hash-chain link + wallet debit (lock-free,
// WHERE-guarded) + canonical `transactions` row + ledger row + session state,
// all-or-nothing. Called from ws/iotSocketServer.js's state machine once the
// stability rule holds through the confirming countdown.
//
// The `transactions` INSERT is what makes an IoT dispense visible to
// analytics, anomaly detection and the activity feed — they all read that
// table and nothing else. It lives inside this same BEGIN/COMMIT precisely so
// the wallet debit and the business transaction can never disagree: if either
// fails, both roll back.
//
// Idempotency rides on the existing UNIQUE index on dispense_records.
// session_id, so retrying one physical dispense cannot produce a second
// business transaction. Two guards, in order:
//   1. the SELECT ... FOR UPDATE below serialises concurrent commits of the
//      same session; the loser sees state='committed' and returns
//      invalid_state before writing anything.
//   2. if a caller somehow reaches the INSERT anyway, the unique index
//      aborts the whole transaction — including the `transactions` row —
//      so no orphan business transaction can survive a duplicate commit.
const commitSession = async (sessionId, measuredGrams) => {
  const endCommitTimer = metrics.commitLatencyHistogram.startTimer();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // shopkeeper_id is joined in to populate transactions.served_by:
    // dispense_sessions has no user column, and createSession only ever
    // accepts a shopId resolved from the calling shopkeeper's own
    // getAssignedShop(), so the shop's assigned shopkeeper *is* the user
    // who served this dispense. FOR UPDATE OF ds keeps the row lock on
    // dispense_sessions alone — shops is read-only here.
    const sessionResult = await client.query(
      `SELECT ds.id, ds.shop_id, ds.ration_card_id, ds.commodity, ds.entitled_grams,
              ds.tolerance_grams, ds.state, s.shopkeeper_id
       FROM dispense_sessions ds
       JOIN shops s ON s.id = ds.shop_id
       WHERE ds.id = $1
       FOR UPDATE OF ds`,
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, reason: "not_found" };
    }
    const session = sessionResult.rows[0];
    if (!["weighing", "confirming"].includes(session.state)) {
      await client.query("ROLLBACK");
      return { success: false, reason: `invalid_state:${session.state}` };
    }

    const columnName = COMMODITY_BALANCE_COLUMN[session.commodity];
    if (!columnName) {
      await client.query("ROLLBACK");
      return { success: false, reason: "invalid_commodity" };
    }

    // BUG 3 FIX — tolerance enforced at the commit boundary.
    //
    // stabilityDetectorService already refuses to auto-confirm a reading
    // outside tolerance, and that check stays. But the stability detector
    // lives in the WebSocket loop, while THIS is the point where the
    // wallet, transactions and dispense_records are permanently mutated.
    // Any other caller of commitSession previously bypassed tolerance
    // entirely (verified: a 2400 g measurement against a 3000 g / 30 g
    // session committed). The authoritative check belongs here, before
    // anything is written.
    const entitledGrams = Number(session.entitled_grams);
    const toleranceGrams = Number(session.tolerance_grams);
    const deviation = Math.abs(measuredGrams - entitledGrams);

    if (!Number.isInteger(measuredGrams) || deviation > toleranceGrams) {
      await client.query("ROLLBACK");
      logger.warn("[IoT] Commit rejected — measurement outside tolerance", {
        sessionId,
        entitledGrams,
        measuredGrams,
        toleranceGrams,
        deviation,
      });
      await pool
        .query(
          `UPDATE dispense_sessions SET state = 'failed_out_of_tolerance' WHERE id = $1`,
          [sessionId],
        )
        .catch(() => {
          /* best effort — the commit already rolled back */
        });
      dispenseSessionBus.publish(sessionId, {
        type: "state",
        state: "failed_out_of_tolerance",
      });
      return { success: false, reason: "out_of_tolerance" };
    }

    // Monthly eligibility for the commodity about to be committed, in the
    // SAME transaction as the wallet debit and the INSERT below. A session
    // can sit open while another path claims the same commodity, so the
    // decision has to be made here, not only at session creation.
    //
    // This does NOT conflict with IoT idempotency: a retry of an
    // already-committed session is rejected earlier by the state guard
    // (`weighing`/`confirming` only) and by the UNIQUE index on
    // dispense_records.session_id, so one physical dispense stays exactly
    // one claim, one debit and one transaction.
    await assertClaimable(client, session.ration_card_id, [session.commodity]);

    const walletResult = await client.query(
      `SELECT id, ration_card_id, rice_balance_kg, wheat_balance_kg
       FROM wallets
       WHERE ration_card_id = $1
       FOR UPDATE`,
      [session.ration_card_id],
    );
    if (walletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, reason: "wallet_not_found" };
    }

    const balanceKg = Number(walletResult.rows[0][columnName] || 0);
    const entitledKg = Number(session.entitled_grams) / 1000;
    if (entitledKg > balanceKg) {
      await client.query(
        `UPDATE dispense_sessions
         SET state = 'failed_insufficient_balance'
         WHERE id = $1`,
        [sessionId],
      );
      await client.query("COMMIT");
      dispenseSessionBus.publish(sessionId, {
        type: "state",
        state: "failed_insufficient_balance",
      });
      return { success: false, reason: "insufficient_balance" };
    }

    const remainingBalance = Number((balanceKg - entitledKg).toFixed(2));
    await client.query(
      `UPDATE wallets
       SET ${columnName} = $1, updated_at = NOW()
       WHERE ration_card_id = $2`,
      [remainingBalance, session.ration_card_id],
    );

    // Per-shop hash-chain lock — serializes commits for this shop only
    // (a single ESP32 per shop means dispenses there are already
    // physically sequential, so this never contends across shops).
    const chainResult = await client.query(
      `SELECT row_hash FROM dispense_records WHERE shop_id = $1 ORDER BY committed_at DESC LIMIT 1 FOR UPDATE`,
      [session.shop_id],
    );
    const prevHash = chainResult.rows[0]?.row_hash || null;

    // BUG 2 FIX + partial-underfill decision — the wallet is debited by the
    // AUTHORISED ALLOCATION, never by the raw measurement.
    //
    // Tolerance means "the physical measurement is close enough to treat
    // this allocation as fulfilled". It is not extra entitlement, and it is
    // not a licence to under-serve. Debiting the measurement produced two
    // defects at once:
    //
    //   overfill  3010 g measured vs a 3.00 kg wallet -> tried to debit
    //             3.01 kg, failed the balance guard, and reported
    //             "insufficient balance" for an in-spec dispense.
    //   underfill 2990 g measured -> debited 2.99 kg and left 0.01 kg
    //             stranded: unclaimable, because the month's commodity
    //             claim was consumed by this very transaction.
    //
    // Debiting the allocation fixes both and is the only option of the
    // three that preserves one-allocation/one-complete-transaction:
    //   (A) debit the allocation      <- chosen
    // buildRowHash's input is deliberately unchanged — transaction_id is
    // not hashed. The per-shop chain must stay verifiable against records
    // written before this link existed.
    const fields = {
      sessionId: session.id,
      rationCardId: session.ration_card_id,
      shopId: session.shop_id,
      commodity: session.commodity,
      entitledGrams: session.entitled_grams,
      measuredGrams,
    };
    const rowHash = buildRowHash(prevHash, fields);

    // Record the verified measurement. transaction_id remains NULL until the final multi-commodity dispense transaction.
    const recordResult = await client.query(
      `INSERT INTO dispense_records
         (session_id, ration_card_id, shop_id, commodity, entitled_grams, measured_grams, prev_hash, row_hash, transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)
       RETURNING id`,
      [
        session.id,
        session.ration_card_id,
        session.shop_id,
        session.commodity,
        session.entitled_grams,
        measuredGrams,
        prevHash,
        rowHash,
      ],
    );

    await client.query(
      `UPDATE dispense_sessions SET state = 'committed', committed_at = NOW() WHERE id = $1`,
      [sessionId],
    );

    await client.query("COMMIT");

    const dispenseRecordId = recordResult.rows[0].id;

    dispenseSessionBus.publish(sessionId, {
      type: "state",
      state: "committed",
      measuredGrams,
      dispenseRecordId,
    });

    return { success: true, dispenseRecordId };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore rollback failure, surface the original error
    }
    const claimError =
      err instanceof MonthlyClaimError ? err : asMonthlyClaimError(err);
    if (claimError) {
      await pool
        .query(
          `UPDATE dispense_sessions SET state = 'failed_already_claimed' WHERE id = $1`,
          [sessionId],
        )
        .catch(() => {
          /* state is best-effort; the commit already rolled back */
        });
      dispenseSessionBus.publish(sessionId, {
        type: "state",
        state: "failed_already_claimed",
      });
      return { success: false, reason: "already_claimed" };
    }
    logger.error("[IoT] commitSession failed", {
      message: err.message,
      sessionId,
    });
    return { success: false, reason: "error" };
  } finally {
    client.release();
    endCommitTimer();
  }
};

// POST /api/dispense/session/:id/confirm — manual confirm by shopkeeper when
// they click OK on a stable weight. Only works if the session is in the
// 'confirming' state (i.e., the backend stability detector already passed).
// Derives measuredGrams from the most recent sensor_readings in the stability
// window (same logic the auto-timer uses, just pulled from the DB instead of
// the WebSocket's in-memory sessionReadings array).
const manualConfirm = async (sessionId, shopId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT id, shop_id, state, entitled_grams, tolerance_grams, commodity
       FROM dispense_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    if (sessionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 404,
        code: "IOT_SESSION_NOT_FOUND",
        message: "Session not found",
      };
    }
    const session = sessionResult.rows[0];
    if (session.shop_id !== shopId) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 403,
        code: "IOT_SESSION_WRONG_SHOP",
        message: "Session belongs to another shop",
      };
    }
    if (session.state !== "confirming") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        code: "IOT_SESSION_NOT_CONFIRMING",
        message: `Session is ${session.state}, not confirming`,
      };
    }

    // Query the most recent sensor readings for this session within the
    // stability window (3 seconds). The stability detector already verified
    // that these readings are stable and within tolerance when it moved the
    // session to 'confirming', so this is just re-deriving the same
    // measurement the auto-timer would have used.
    const { STABILITY_WINDOW_MS } = require("../config/iot");
    const readingsResult = await client.query(
      `SELECT grams_int FROM sensor_readings
       WHERE session_id = $1 AND taken_at >= NOW() - INTERVAL '1 millisecond' * $2
       ORDER BY taken_at DESC`,
      [sessionId, STABILITY_WINDOW_MS],
    );

    if (readingsResult.rows.length === 0) {
      await client.query("ROLLBACK");
      logger.warn(
        "[IoT] No readings in stability window at manual confirm time",
        { sessionId },
      );
      return {
        ok: false,
        status: 400,
        code: "IOT_NO_READINGS",
        message: "No readings available to confirm",
      };
    }

    const measuredGrams = Math.round(
      readingsResult.rows.reduce((sum, r) => sum + Number(r.grams_int), 0) /
        readingsResult.rows.length,
    );

    await client.query("ROLLBACK");

    // Commit outside the transaction so commitSession's own transaction
    // isn't nested (pool.connect() doesn't support nested transactions).
    const result = await commitSession(sessionId, measuredGrams);
    if (!result.success) {
      return {
        ok: false,
        status: 400,
        code: "IOT_COMMIT_FAILED",
        message: `Commit failed: ${result.reason}`,
      };
    }

    return {
      ok: true,
      sessionId,
      state: "committed",
      measuredGrams,
      dispenseRecordId: result.dispenseRecordId,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore
    }
    logger.error("[IoT] manualConfirm failed", {
      message: err.message,
      sessionId,
    });
    return {
      ok: false,
      status: 500,
      code: "IOT_CONFIRM_FAILED",
      message: "Manual confirm failed",
    };
  } finally {
    client.release();
  }
};

module.exports = {
  ToleranceConfigurationError,
  computeToleranceGrams,
  createSession,
  attachSession,
  cancelSession,
  captureMeasurement,
  getSessionStatus,
  findAttachedSessionForDevice,
  beginWeighing,
  beginConfirming,
  revertToWeighing,
  markDeviceLost,
  expireIfStale,
  commitSession,
  manualConfirm,
  COMMODITY_BALANCE_COLUMN,
};
