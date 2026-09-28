const pool = require("../config/db");
const crypto = require("crypto");

const toNumber = (v) => Number.parseFloat(v || 0);

// GET /api/beneficiary/me
const getMe = async (req, res, next) => {
    try {
        const userId = req.user.id;

        const result = await pool.query(
            `
      SELECT
        rc.id AS ration_card_id,
        rc.card_number,
        rc.category,
        fm.name AS head_name,
        u.mobile,
        s.shop_name,
        a.name AS area_name
      FROM family_members fm
      JOIN ration_cards rc ON rc.id = fm.ration_card_id
      JOIN users u ON u.id = fm.user_id
      LEFT JOIN shops s ON s.id = rc.shop_id
      LEFT JOIN areas a ON a.id = rc.area_id
      WHERE fm.user_id = $1 AND fm.is_head = true
      LIMIT 1
      `,
            [userId],
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Beneficiary profile not found" });
        }

        return res.status(200).json({ beneficiary: result.rows[0] });
    } catch (err) {
        return next(err);
    }
};

// GET /api/beneficiary/wallet
const getWallet = async (req, res, next) => {
    try {
        const userId = req.user.id;

        const result = await pool.query(
            `
      SELECT w.rice_balance_kg, w.wheat_balance_kg
      FROM wallets w
      JOIN ration_cards rc ON rc.id = w.ration_card_id
      JOIN family_members fm ON fm.ration_card_id = rc.id
      WHERE fm.user_id = $1 AND fm.is_head = true
      LIMIT 1
      `,
            [userId],
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Wallet not found" });
        }

        const row = result.rows[0];
        return res.status(200).json({
            wallet: {
                rice_balance_kg: toNumber(row.rice_balance_kg),
                wheat_balance_kg: toNumber(row.wheat_balance_kg),
            },
        });
    } catch (err) {
        return next(err);
    }
};

// GET /api/beneficiary/family
const getFamily = async (req, res, next) => {
    try {
        const userId = req.user.id;

        // First get the ration card for this user
        const rcResult = await pool.query(
            `SELECT rc.id FROM ration_cards rc
       JOIN family_members fm ON fm.ration_card_id = rc.id
       WHERE fm.user_id = $1 AND fm.is_head = true
       LIMIT 1`,
            [userId],
        );

        if (rcResult.rows.length === 0) {
            return res.status(404).json({ error: "Ration card not found" });
        }

        const rationCardId = rcResult.rows[0].id;

        const result = await pool.query(
            `SELECT name, age, is_head FROM family_members
       WHERE ration_card_id = $1
       ORDER BY is_head DESC, name ASC`,
            [rationCardId],
        );

        return res.status(200).json({ family: result.rows });
    } catch (err) {
        return next(err);
    }
};

// GET /api/beneficiary/transactions
const getTransactions = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);

        const result = await pool.query(
            `
      SELECT
        t.id,
        t.rice_qty_kg,
        t.wheat_qty_kg,
        t.created_at,
        s.shop_name
      FROM transactions t
      JOIN ration_cards rc ON rc.id = t.ration_card_id
      JOIN family_members fm ON fm.ration_card_id = rc.id
      JOIN shops s ON s.id = t.shop_id
      WHERE fm.user_id = $1 AND fm.is_head = true
      ORDER BY t.created_at DESC
      LIMIT $2
      `,
            [userId, limit],
        );

        return res.status(200).json({ transactions: result.rows });
    } catch (err) {
        return next(err);
    }
};

// POST /api/beneficiary/qr-session
const createQrSession = async (req, res, next) => {
    try {
        const userId = req.user.id;

        // Get ration card + assigned shop
        const rcResult = await pool.query(
            `
      SELECT rc.id AS ration_card_id, rc.shop_id
      FROM ration_cards rc
      JOIN family_members fm ON fm.ration_card_id = rc.id
      WHERE fm.user_id = $1 AND fm.is_head = true
        AND COALESCE(rc.is_active, true) = true
      LIMIT 1
      `,
            [userId],
        );

        if (rcResult.rows.length === 0) {
            return res.status(404).json({ error: "Ration card not found" });
        }

        const { ration_card_id: rationCardId, shop_id: shopId } = rcResult.rows[0];

        const sessionId = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 120 * 1000); // 120 seconds

        await pool.query(
            `INSERT INTO qr_sessions
         (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
            [sessionId, rationCardId, shopId, userId, expiresAt],
        );

        return res.status(201).json({
            rationCardId,
            sessionId,
            expiresAt: expiresAt.toISOString(),
        });
    } catch (err) {
        return next(err);
    }
};

module.exports = { getMe, getWallet, getFamily, getTransactions, createQrSession };
