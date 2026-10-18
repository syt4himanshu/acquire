const bcrypt = require("bcrypt");
const crypto = require("crypto");
const pool = require("../config/db");
const logger = require("../config/logger");
const blockchainHealthService = require("../services/blockchainHealthService");
const {
  POLICY_SELECT_COLUMNS,
  allocationForPolicy,
} = require("../services/allocationPolicyService");

const ALLOWED_CATEGORIES = ["APL", "BPL", "AAY"];

const normalizeIndianMobile = (value = "") => {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return null;
};

const createRationCard = async (req, res, next) => {
  const client = await pool.connect();
  const { card_number, category, shop_id, head, members = [] } = req.body;

  try {
    if (
      !card_number ||
      !category ||
      !shop_id ||
      !head ||
      !Array.isArray(members)
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const headMobile = head.mobile ? head.mobile.trim() : '';
    if (!head.name || typeof head.age !== "number" || !headMobile) {
      return res.status(400).json({ error: "Invalid head details" });
    }

    await client.query("BEGIN");

    const existingCardResult = await client.query(
      "SELECT id FROM ration_cards WHERE card_number = $1 LIMIT 1",
      [card_number],
    );
    if (existingCardResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "card_number already exists" });
    }

    const shopExistsResult = await client.query(
      "SELECT id FROM shops WHERE id = $1 LIMIT 1",
      [shop_id],
    );
    if (shopExistsResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid shop_id" });
    }

    const mobileExistsResult = await client.query(
      `SELECT u.id FROM users u
       WHERE u.mobile = $1 AND u.role = 'beneficiary' LIMIT 1`,
      [headMobile],
    );
    if (mobileExistsResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "This mobile number is already registered to a beneficiary" });
    }

    const policyResult = await client.query(
      `SELECT ${POLICY_SELECT_COLUMNS}
       FROM policies WHERE category = $1 LIMIT 1`,
      [category],
    );
    if (policyResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: `Policy not found for category ${category}` });
    }
    const policy = policyResult.rows[0];

    const headUserResult = await client.query(
      "INSERT INTO users (role, mobile) VALUES ('beneficiary', $1) RETURNING id",
      [headMobile],
    );
    const headUserId = headUserResult.rows[0].id;

    const shopAreaResult = await client.query(
      "SELECT area_id FROM shops WHERE id = $1 LIMIT 1",
      [shop_id],
    );
    const areaId = shopAreaResult.rows[0].area_id;

    const rationCardResult = await client.query(
      `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, card_number`,
      [card_number, category, headUserId, shop_id, areaId],
    );
    const rationCard = rationCardResult.rows[0];

    await client.query(
      `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head)
       VALUES ($1, $2, $3, $4, true)`,
      [rationCard.id, headUserId, head.name, head.age],
    );

    for (const member of members) {
      if (!member.name || typeof member.age !== "number") {
        throw new Error("Invalid member details");
      }
      const memberUserResult = await client.query(
        "INSERT INTO users (role, mobile) VALUES ('beneficiary', NULL) RETURNING id",
      );
      const memberUserId = memberUserResult.rows[0].id;
      await client.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head)
         VALUES ($1, $2, $3, $4, false)`,
        [rationCard.id, memberUserId, member.name, member.age],
      );
    }

    const totalMembers = 1 + members.length;
    // Per-card allocation — family size no longer scales it. This path used
    // to multiply by member count while the monthly cron applied a different
    // rule for AAY, so a card's balance changed the first time the cron ran;
    // both now go through allocationForPolicy.
    const { riceKg: riceBalance, wheatKg: wheatBalance } = allocationForPolicy(policy);

    await client.query(
      `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg)
       VALUES ($1, $2, $3)`,
      [rationCard.id, riceBalance, wheatBalance],
    );

    await client.query("COMMIT");

    logger.info("Ration card created", {
      card_number,
      members_created: totalMembers,
    });

    return res.status(201).json({
      ration_card: { id: rationCard.id, card_number: rationCard.card_number },
      members_created: totalMembers,
      wallet: {
        rice_balance_kg: riceBalance,
        wheat_balance_kg: wheatBalance,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    return res
      .status(500)
      .json({ error: error.message || "Failed to create ration card" });
  } finally {
    client.release();
  }
};

// Audit/E2E fixtures are created with the DEMO-AUDIT-* card number prefix. They
// are hidden from the admin lists so only real beneficiaries are shown. The rows
// are kept in the database; this only filters the admin views.
const EXCLUDE_DEMO_FIXTURES_SQL = "rc.card_number NOT LIKE 'DEMO-AUDIT-%'";

const getBeneficiaries = async (req, res, next) => {
  try {
    const { category, area_id, shop_id } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const params = [];
    const filters = [EXCLUDE_DEMO_FIXTURES_SQL];

    if (category) {
      params.push(category);
      filters.push(`rc.category = $${params.length}`);
    }
    if (area_id) {
      params.push(area_id);
      filters.push(`rc.area_id = $${params.length}`);
    }
    if (shop_id) {
      params.push(shop_id);
      filters.push(`rc.shop_id = $${params.length}`);
    }

    const whereClause =
      filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ration_cards rc ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count);

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const result = await pool.query(
      `SELECT
         fm_head.name,
         u.mobile,
         rc.card_number,
         rc.category,
         s.shop_name,
         a.name AS area_name,
         (SELECT COUNT(*) FROM family_members fm_c WHERE fm_c.ration_card_id = rc.id)::int AS family_size
       FROM ration_cards rc
       LEFT JOIN family_members fm_head ON fm_head.ration_card_id = rc.id AND fm_head.is_head = true
       LEFT JOIN users u  ON u.id  = fm_head.user_id
       LEFT JOIN shops s  ON s.id  = rc.shop_id
       LEFT JOIN areas a  ON a.id  = rc.area_id
       ${whereClause}
       ORDER BY rc.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return res.status(200).json({
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
};

const getRationCards = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ration_cards rc WHERE ${EXCLUDE_DEMO_FIXTURES_SQL}`,
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT
         rc.id, rc.card_number, rc.category, rc.created_at,
         rc.head_user_id, rc.shop_id, rc.area_id,
         u.mobile AS head_mobile,
         fm_head.name AS head_name,
         s.shop_name,
         a.name AS area_name,
         (SELECT COUNT(*) FROM family_members fm_c WHERE fm_c.ration_card_id = rc.id)::int AS family_size,
         COALESCE(w.rice_balance_kg, 0) AS rice_balance_kg,
         COALESCE(w.wheat_balance_kg, 0) AS wheat_balance_kg
       FROM ration_cards rc
       LEFT JOIN users u ON u.id = rc.head_user_id
       LEFT JOIN family_members fm_head ON fm_head.ration_card_id = rc.id AND fm_head.is_head = true
       LEFT JOIN shops s ON s.id = rc.shop_id
       LEFT JOIN areas a ON a.id = rc.area_id
       LEFT JOIN wallets w ON w.ration_card_id = rc.id
       WHERE ${EXCLUDE_DEMO_FIXTURES_SQL}
       ORDER BY rc.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return res.status(200).json({
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
};

const getDbHealth = async (req, res, next) => {
  console.log("Hit GET /api/admin/health");

  const neededTables = [
    "areas",
    "shops",
    "users",
    "ration_cards",
    "family_members",
    "wallets",
  ];

  try {
    const checks = await Promise.all(
      neededTables.map(async (table) => {
        const result = await pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = $1
           ) AS exists`,
          [table],
        );
        return { table, exists: result.rows[0].exists };
      }),
    );
    return res.status(200).json({ status: "ok", checks });
  } catch (error) {
    return next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    const { role } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const params = [];
    let whereClause = "";

    if (role) {
      params.push(role);
      whereClause = `WHERE role = $${params.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM users ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count);

    const nameColumnResult = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'name' LIMIT 1`,
    );
    const nameSelect =
      nameColumnResult.rows.length > 0 ? "name" : "NULL::varchar AS name";

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const result = await pool.query(
      `SELECT id, role, ${nameSelect}, email, mobile, is_active
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return res.status(200).json({
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
};

const updateUser = async (req, res, next) => {
  const { id } = req.params;
  const { name, email, mobile, is_active } = req.body;

  try {
    const existing = await pool.query(
      'SELECT id, role, email, mobile FROM users WHERE id = $1 LIMIT 1',
      [id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = existing.rows[0];

    if (email && email !== user.email) {
      const emailCheck = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2 LIMIT 1',
        [email, id],
      );
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Email already exists' });
      }
    }


    const updates = [];
    const params = [];

    if (name !== undefined) { params.push(name); updates.push(`name = $${params.length}`); }
    if (email !== undefined) { params.push(email); updates.push(`email = $${params.length}`); }
    if (mobile !== undefined) { params.push(mobile); updates.push(`mobile = $${params.length}`); }
    if (is_active !== undefined) { params.push(is_active); updates.push(`is_active = $${params.length}`); }

    params.push(id);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, role, name, email, mobile, is_active`,
      params,
    );
    logger.info('User updated', { id });
    return res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    return next(error);
  }
};

