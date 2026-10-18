require("./setup");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const app = require("../src/app");
const { pool } = require("./setup");
require("dotenv").config();

jest.setTimeout(30000);

const JWT_SECRET = process.env.JWT_SECRET || "test_secret";
const uniq = () => crypto.randomBytes(4).toString("hex");

let adminToken, areaId, shopId, otherShopId, tag;

// Mirrors the head-member layout the list reads from: the card's name and mobile
// come from the is_head family_members row, not from any other member.
const seedCard = async ({ cardNumber, category, headName, headMobile, shop, childName }) => {
  const head = await pool.query(
    `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
    [headName, headMobile],
  );
  const rc = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [cardNumber, category, head.rows[0].id, shop, areaId],
  );
  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, $3, 40, true)`,
    [rc.rows[0].id, head.rows[0].id, headName],
  );
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
  tag = uniq();
  adminToken = jwt.sign({ id: crypto.randomUUID(), role: "admin" }, JWT_SECRET, { expiresIn: "1h" });

  const area = await pool.query(
    `INSERT INTO areas (name) VALUES ($1) RETURNING id`,
    [`SearchArea-${tag}`],
  );
  areaId = area.rows[0].id;

  const sk = await pool.query(
    `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', $1, NULL, 'x') RETURNING id`,
    [`search-${tag}@pds.test`],
  );
  const shop = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ($1, 'Search Shop', $2, $3) RETURNING id`,
    [`SRC-${tag}`, areaId, sk.rows[0].id],
  );
  shopId = shop.rows[0].id;

  const otherSk = await pool.query(
    `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', $1, NULL, 'x') RETURNING id`,
    [`search-other-${tag}@pds.test`],
  );
  const otherShop = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ($1, 'Search Other Shop', $2, $3) RETURNING id`,
    [`SRO-${tag}`, areaId, otherSk.rows[0].id],
  );
  otherShopId = otherShop.rows[0].id;

  await seedCard({
    cardNumber: `SRCH-${tag}-DHR002-APL-001`,
    category: "APL",
    headName: "Sagar Deshmukh",
    headMobile: "9604686258",
    shop: shopId,
    childName: "Child Of Sagar",
  });
  await seedCard({
    cardNumber: `SRCH-${tag}-BPL-002`,
    category: "BPL",
    headName: "Ramesh Kumar",
    headMobile: "9000000777",
    shop: shopId,
  });
  await seedCard({
    cardNumber: `SRCH-${tag}-OTHER-003`,
    category: "APL",
    headName: "Sagar Patil",
    headMobile: "9000000778",
    shop: otherShopId,
  });
});

const get = (query) => request(app).get(`/api/admin/beneficiaries?${query}`).set("Authorization", `Bearer ${adminToken}`);

const cardsOf = (res) => res.body.data.map((r) => r.card_number).sort();

describe("GET /api/admin/beneficiaries — search", () => {
  test("matches the head name case-insensitively and by partial text", async () => {
    const res = await get(`shop_id=${shopId}&search=sagar%20desh`);
    expect(res.status).toBe(200);
    expect(cardsOf(res)).toEqual([`SRCH-${tag}-DHR002-APL-001`]);
    expect(res.body.data[0]).toMatchObject({ name: "Sagar Deshmukh", mobile: "9604686258" });
  });

  test("matches a partial mobile number", async () => {
    const res = await get(`shop_id=${shopId}&search=604686`);
    expect(cardsOf(res)).toEqual([`SRCH-${tag}-DHR002-APL-001`]);
  });

  test("matches a partial card number case-insensitively", async () => {
    const res = await get(`shop_id=${shopId}&search=dhr002`);
    expect(cardsOf(res)).toEqual([`SRCH-${tag}-DHR002-APL-001`]);
  });

  test("does not match on family members who are not the head", async () => {
    const res = await get(`shop_id=${shopId}&search=Child%20Of`);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  test("total counts matches while unfiltered_total counts the scope before the search", async () => {
    const res = await get(`shop_id=${shopId}&search=sagar`);
    expect(res.body.pagination).toMatchObject({ total: 1, unfiltered_total: 2 });
  });

  test("without a search term, total and unfiltered_total agree", async () => {
    const res = await get(`shop_id=${shopId}`);
    expect(res.body.pagination).toMatchObject({ total: 2, unfiltered_total: 2 });
    expect(res.body.data).toHaveLength(2);
  });

  test("combines with the category filter", async () => {
    const res = await get(`shop_id=${shopId}&category=BPL&search=sagar`);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination).toMatchObject({ total: 0, unfiltered_total: 1 });

    const ok = await get(`shop_id=${shopId}&category=BPL&search=ramesh`);
    expect(cardsOf(ok)).toEqual([`SRCH-${tag}-BPL-002`]);
  });

  test("combines with the shop filter, so a match in another shop is excluded", async () => {
    const res = await get(`search=Sagar`);
    expect(cardsOf(res).filter((c) => c.startsWith(`SRCH-${tag}`))).toEqual([
      `SRCH-${tag}-DHR002-APL-001`,
      `SRCH-${tag}-OTHER-003`,
    ]);

    const scoped = await get(`shop_id=${shopId}&search=Sagar`);
    expect(cardsOf(scoped)).toEqual([`SRCH-${tag}-DHR002-APL-001`]);
  });

  test("treats LIKE wildcards in the search text literally", async () => {
    const percent = await get(`shop_id=${shopId}&search=%25`);
    expect(percent.body.pagination.total).toBe(0);

    const underscore = await get(`shop_id=${shopId}&search=_`);
    expect(underscore.body.pagination.total).toBe(0);
  });

  test("treats SQL-looking input as plain text, without an error", async () => {
    const res = await get(`shop_id=${shopId}&search=${encodeURIComponent("' OR 1=1 --")}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  test("a blank search term is the same as no search", async () => {
    const res = await get(`shop_id=${shopId}&search=%20%20`);
    expect(res.body.pagination).toMatchObject({ total: 2, unfiltered_total: 2 });
  });
});
