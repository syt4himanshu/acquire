require("./setup");
const request = require("supertest");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const app = require("../src/app");
const { Pool } = require("pg");
const { buildShopStatus } = require("../src/services/shopStatusService");
const {
  OPEN_STATUS_MAX_AGE_MS,
  QUEUE_STALE_AFTER_MS,
  MAX_QUEUE_COUNT,
} = require("../src/config/shopStatus");
require("dotenv").config();

jest.setTimeout(30000);

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || "test_secret";
const uniq = () => crypto.randomBytes(4).toString("hex");

let areaId;

const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "1h" });

// A shopkeeper with an active shop of their own.
const seedShopkeeperWithShop = async () => {
  const tag = uniq();
  const sk = await pool.query(
    `INSERT INTO users (role, email, mobile, password_hash)
     VALUES ('shopkeeper', $1, $2, $3) RETURNING id`,
    [`sk-${tag}@pds.test`, `9${Math.floor(100000000 + Math.random() * 899999999)}`, await bcrypt.hash("pw", 4)],
  );
  const shop = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id)
     VALUES ($1, $2, $3, $4) RETURNING id, shop_name`,
    [`SS-${tag}`, `Shop ${tag}`, areaId, sk.rows[0].id],
  );
  const user = { id: sk.rows[0].id, role: "shopkeeper" };
  return { user, token: tokenFor(user), shopId: shop.rows[0].id, shopName: shop.rows[0].shop_name };
};

// A beneficiary whose head-of-household card is assigned to `shopId`.
const seedBeneficiaryAt = async (shopId) => {
  const tag = uniq();
  const head = await pool.query(
    `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
    [`Head ${tag}`, `8${Math.floor(100000000 + Math.random() * 899999999)}`],
  );
  const rc = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, 'BPL', $2, $3, $4) RETURNING id`,
    [`SS-CARD-${tag}`, head.rows[0].id, shopId, areaId],
  );
  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'H', 40, true)`,
    [rc.rows[0].id, head.rows[0].id],
  );
  const user = { id: head.rows[0].id, role: "beneficiary" };
  return { user, token: tokenFor(user) };
};

const setOpenAge = (shopId, interval) =>
  pool.query(
    `UPDATE shops SET open_status_updated_at = NOW() - $2::interval WHERE id = $1`,
    [shopId, interval],
  );
const setQueueAge = (shopId, interval) =>
  pool.query(
    `UPDATE shops SET queue_updated_at = NOW() - $2::interval WHERE id = $1`,
    [shopId, interval],
  );

const putOpen = (token, body) =>
  request(app).put("/api/shopkeeper/shop-status/open").set("Authorization", `Bearer ${token}`).send(body);
const putQueue = (token, body) =>
  request(app).put("/api/shopkeeper/shop-status/queue").set("Authorization", `Bearer ${token}`).send(body);
const getFps = (token) =>
  request(app).get("/api/beneficiary/fps-status").set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  const area = await pool.query(
    `INSERT INTO areas (name) VALUES ('StatusArea') ON CONFLICT (name) DO UPDATE SET name='StatusArea' RETURNING id`,
  );
  areaId = area.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

// ------------------------------------------------- pure status rule ----
describe("buildShopStatus (the single rule for what users see)", () => {
  const base = {
    shop_name: "S",
    is_active: true,
    is_open: true,
    open_age_seconds: 60,
    queue_count: 4,
    queue_age_seconds: 60,
  };

  test("a shop that has never reported is unknown, not closed", () => {
    const view = buildShopStatus({ ...base, open_age_seconds: null, is_open: false });
    expect(view.availability.status).toBe("unknown");
    expect(view.availability.updated_age_seconds).toBeNull();
  });

  test("a recent report is trusted: open and closed", () => {
    expect(buildShopStatus(base).availability.status).toBe("open");
    expect(buildShopStatus({ ...base, is_open: false }).availability.status).toBe("closed");
  });

  test("a report older than the window becomes unknown, even if it said open", () => {
    const old = (OPEN_STATUS_MAX_AGE_MS / 1000) + 60;
    expect(buildShopStatus({ ...base, open_age_seconds: old }).availability.status).toBe("unknown");
  });

  test("an inactive shop is never shown as open", () => {
    expect(buildShopStatus({ ...base, is_active: false }).availability.status).toBe("unknown");
  });

  test("a queue estimate is current inside the window and last_reported outside it", () => {
    expect(buildShopStatus(base).queue).toMatchObject({ count: 4, freshness: "current" });
    const stale = (QUEUE_STALE_AFTER_MS / 1000) + 1;
    expect(buildShopStatus({ ...base, queue_age_seconds: stale }).queue.freshness).toBe("last_reported");
  });

  test("no queue estimate yet is freshness none, with no count", () => {
    const view = buildShopStatus({ ...base, queue_count: null, queue_age_seconds: null });
    expect(view.queue).toEqual({ count: null, updated_age_seconds: null, freshness: "none" });
  });
});