const deleteUser = async (req, res, next) => {
  const { id } = req.params;
  try {
    const existing = await pool.query(
      'SELECT id, role, name FROM users WHERE id = $1 LIMIT 1',
      [id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = existing.rows[0];

    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Admin accounts cannot be deleted.' });
    }

    if (user.role === 'shopkeeper') {
      const shopCheck = await pool.query(
        'SELECT id FROM shops WHERE shopkeeper_id = $1 LIMIT 1',
        [id],
      );
      if (shopCheck.rows.length > 0) {
        return res.status(400).json({
          error: 'This shopkeeper is assigned to a shop. Unassign them first.',
        });
      }
    }

    const rationCheck = await pool.query(
      'SELECT id FROM ration_cards WHERE head_user_id = $1 LIMIT 1',
      [id],
    );
    if (rationCheck.rows.length > 0) {
      return res.status(400).json({
        error: 'This user has ration cards linked. Cannot delete.',
      });
    }

    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    logger.info('User deleted', { id, role: user.role });
    return res.status(200).json({ message: 'User deleted successfully' });
  } catch (error) {
    return next(error);
  }
};

const getAreas = async (req, res, next) => {
  try {
    const activeOnly = req.query.active_only === 'true';
    const search = req.query.search ? req.query.search.trim() : '';

    const params = [];
    const filters = [];

    if (activeOnly) {
      params.push(true);
      filters.push(`a.is_active = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      filters.push(`a.name ILIKE $${params.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT
        a.id,
        a.name,
        a.is_active,
        COUNT(DISTINCT s.id)::int AS shop_count,
        COUNT(DISTINCT s.shopkeeper_id)::int AS shopkeeper_count,
        COUNT(DISTINCT fm.id)::int AS beneficiary_count
      FROM areas a
      LEFT JOIN shops s ON s.area_id = a.id
      LEFT JOIN ration_cards rc ON rc.area_id = a.id AND rc.is_active = true
      LEFT JOIN family_members fm ON fm.ration_card_id = rc.id AND fm.is_head = true
      ${whereClause}
      GROUP BY a.id, a.name, a.is_active
      ORDER BY a.name ASC`,
      params,
    );
    return res.status(200).json({ areas: result.rows });
  } catch (error) {
    return next(error);
  }
};

const createArea = async (req, res, next) => {
  const { name, is_active = true } = req.body;
  try {
    const existing = await pool.query(
      'SELECT id FROM areas WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [name],
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Area name already exists' });
    }

    const result = await pool.query(
      'INSERT INTO areas (name, is_active) VALUES ($1, $2) RETURNING id, name, is_active, created_at',
      [name, is_active],
    );
    logger.info('Area created', { name });
    return res.status(201).json({ area: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Area name already exists' });
    }
    return next(error);
  }
};

const updateArea = async (req, res, next) => {
  const { id } = req.params;
  const { name, is_active } = req.body;
  try {
    const existing = await pool.query(
      'SELECT id, name FROM areas WHERE id = $1 LIMIT 1',
      [id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Area not found' });
    }

    if (name !== undefined && name !== existing.rows[0].name) {
      const nameCheck = await pool.query(
        'SELECT id FROM areas WHERE LOWER(name) = LOWER($1) AND id != $2 LIMIT 1',
        [name, id],
      );
      if (nameCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Area name already exists' });
      }
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      params.push(name);
      updates.push(`name = $${params.length}`);
    }
    if (is_active !== undefined) {
      params.push(is_active);
      updates.push(`is_active = $${params.length}`);
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE areas SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, is_active, created_at`,
      params,
    );
    logger.info('Area updated', { id, name, is_active });
    return res.status(200).json({ area: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Area name already exists' });
    }
    return next(error);
  }
};

const getUnassignedShopkeepers = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.mobile
       FROM users u
       WHERE u.role = 'shopkeeper'
         AND u.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM shops s WHERE s.shopkeeper_id = u.id
         )
       ORDER BY u.name ASC`,
    );
    return res.status(200).json({ shopkeepers: result.rows });
  } catch (error) {
    return next(error);
  }
};

const assignShopkeeper = async (req, res, next) => {
  const { id } = req.params;
  const { shopkeeper_id } = req.body;
  try {
    const shop = await pool.query(
      'SELECT id, shopkeeper_id FROM shops WHERE id = $1 LIMIT 1',
      [id],
    );
    if (shop.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    if (shop.rows[0].shopkeeper_id) {
      return res.status(400).json({ error: 'Shop already has a shopkeeper assigned' });
    }

    const user = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'shopkeeper' AND is_active = true LIMIT 1`,
      [shopkeeper_id],
    );
    if (user.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or inactive shopkeeper' });
    }

    const alreadyAssigned = await pool.query(
      'SELECT id FROM shops WHERE shopkeeper_id = $1 LIMIT 1',
      [shopkeeper_id],
    );
    if (alreadyAssigned.rows.length > 0) {
      return res.status(400).json({ error: 'This shopkeeper is already assigned to another shop' });
    }

    await pool.query('UPDATE shops SET shopkeeper_id = $1 WHERE id = $2', [shopkeeper_id, id]);
    logger.info('Shopkeeper assigned to shop', { shop_id: id, shopkeeper_id });
    return res.status(200).json({ message: 'Shopkeeper assigned successfully' });
  } catch (error) {
    return next(error);
  }
};

