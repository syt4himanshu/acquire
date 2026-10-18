require("./setup");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const app = require("../src/app");
const { Pool } = require("pg");
require("dotenv").config();

jest.setTimeout(30000);

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || "test_secret";
const uniq = () => crypto.randomBytes(4).toString("hex");

let adminToken, areaId, shopId;

// Each card's head is a family_members row flagged is_head, with that head's own
// users row. The name and mobile shown for a card must come from that head only.
const seedCard = async ({ tag, cardNumber, headName, headMobile, withHead = true, childName }) => {
  const head = await pool.query(
    `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
    [headName ?? `Anon ${tag}`, headMobile],
  );
  const rc = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, 'BPL', $2, $3, $4) RETURNING id`,
    [cardNumber ?? `ADM-${tag}`, withHead ? head.rows[0].id : null, shopId, areaId],
  );
  if (withHead) {
    await pool.query(
      `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, $3, 40, true)`,
      [rc.rows[0].id, head.rows[0].id, headName],
    );
  }
  if (childName) {
    const child = await pool.query(
      `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, NULL) RETURNING id`,
      [childName],
    );
    await pool.query(
      `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, $3, 12, false)`,
      [rc.rows[0].id, child.rows[0].id, childName],
    );
  }
  return rc.rows[0].id;
};

beforeAll(async () => {
  adminToken = jwt.sign({ id: crypto.randomUUID(), role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  const area = await pool.query(
    `INSERT INTO areas (name) VALUES ('AdminListArea') ON CONFLICT (name) DO UPDATE SET name='AdminListArea' RETURNING id`,
  );
  areaId = area.rows[0].id;
  const sk = await pool.query(
    `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', $1, '+919111444555', 'x') RETURNING id`,
    [`admin-list-${uniq()}@pds.test`],
  );
  const shop = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ($1, 'Admin List Shop', $2, $3) RETURNING id`,
    [`ADL-${uniq()}`, areaId, sk.rows[0].id],
  );
  shopId = shop.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

const get = (path) => request(app).get(path).set("Authorization", `Bearer ${adminToken}`);

describe("GET /api/admin/beneficiaries — names and mobiles come from each card's head", () => {
  let cardA, cardB, cardNoHead;

  beforeAll(async () => {
    cardA = await seedCard({
      tag: `A-${uniq()}`,
      headName: "Sunita Test Pawar",
      headMobile: "9000000001",
      childName: "Child Of A",
    });
    cardB = await seedCard({ tag: `B-${uniq()}`, headName: "Ramesh Test Jadhav", headMobile: "9000000002" });
    cardNoHead = await seedCard({ tag: `N-${uniq()}`, withHead: false, headName: null, headMobile: null });
  });

  test("returns each card's real head name and that head's mobile, not another member's", async () => {
    const res = await get(`/api/admin/beneficiaries?shop_id=${shopId}&limit=50`);
    expect(res.status).toBe(200);
    const rows = res.body.data;

    const a = rows.find((r) => r.card_number.startsWith("ADM-A-"));
    expect(a).toMatchObject({
      name: "Sunita Test Pawar",
      mobile: "9000000001",
      category: "BPL",
      shop_name: "Admin List Shop",
      area_name: "AdminListArea",
      family_size: 2,
    });
    expect(a.name).not.toBe("Child Of A");

    const b = rows.find((r) => r.card_number.startsWith("ADM-B-"));
    expect(b).toMatchObject({ name: "Ramesh Test Jadhav", mobile: "9000000002", family_size: 1 });
  });

  test("a card with no head row is still listed, with null name and mobile (not dropped)", async () => {
    const res = await get(`/api/admin/beneficiaries?shop_id=${shopId}&limit=50`);
    const row = res.body.data.find((r) => r.card_number.startsWith("ADM-N-"));
    expect(row).toBeDefined();
    expect(row.name).toBeNull();
    expect(row.mobile).toBeNull();
    expect(row.shop_name).toBe("Admin List Shop");
  });

  test("pagination totals agree with the rows returned", async () => {
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM ration_cards WHERE shop_id = $1`, [shopId]);
    const res = await get(`/api/admin/beneficiaries?shop_id=${shopId}&limit=50`);
    expect(res.body.pagination.total).toBe(total.rows[0].n);
    expect(res.body.data).toHaveLength(total.rows[0].n);
  });
});

describe("GET /api/admin/ration-cards — head name from the head member", () => {
  test("shows the real head name for a card and null for a card without a head", async () => {
    const tag = uniq();
    await seedCard({ tag: `RC-${tag}`, headName: "Real Ration Head", headMobile: "9000000003" });
    await seedCard({ tag: `RCN-${tag}`, withHead: false, headName: null, headMobile: null });

    const res = await get(`/api/admin/ration-cards?limit=500`);
    expect(res.status).toBe(200);
    const withHead = res.body.data.find((r) => r.card_number === `ADM-RC-${tag}`);
    const noHead = res.body.data.find((r) => r.card_number === `ADM-RCN-${tag}`);
    expect(withHead).toMatchObject({ head_name: "Real Ration Head", family_size: 1, category: "BPL" });
    expect(noHead.head_name).toBeNull();
  });
});

describe("DEMO-AUDIT fixtures are hidden from the admin lists", () => {
  let demoTag;

  beforeAll(async () => {
    demoTag = uniq();
    await seedCard({
      tag: `DEMO-${demoTag}`,
      cardNumber: `DEMO-AUDIT-${demoTag}`,
      headName: `DEMO Audit Head ${demoTag}`,
      headMobile: "+919800000000",
      childName: `DEMO Audit Child ${demoTag}`,
    });
    await seedCard({ tag: `REAL-${demoTag}`, headName: `Real Person ${demoTag}`, headMobile: "9000000009" });
  });

  test("beneficiaries list omits DEMO-AUDIT cards and keeps real ones", async () => {
    const res = await get(`/api/admin/beneficiaries?shop_id=${shopId}&limit=500`);
    const cards = res.body.data.map((r) => r.card_number);
    expect(cards).not.toContain(`DEMO-AUDIT-${demoTag}`);
    expect(cards).toContain(`ADM-REAL-${demoTag}`);
    expect(JSON.stringify(res.body)).not.toContain("DEMO Audit");
  });

  test("ration cards list omits DEMO-AUDIT cards and the total excludes them", async () => {
    const res = await get(`/api/admin/ration-cards?limit=500`);
    const cards = res.body.data.map((r) => r.card_number);
    expect(cards).not.toContain(`DEMO-AUDIT-${demoTag}`);
    expect(cards).toContain(`ADM-REAL-${demoTag}`);
    expect(JSON.stringify(res.body)).not.toContain("DEMO Audit");

    const real = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ration_cards WHERE card_number NOT LIKE 'DEMO-AUDIT-%'`,
    );
    expect(res.body.pagination.total).toBe(real.rows[0].n);
  });

  test("the fixture rows still exist in the database (filtered, not deleted)", async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ration_cards WHERE card_number = $1`,
      [`DEMO-AUDIT-${demoTag}`],
    );
    expect(rows[0].n).toBe(1);
  });
});