// ---------------------------------------------------- shopkeeper API ----
describe("shopkeeper: open/closed and queue updates", () => {
  test("requires a token, and refuses beneficiaries", async () => {
    const shop = await seedShopkeeperWithShop();
    const ben = await seedBeneficiaryAt(shop.shopId);

    expect((await request(app).get("/api/shopkeeper/shop-status")).status).toBe(401);
    expect((await putOpen(ben.token, { is_open: true })).status).toBe(403);
    expect((await putQueue(ben.token, { queue_count: 3 })).status).toBe(403);
  });

  test("a new shop reports unknown availability and no queue, not closed", async () => {
    const shop = await seedShopkeeperWithShop();
    const res = await request(app).get("/api/shopkeeper/shop-status").set("Authorization", `Bearer ${shop.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status.availability.status).toBe("unknown");
    expect(res.body.status.queue.freshness).toBe("none");
  });

  test("opening the shop persists to the shopkeeper's own shop and is returned", async () => {
    const shop = await seedShopkeeperWithShop();
    const res = await putOpen(shop.token, { is_open: true });
    expect(res.status).toBe(200);
    expect(res.body.status.availability.status).toBe("open");

    const row = await pool.query(`SELECT is_open, open_status_updated_at FROM shops WHERE id = $1`, [shop.shopId]);
    expect(row.rows[0].is_open).toBe(true);
    expect(row.rows[0].open_status_updated_at).not.toBeNull();
  });

  test("rejects a non-boolean open value, a missing one, and any client-supplied shop id", async () => {
    const shop = await seedShopkeeperWithShop();
    expect((await putOpen(shop.token, { is_open: "true" })).status).toBe(400);
    expect((await putOpen(shop.token, { is_open: 1 })).status).toBe(400);
    expect((await putOpen(shop.token, {})).status).toBe(400);
    expect((await putOpen(shop.token, { is_open: true, shop_id: shop.shopId })).status).toBe(400);
  });

  test("a shopkeeper cannot change another shop, even when naming it", async () => {
    const a = await seedShopkeeperWithShop();
    const b = await seedShopkeeperWithShop();

    const res = await putOpen(b.token, { is_open: true });
    expect(res.status).toBe(200);
    // The request acted on b's shop only.
    const aRow = await pool.query(`SELECT is_open, open_status_updated_at FROM shops WHERE id = $1`, [a.shopId]);
    expect(aRow.rows[0].is_open).toBe(false);
    expect(aRow.rows[0].open_status_updated_at).toBeNull();

    // Naming a's shop in the body is refused outright, not silently applied.
    expect((await putOpen(b.token, { is_open: false, shop_id: a.shopId })).status).toBe(400);
  });

  test("a shopkeeper with no assigned shop gets 404 and nothing is written", async () => {
    const tag = uniq();
    const sk = await pool.query(
      `INSERT INTO users (role, email, mobile, password_hash)
       VALUES ('shopkeeper', $1, $2, $3) RETURNING id`,
      [`orphan-${tag}@pds.test`, `7${Math.floor(100000000 + Math.random() * 899999999)}`, await bcrypt.hash("pw", 4)],
    );
    const token = tokenFor({ id: sk.rows[0].id, role: "shopkeeper" });
    expect((await putOpen(token, { is_open: true })).status).toBe(404);
    expect((await putQueue(token, { queue_count: 2 })).status).toBe(404);
  });

  test("accepts whole-number queue counts from 0 up to the limit", async () => {
    const shop = await seedShopkeeperWithShop();
    for (const count of [0, 12, MAX_QUEUE_COUNT]) {
      const res = await putQueue(shop.token, { queue_count: count });
      expect(res.status).toBe(200);
      expect(res.body.status.queue).toMatchObject({ count, freshness: "current" });
    }
    const row = await pool.query(`SELECT queue_count, queue_updated_at FROM shops WHERE id = $1`, [shop.shopId]);
    expect(row.rows[0].queue_count).toBe(MAX_QUEUE_COUNT);
    expect(row.rows[0].queue_updated_at).not.toBeNull();
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["over the limit", MAX_QUEUE_COUNT + 1],
    ["numeric string", "12"],
    ["null", null],
    ["boolean", true],
    ["exponent string", "1e2"],
  ])("rejects an invalid queue count (%s) and keeps the previous value", async (_label, value) => {
    const shop = await seedShopkeeperWithShop();
    expect((await putQueue(shop.token, { queue_count: 7 })).status).toBe(200);

    const res = await putQueue(shop.token, { queue_count: value });
    expect(res.status).toBe(400);
    const row = await pool.query(`SELECT queue_count FROM shops WHERE id = $1`, [shop.shopId]);
    expect(row.rows[0].queue_count).toBe(7);
  });
});

// ------------------------------------------------- beneficiary view ----
describe("beneficiary: status of their own FPS only", () => {
  test("sees their assigned FPS's open status and queue, labelled as current", async () => {
    const shop = await seedShopkeeperWithShop();
    await putOpen(shop.token, { is_open: true });
    await putQueue(shop.token, { queue_count: 12 });
    const ben = await seedBeneficiaryAt(shop.shopId);

    const res = await getFps(ben.token);
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({
      shop_name: shop.shopName,
      availability: { status: "open" },
      queue: { count: 12, freshness: "current" },
    });
  });

  test("never exposes another shop's data", async () => {
    const mine = await seedShopkeeperWithShop();
    const other = await seedShopkeeperWithShop();
    await putOpen(other.token, { is_open: true });
    await putQueue(other.token, { queue_count: 99 });
    const ben = await seedBeneficiaryAt(mine.shopId);

    const res = await getFps(ben.token);
    expect(res.status).toBe(200);
    expect(res.body.status.shop_name).toBe(mine.shopName);
    expect(res.body.status.queue.count).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(other.shopName);
    expect(JSON.stringify(res.body)).not.toContain(other.shopId);
  });

  test("a beneficiary with no ration card gets 404", async () => {
    const tag = uniq();
    const lone = await pool.query(
      `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
      [`Lone ${tag}`, `6${Math.floor(100000000 + Math.random() * 899999999)}`],
    );
    const res = await getFps(tokenFor({ id: lone.rows[0].id, role: "beneficiary" }));
    expect(res.status).toBe(404);
  });

  test("an old Open report is shown as unknown, not as open", async () => {
    const shop = await seedShopkeeperWithShop();
    await putOpen(shop.token, { is_open: true });
    await setOpenAge(shop.shopId, "13 hours");
    const ben = await seedBeneficiaryAt(shop.shopId);

    const res = await getFps(ben.token);
    expect(res.body.status.availability.status).toBe("unknown");
  });

  test("an old queue estimate is labelled last_reported with its age", async () => {
    const shop = await seedShopkeeperWithShop();
    await putQueue(shop.token, { queue_count: 20 });
    await setQueueAge(shop.shopId, "2 hours");
    const ben = await seedBeneficiaryAt(shop.shopId);

    const res = await getFps(ben.token);
    expect(res.body.status.queue).toMatchObject({ count: 20, freshness: "last_reported" });
    expect(res.body.status.queue.updated_age_seconds).toBeGreaterThanOrEqual(7200);
  });

  test("an inactive FPS is shown as unknown even if it last said open", async () => {
    const shop = await seedShopkeeperWithShop();
    await putOpen(shop.token, { is_open: true });
    await pool.query(`UPDATE shops SET is_active = false WHERE id = $1`, [shop.shopId]);
    const ben = await seedBeneficiaryAt(shop.shopId);

    const res = await getFps(ben.token);
    expect(res.body.status.availability.status).toBe("unknown");
  });

  test("a shop id supplied by the client is ignored: the response is always the beneficiary's own FPS", async () => {
    const mine = await seedShopkeeperWithShop();
    const other = await seedShopkeeperWithShop();
    await putOpen(other.token, { is_open: true });
    const ben = await seedBeneficiaryAt(mine.shopId);

    const res = await request(app)
      .get(`/api/beneficiary/fps-status?shop_id=${other.shopId}`)
      .set("Authorization", `Bearer ${ben.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status.shop_name).toBe(mine.shopName);
    expect(res.body.status.availability.status).toBe("unknown");
  });

  test("shopkeeper-only status endpoints are refused to beneficiaries", async () => {
    const shop = await seedShopkeeperWithShop();
    const ben = await seedBeneficiaryAt(shop.shopId);
    const res = await request(app).get("/api/shopkeeper/shop-status").set("Authorization", `Bearer ${ben.token}`);
    expect(res.status).toBe(403);
  });
});