const deleteShop = async (req, res, next) => {
  const { id } = req.params;
  try {
    const shop = await pool.query('SELECT id, shop_name FROM shops WHERE id = $1 LIMIT 1', [id]);
    if (shop.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const linked = await pool.query(
      'SELECT COUNT(*) FROM ration_cards WHERE shop_id = $1',
      [id],
    );
    if (parseInt(linked.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'Cannot delete this shop — it has ration cards linked to it.',
      });
    }

    await pool.query('DELETE FROM shops WHERE id = $1', [id]);
    logger.info('Shop deleted', { id, shop_name: shop.rows[0].shop_name });
    return res.status(200).json({ message: 'Shop deleted successfully' });
  } catch (error) {
    return next(error);
  }
};

const createShop = async (req, res, next) => {
  const { shop_code, shop_name, area_id } = req.body;
  try {
    const areaResult = await pool.query(
      'SELECT id, is_active FROM areas WHERE id = $1 LIMIT 1',
      [area_id],
    );
    if (areaResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid area_id' });
    }
    if (!areaResult.rows[0].is_active) {
      return res.status(400).json({ error: 'Cannot assign shop to an inactive area' });
    }

    const result = await pool.query(
      `INSERT INTO shops (shop_code, shop_name, area_id)
       VALUES ($1, $2, $3)
       RETURNING id, shop_code, shop_name, area_id`,
      [shop_code, shop_name, area_id],
    );
    logger.info('Shop created', { shop_code, shop_name, area_id });
    return res.status(201).json({ shop: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Shop code already exists' });
    }
    return next(error);
  }
};

const getShops = async (req, res, next) => {
  try {
    const { area_id } = req.query;
    const unassigned = req.query.unassigned === "true";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    if (unassigned) {
      const result = await pool.query(
        `SELECT s.id, s.shop_name, s.shop_code, a.name as area_name
         FROM shops s
         JOIN areas a ON s.area_id = a.id
         WHERE s.shopkeeper_id IS NULL
         ORDER BY a.name, s.shop_name`,
      );
      return res.status(200).json({ shops: result.rows });
    }

    const filterParams = [];
    let whereClause = "";
    if (area_id) {
      filterParams.push(area_id);
      whereClause = `WHERE s.area_id = $${filterParams.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM shops s ${whereClause}`,
      filterParams,
    );
    const total = parseInt(countResult.rows[0].count);

    filterParams.push(limit);
    const limitIdx = filterParams.length;
    filterParams.push(offset);
    const offsetIdx = filterParams.length;

    const result = await pool.query(
      `SELECT
         s.id,
         s.shop_code,
         s.shop_name,
         s.contact_number,
         s.is_active,
         a.name AS area_name,
         COALESCE(NULLIF(sk.name, ''), split_part(sk.email, '@', 1), NULL) AS shopkeeper_name,
         sk.mobile AS shopkeeper_mobile,
         COUNT(DISTINCT rc.id)::int AS beneficiary_count
       FROM shops s
       INNER JOIN areas a ON a.id = s.area_id
       LEFT JOIN users sk ON sk.id = s.shopkeeper_id
       LEFT JOIN ration_cards rc ON rc.shop_id = s.id
       ${whereClause}
       GROUP BY s.id, s.shop_code, s.shop_name, s.contact_number, s.is_active, a.name, sk.name, sk.email, sk.mobile
       ORDER BY s.shop_code ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      filterParams,
    );

    return res.status(200).json({
      shops: result.rows,
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
};

const createShopkeeper = async (req, res, next) => {
  const client = await pool.connect();

  try {
    const { name, email, password, mobile, shop_id } = req.body;

    if (!name || !email || !password || !mobile) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    const emailResult = await client.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [email],
    );
    if (emailResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Email already exists" });
    }

    const effectiveShopId = shop_id || null;

    if (effectiveShopId) {
      const shopResult = await client.query(
        "SELECT id, shopkeeper_id FROM shops WHERE id = $1 LIMIT 1",
        [effectiveShopId],
      );
      if (shopResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Invalid shop_id" });
      }
      if (shopResult.rows[0].shopkeeper_id) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Shop already assigned" });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (role, name, email, mobile, password_hash)
       VALUES ('shopkeeper', $1, $2, $3, $4) RETURNING id`,
      [name, email, mobile, passwordHash],
    );

    const newUserId = userResult.rows[0].id;

    if (effectiveShopId) {
      const assignResult = await client.query(
        `UPDATE shops SET shopkeeper_id = $1 WHERE id = $2 AND shopkeeper_id IS NULL`,
        [newUserId, effectiveShopId],
      );
      if (assignResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Shop already assigned" });
      }
    }

    await client.query("COMMIT");
    logger.info("Shopkeeper created", { email, shop_id });
    return res
      .status(201)
      .json({ message: "Shopkeeper created", user_id: newUserId });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    if (error.code === "23505") {
      return res.status(400).json({ error: "Email already exists" });
    }

    return res
      .status(500)
      .json({ error: error.message || "Failed to create shopkeeper" });
  } finally {
    client.release();
  }
};

const bulkCreateShopkeepers = async (req, res, next) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "No rows provided" });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: "Maximum 500 rows per upload" });
  }

  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const client = await pool.connect();

    try {
      const { name, email, mobile, password, status } = row;

      if (!name?.trim()) throw new Error("name is required");
      if (!email?.trim()) throw new Error("email is required");
      if (!mobile?.trim()) throw new Error("mobile is required");
      if (!password?.trim()) throw new Error("password is required");
      if (password.trim().length < 6) throw new Error("password must be at least 6 characters");

      const cleanName = name.trim();
      const cleanEmail = email.trim().toLowerCase();
      const normalizedMobile = normalizeIndianMobile(mobile);
      if (!normalizedMobile) throw new Error("mobile must be a valid 10-digit Indian number");

      const normalizedStatus = status?.trim().toLowerCase();
      if (normalizedStatus && !["active", "inactive"].includes(normalizedStatus)) {
        throw new Error("status must be active or inactive");
      }
      const isActive = normalizedStatus === "inactive" ? false : true;

      await client.query("BEGIN");

      const existingEmail = await client.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [cleanEmail],
      );
      if (existingEmail.rows.length > 0) {
        throw new Error(`Email "${cleanEmail}" already exists`);
      }

      const existingMobile = await client.query(
        `SELECT id FROM users WHERE mobile = $1 LIMIT 1`,
        [normalizedMobile],
      );
      if (existingMobile.rows.length > 0) {
        throw new Error(`Mobile "${normalizedMobile}" already exists`);
      }

      const passwordHash = await bcrypt.hash(password.trim(), 10);
      const createdUser = await client.query(
        `INSERT INTO users (role, name, email, mobile, password_hash, is_active)
         VALUES ('shopkeeper', $1, $2, $3, $4, $5)
         RETURNING id, name, email, mobile, is_active`,
        [cleanName, cleanEmail, normalizedMobile, passwordHash, isActive],
      );

      await client.query("COMMIT");

      const user = createdUser.rows[0];
      results.push({
        row: rowNum,
        status: "success",
        name: user.name,
        email: user.email,
        mobile: user.mobile,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      results.push({
        row: rowNum,
        status: "error",
        error: err.message,
        name: row.name || "",
        email: row.email || "",
        mobile: row.mobile || "",
      });
    } finally {
      client.release();
    }
  }

  const succeeded = results.filter((result) => result.status === "success").length;
  const failed = results.filter((result) => result.status === "error").length;

  logger.info("Bulk shopkeeper upload", {
    total: rows.length,
    succeeded,
    failed,
  });

  return res.status(200).json({
    total: rows.length,
    succeeded,
    failed,
    results,
  });
};

const bulkCreateRationCards = async (req, res, next) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "No rows provided" });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: "Maximum 500 rows per upload" });
  }

  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const client = await pool.connect();

    try {
      const { full_name, mobile, gender, age, area, shop, address, category, family_size } = row;

      if (!full_name?.trim()) throw new Error("full_name is required");
      if (!mobile?.trim()) throw new Error("mobile is required");
      if (!age || isNaN(Number(age))) throw new Error("age must be a number");
      const ageNum = Number(age);
      if (ageNum < 18 || ageNum > 100) throw new Error("age must be between 18 and 100");
      if (!area?.trim()) throw new Error("area is required");
      if (!shop?.trim()) throw new Error("shop is required");
      const cleanCategory = (category || "").trim().toUpperCase();
      if (!["APL", "BPL", "AAY"].includes(cleanCategory)) throw new Error("category must be APL, BPL, or AAY");
      const fsNum = Math.floor(Number(family_size));
      if (!family_size || isNaN(fsNum) || fsNum < 1) throw new Error("family_size must be a positive number");

      const cleanMobile = mobile.trim();

      await client.query("BEGIN");

      const mobileCheck = await client.query(
        `SELECT id FROM users WHERE mobile = $1 AND role = 'beneficiary' LIMIT 1`,
        [cleanMobile],
      );
      if (mobileCheck.rows.length > 0) throw new Error(`Mobile ${cleanMobile} already registered to a beneficiary`);

      const areaResult = await client.query(
        `SELECT id FROM areas WHERE LOWER(name) = LOWER($1) AND is_active = true LIMIT 1`,
        [area.trim()],
      );
      if (areaResult.rows.length === 0) throw new Error(`Area "${area.trim()}" not found or inactive`);
      const areaId = areaResult.rows[0].id;

      const shopResult = await client.query(
        `SELECT id FROM shops WHERE LOWER(shop_name) = LOWER($1) AND area_id = $2 LIMIT 1`,
        [shop.trim(), areaId],
      );
      if (shopResult.rows.length === 0) throw new Error(`Shop "${shop.trim()}" not found in area "${area.trim()}"`);
      const shopId = shopResult.rows[0].id;

      const policyResult = await client.query(
        `SELECT ${POLICY_SELECT_COLUMNS} FROM policies WHERE category = $1 LIMIT 1`,
        [cleanCategory],
      );
      if (policyResult.rows.length === 0) throw new Error(`Policy not found for category ${cleanCategory}`);
      const policy = policyResult.rows[0];

      const year = new Date().getFullYear();
      const uniquePart = crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 8);
      const cardNumber = `PDS-${year}-${uniquePart}`;

      const userResult = await client.query(
        `INSERT INTO users (role, name, mobile, gender) VALUES ('beneficiary', $1, $2, $3) RETURNING id`,
        [full_name.trim(), cleanMobile, gender?.trim() || null],
      );
      const headUserId = userResult.rows[0].id;

      const cardResult = await client.query(
        `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id, address)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [cardNumber, cleanCategory, headUserId, shopId, areaId, address?.trim() || null],
      );
      const cardId = cardResult.rows[0].id;

      await client.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, $3, $4, true)`,
        [cardId, headUserId, full_name.trim(), ageNum],
      );

      // fsNum (declared family size) is still validated and stored on the
      // card, but allocation is per card — see allocationPolicyService.
      const { riceKg: rice, wheatKg: wheat } = allocationForPolicy(policy);

      await client.query(
        `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg) VALUES ($1, $2, $3)`,
        [cardId, rice, wheat],
      );

      await client.query("COMMIT");
      results.push({ row: rowNum, status: "success", card_number: cardNumber, name: full_name.trim() });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      results.push({ row: rowNum, status: "error", error: err.message, name: row.full_name || "" });
    } finally {
      client.release();
    }
  }

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;
  logger.info("Bulk ration card upload", { total: rows.length, succeeded, failed });

  return res.status(200).json({ total: rows.length, succeeded, failed, results });
};

const bulkCreateShops = async (req, res, next) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "No rows provided" });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: "Maximum 500 rows per upload" });
  }

  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const client = await pool.connect();

    try {
      const { shop_code, shop_name, area, contact_number, shopkeeper_email, status } = row;

      if (!shop_code?.trim()) throw new Error("shop_code is required");
      if (!shop_name?.trim()) throw new Error("shop_name is required");
      if (!area?.trim()) throw new Error("area is required");

      const isActive = status?.trim().toLowerCase() === "inactive" ? false : true;

      await client.query("BEGIN");

      const areaResult = await client.query(
        `SELECT id FROM areas WHERE LOWER(name) = LOWER($1) AND is_active = true LIMIT 1`,
        [area.trim()],
      );
      if (areaResult.rows.length === 0) throw new Error(`Area "${area.trim()}" not found or inactive`);
      const areaId = areaResult.rows[0].id;

      const codeCheck = await client.query(
        `SELECT id FROM shops WHERE LOWER(shop_code) = LOWER($1) LIMIT 1`,
        [shop_code.trim()],
      );
      if (codeCheck.rows.length > 0) throw new Error(`Shop code "${shop_code.trim()}" already exists`);

      let shopkeeperId = null;
      if (shopkeeper_email?.trim()) {
        const skResult = await client.query(
          `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND role = 'shopkeeper' AND is_active = true LIMIT 1`,
          [shopkeeper_email.trim()],
        );
        if (skResult.rows.length === 0) throw new Error(`Shopkeeper "${shopkeeper_email.trim()}" not found or inactive`);
        const skId = skResult.rows[0].id;
        const alreadyAssigned = await client.query(
          `SELECT id FROM shops WHERE shopkeeper_id = $1 LIMIT 1`,
          [skId],
        );
        if (alreadyAssigned.rows.length > 0) throw new Error(`Shopkeeper "${shopkeeper_email.trim()}" is already assigned to another shop`);
        shopkeeperId = skId;
      }

      const shopResult = await client.query(
        `INSERT INTO shops (shop_code, shop_name, area_id, contact_number, shopkeeper_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, shop_code, shop_name`,
        [shop_code.trim(), shop_name.trim(), areaId, contact_number?.trim() || null, shopkeeperId, isActive],
      );

      await client.query("COMMIT");
      const s = shopResult.rows[0];
      results.push({ row: rowNum, status: "success", shop_code: s.shop_code, shop_name: s.shop_name });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      results.push({ row: rowNum, status: "error", error: err.message, shop_code: row.shop_code || "", shop_name: row.shop_name || "" });
    } finally {
      client.release();
    }
  }

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;
  logger.info("Bulk shop upload", { total: rows.length, succeeded, failed });

  return res.status(200).json({ total: rows.length, succeeded, failed, results });
};

const bulkAddFamilyMembers = async (req, res, next) => {
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "No rows provided" });
  }
  if (rows.length > 1000) {
    return res.status(400).json({ error: "Maximum 1000 rows per upload" });
  }

  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const client = await pool.connect();

    try {
      const { head_mobile, member_name, gender, age, relationship } = row;

      if (!head_mobile?.trim()) throw new Error("head_mobile is required");
      if (!member_name?.trim()) throw new Error("member_name is required");
      if (!age || isNaN(Number(age))) throw new Error("age must be a number");
      const ageNum = Number(age);
      if (ageNum < 0 || ageNum > 120) throw new Error("age must be between 0 and 120");

      const cleanMobile = head_mobile.trim();

      await client.query("BEGIN");

      const headResult = await client.query(
        `SELECT id FROM users WHERE mobile = $1 AND role = 'beneficiary' LIMIT 1`,
        [cleanMobile],
      );
      if (headResult.rows.length === 0) {
        throw new Error(`No beneficiary found with mobile ${cleanMobile}`);
      }
      const headUserId = headResult.rows[0].id;

      const cardResult = await client.query(
        `SELECT rc.id, rc.category FROM ration_cards rc WHERE rc.head_user_id = $1 LIMIT 1`,
        [headUserId],
      );
      if (cardResult.rows.length === 0) {
        throw new Error(`No ration card found for mobile ${cleanMobile}`);
      }
      const cardId = cardResult.rows[0].id;
      const category = cardResult.rows[0].category;

      const policyResult = await client.query(
        `SELECT ${POLICY_SELECT_COLUMNS} FROM policies WHERE category = $1 LIMIT 1`,
        [category],
      );
      if (policyResult.rows.length === 0) throw new Error(`Policy not found for category ${category}`);
      const policy = policyResult.rows[0];

      const memberUserResult = await client.query(
        `INSERT INTO users (role, name, gender) VALUES ('beneficiary', $1, $2) RETURNING id`,
        [member_name.trim(), gender?.trim() || null],
      );
      const memberUserId = memberUserResult.rows[0].id;

      await client.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head, relationship)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [cardId, memberUserId, member_name.trim(), ageNum, relationship?.trim() || null],
      );

      // Adding a family member no longer tops the wallet up: allocation is
      // per ration card, so household size does not change it. The wallet is
      // re-set to the card's per-card allocation instead of accumulating —
      // incrementing here is what used to push balances far past anything a
      // single dispensing transaction could complete.
      const { riceKg, wheatKg } = allocationForPolicy(policy);
      await client.query(
        `UPDATE wallets SET
           rice_balance_kg  = $1,
           wheat_balance_kg = $2,
           updated_at = NOW()
         WHERE ration_card_id = $3`,
        [riceKg, wheatKg, cardId],
      );

      await client.query("COMMIT");
      results.push({ row: rowNum, status: "success", name: member_name.trim(), head_mobile: cleanMobile });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      results.push({ row: rowNum, status: "error", error: err.message, name: row.member_name || "", head_mobile: row.head_mobile || "" });
    } finally {
      client.release();
    }
  }

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;
  logger.info("Bulk family member upload", { total: rows.length, succeeded, failed });

  return res.status(200).json({ total: rows.length, succeeded, failed, results });
};

const getIntegrityChecks = async (req, res, next) => {
  try {
    const run = async (sql) => {
      const r = await pool.query(sql);
      return Number(r.rows[0].count);
    };

    const checks = [
      {
        name: "Cards without wallets",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM ration_cards rc
           WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.ration_card_id = rc.id)`
        ),
        description: "Every ration card must have exactly one wallet",
      },
      {
        name: "Orphaned wallets",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM wallets w
           WHERE NOT EXISTS (SELECT 1 FROM ration_cards rc WHERE rc.id = w.ration_card_id)`
        ),
        description: "Every wallet must reference a valid ration card",
      },
      {
        name: "Cards without family members",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM ration_cards rc
           WHERE NOT EXISTS (SELECT 1 FROM family_members fm WHERE fm.ration_card_id = rc.id)`
        ),
        description: "Every ration card must have at least one family member",
      },
      {
        name: "Cards without a head member",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM ration_cards rc
           WHERE NOT EXISTS (SELECT 1 FROM family_members fm WHERE fm.ration_card_id = rc.id AND fm.is_head = true)`
        ),
        description: "Every ration card must designate exactly one head of family",
      },
      {
        name: "Family members with no linked user",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM family_members WHERE user_id IS NULL`
        ),
        description: "Every family member must reference a valid user account",
      },
      {
        name: "Suspicious transactions (>50 kg)",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM transactions
           WHERE (rice_qty_kg + wheat_qty_kg) > 50`
        ),
        description: "Transactions dispensing more than 50 kg total require review",
      },
      {
        name: "Duplicate card numbers",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM (
             SELECT card_number FROM ration_cards
             GROUP BY card_number HAVING COUNT(*) > 1
           ) AS dups`
        ),
        description: "Each ration card number must be unique",
      },
      {
        name: "Negative wallet balances",
        count: await run(
          `SELECT COUNT(*)::int AS count FROM wallets
           WHERE rice_balance_kg < 0 OR wheat_balance_kg < 0`
        ),
        description: "Wallet balances must never be negative",
      },
    ];

    const results = checks.map((c) => ({
      name: c.name,
      description: c.description,
      status: c.count === 0 ? "pass" : "fail",
      count: c.count,
    }));

    const failed = results.filter((c) => c.status === "fail").length;
    const passed = results.length - failed;

    return res.status(200).json({
      blockchain_ready: failed === 0,
      summary: { total: results.length, passed, failed },
      checks: results,
    });
  } catch (error) {
    return next(error);
  }
};

// GET /api/admin/blockchain/health — read-only monitoring of the Sepolia
// integration (RPC/contract/wallet/sync-lag/failure-rate). Cached briefly by
// blockchainHealthService; pass ?refresh=true to bypass the cache.
const getBlockchainHealth = async (req, res, next) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const health = await blockchainHealthService.getHealth({ forceRefresh });
    return res.status(200).json(health);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createRationCard,
  getRationCards,
  bulkCreateShopkeepers,
  bulkCreateRationCards,
  bulkCreateShops,
  bulkAddFamilyMembers,
  getDbHealth,
  getBeneficiaries,
  getUsers,
  updateUser,
  deleteUser,
  getAreas,
  createArea,
  updateArea,
  getShops,
  createShop,
  deleteShop,
  getUnassignedShopkeepers,
  assignShopkeeper,
  createShopkeeper,
  getIntegrityChecks,
  getBlockchainHealth,
};
