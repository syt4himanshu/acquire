require("./setup");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const app = require("../src/app");
const { pool } = require("./setup");
const { runEntitlementAllocation } = require("../src/services/entitlementService");
require("dotenv").config();

jest.setTimeout(30000);

const JWT_SECRET = process.env.JWT_SECRET || "test_secret";
const uniq = () => crypto.randomBytes(4).toString("hex");

let areaId, shopId, adminToken;
let mobileSeq = 0;
// Mobiles are unique in the test schema, so each seeded user gets a fresh one.
const nextMobile = () => `9${String(Date.now()).slice(-6)}${String(++mobileSeq).padStart(3, "0")}`;

const tokenFor = (userId, role = "beneficiary") =>
  jwt.sign({ id: userId, role, mobile: "x" }, JWT_SECRET, { expiresIn: "1h" });

const get = (path, token) => {
  const req = request(app).get(path);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};

// Seeds one ration card the same way the admin paths do: head user, card,
// head family_members row, and optionally extra members and a wallet.
const seedCard = async ({ category = "APL", headName, withWallet = true, members = [], wallet }) => {
  const mobile = nextMobile();
  const head = await pool.query(
    `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
    [headName, mobile],
  );
  const card = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`BDT-${uniq()}`, category, head.rows[0].id, shopId, areaId],
  );
  const cardId = card.rows[0].id;
  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head, relationship)
     VALUES ($1, $2, $3, 40, true, 'Self')`,
    [cardId, head.rows[0].id, headName],
  );
  const memberUserIds = [];
  for (const m of members) {
    const u = await pool.query(
      `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, NULL) RETURNING id`,
      [m.name],
    );
    memberUserIds.push(u.rows[0].id);
    await pool.query(
      `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, $3, $4, false)`,
      [cardId, u.rows[0].id, m.name, m.age],
    );
  }
  if (withWallet) {
    const w = wallet || { rice: 1.0, wheat: 0.7 };
    await pool.query(
      `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg) VALUES ($1, $2, $3)`,
      [cardId, w.rice, w.wheat],
    );
  }
  return { userId: head.rows[0].id, cardId, memberUserIds };
};

beforeAll(async () => {
  adminToken = tokenFor(crypto.randomUUID(), "admin");

  await pool.query(`
    INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES
      ('APL', 1000, 700), ('BPL', 3000, 2000), ('AAY', 4000, 3000)
    ON CONFLICT (category) DO UPDATE SET
      rice_per_card_grams = EXCLUDED.rice_per_card_grams,
      wheat_per_card_grams = EXCLUDED.wheat_per_card_grams`);

  const area = await pool.query(`INSERT INTO areas (name) VALUES ($1) RETURNING id`, [`DashArea-${uniq()}`]);
  areaId = area.rows[0].id;

  const sk = await pool.query(
    `INSERT INTO users (role, email, password_hash) VALUES ('shopkeeper', $1, 'x') RETURNING id`,
    [`dash-${uniq()}@pds.test`],
  );
  const shop = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ($1, 'Dashboard Shop', $2, $3) RETURNING id`,
    [`DSH-${uniq()}`, areaId, sk.rows[0].id],
  );
  shopId = shop.rows[0].id;
});

describe("GET /api/beneficiary/me — profile", () => {
  test("returns the head's name, card number, category, active flag and family size", async () => {
    const a = await seedCard({
      headName: "Profile Head",
      members: [{ name: "Profile Child", age: 10 }],
    });
    const res = await get("/api/beneficiary/me", tokenFor(a.userId));
    expect(res.status).toBe(200);
    expect(res.body.beneficiary).toMatchObject({
      head_name: "Profile Head",
      category: "APL",
      is_active: true,
      family_size: 2,
      shop_name: "Dashboard Shop",
    });
    expect(res.body.beneficiary.card_number).toMatch(/^BDT-/);
  });
});

describe("GET /api/beneficiary/wallet — balances and allocation state", () => {
  test("1. existing beneficiary with a wallet: returns the stored balances and the policy entitlement", async () => {
    const a = await seedCard({ headName: "Wallet Existing", wallet: { rice: 0.4, wheat: 0.2 } });
    const res = await get("/api/beneficiary/wallet", tokenFor(a.userId));
    expect(res.status).toBe(200);
    expect(res.body.allocation_status).toBe("ok");
    expect(res.body.wallet).toMatchObject({ rice_balance_kg: 0.4, wheat_balance_kg: 0.2 });
    expect(res.body.entitlement).toEqual({ rice_kg: 1, wheat_kg: 0.7 });
  });

  test("2. newly added APL card with no wallet: 200 not_provisioned, not a 404 and not zeros", async () => {
    const a = await seedCard({ headName: "Wallet New APL", withWallet: false });
    const res = await get("/api/beneficiary/wallet", tokenFor(a.userId));
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBeNull();
    expect(res.body.allocation_status).toBe("not_provisioned");
    expect(res.body.entitlement).toEqual({ rice_kg: 1, wheat_kg: 0.7 });
  });

  test("3. a real zero balance is reported as ok with 0, distinct from a missing wallet", async () => {
    const a = await seedCard({ headName: "Wallet Empty", wallet: { rice: 0, wheat: 0 } });
    const res = await get("/api/beneficiary/wallet", tokenFor(a.userId));
    expect(res.body.allocation_status).toBe("ok");
    expect(res.body.wallet).toMatchObject({ rice_balance_kg: 0, wheat_balance_kg: 0 });
  });

  test("4. a card with several family members still returns one wallet for the card", async () => {
    const a = await seedCard({
      headName: "Wallet Multi",
      members: [
        { name: "M1", age: 30 },
        { name: "M2", age: 8 },
      ],
    });
    const res = await get("/api/beneficiary/wallet", tokenFor(a.userId));
    expect(res.body.allocation_status).toBe("ok");
    expect(res.body.wallet.rice_balance_kg).toBe(1);
  });

  test("returns 404 for a user with no head-of-family card", async () => {
    const orphan = await pool.query(
      `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', 'No Card', $1) RETURNING id`,
      [nextMobile()],
    );
    const res = await get("/api/beneficiary/wallet", tokenFor(orphan.rows[0].id));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/beneficiary/family — family members", () => {
  test("4. multiple family members: all are listed, head first", async () => {
    const a = await seedCard({
      headName: "Family Multi",
      members: [
        { name: "Zed Child", age: 5 },
        { name: "Amy Spouse", age: 35 },
      ],
    });
    const res = await get("/api/beneficiary/family", tokenFor(a.userId));
    expect(res.status).toBe(200);
    expect(res.body.family).toHaveLength(3);
    expect(res.body.family[0]).toMatchObject({ name: "Family Multi", is_head: true });
  });

  test("5. head with no other linked members: the list is just the head", async () => {
    const a = await seedCard({ headName: "Family Alone" });
    const res = await get("/api/beneficiary/family", tokenFor(a.userId));
    expect(res.status).toBe(200);
    expect(res.body.family).toEqual([expect.objectContaining({ name: "Family Alone", is_head: true })]);
  });

  test("5b. a user with no family link at all gets 404, not an empty success", async () => {
    const lone = await pool.query(
      `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', 'Lone User', $1) RETURNING id`,
      [nextMobile()],
    );
    const res = await get("/api/beneficiary/family", tokenFor(lone.rows[0].id));
    expect(res.status).toBe(404);
  });
});

describe("authentication", () => {
  test("6. missing token is rejected", async () => {
    const res = await get("/api/beneficiary/wallet");
    expect(res.status).toBe(401);
  });

  test("6b. a malformed token is rejected", async () => {
    const res = await get("/api/beneficiary/wallet", "not-a-jwt");
    expect(res.status).toBe(401);
  });

  test("6c. an expired token is rejected", async () => {
    const a = await seedCard({ headName: "Expired Token" });
    const expired = jwt.sign(
      { id: a.userId, role: "beneficiary", exp: Math.floor(Date.now() / 1000) - 60 },
      JWT_SECRET,
    );
    const res = await get("/api/beneficiary/me", expired);
    expect(res.status).toBe(401);
  });

  test("a shopkeeper or admin token cannot use the beneficiary endpoints", async () => {
    const res = await get("/api/beneficiary/wallet", adminToken);
    expect(res.status).toBe(403);
  });
});

describe("data isolation", () => {
  test("9. a beneficiary sees only their own card, even if another user id is passed in the query", async () => {
    const mine = await seedCard({ headName: "Isolation Mine", wallet: { rice: 0.5, wheat: 0.5 } });
    const other = await seedCard({ headName: "Isolation Other", wallet: { rice: 0.9, wheat: 0.1 } });

    const res = await get(`/api/beneficiary/wallet?user_id=${other.userId}&card=${other.cardId}`, tokenFor(mine.userId));
    expect(res.body.wallet).toMatchObject({ rice_balance_kg: 0.5, wheat_balance_kg: 0.5 });

    const family = await get("/api/beneficiary/family", tokenFor(mine.userId));
    expect(family.body.family.map((m) => m.name)).not.toContain("Isolation Other");
  });

  test("9b. a non-head family member's token does not expose the card's wallet", async () => {
    const a = await seedCard({
      headName: "Isolation Head",
      members: [{ name: "Isolation Member", age: 20 }],
    });
    const res = await get("/api/beneficiary/wallet", tokenFor(a.memberUserIds[0]));
    expect(res.status).toBe(404);
  });
});

describe("provisioning is idempotent and does not reset unrelated balances", () => {
  test("10. the monthly run creates a missing wallet once, then a repeat run is skipped and leaves balances alone", async () => {
    const missing = await seedCard({ headName: "Provision Missing", withWallet: false });
    const kept = await seedCard({ headName: "Provision Kept", wallet: { rice: 0.25, wheat: 0.1 } });

    const first = await runEntitlementAllocation();
    expect(first.skipped).toBeUndefined();

    const created = await pool.query(
      `SELECT rice_balance_kg, wheat_balance_kg FROM wallets WHERE ration_card_id = $1`,
      [missing.cardId],
    );
    expect(created.rows).toHaveLength(1);
    expect(Number(created.rows[0].rice_balance_kg)).toBe(1);
    expect(Number(created.rows[0].wheat_balance_kg)).toBe(0.7);

    // Simulate the household drawing down this month, then a second run the same day.
    await pool.query(`UPDATE wallets SET rice_balance_kg = 0.1 WHERE ration_card_id = $1`, [kept.cardId]);
    const second = await runEntitlementAllocation();
    expect(second.skipped).toBe(true);

    const after = await pool.query(
      `SELECT ration_card_id, COUNT(*) OVER (PARTITION BY ration_card_id)::int AS n, rice_balance_kg
       FROM wallets WHERE ration_card_id = ANY($1::uuid[])`,
      [[missing.cardId, kept.cardId]],
    );
    expect(after.rows.every((r) => r.n === 1)).toBe(true);
    const keptRow = after.rows.find((r) => r.ration_card_id === kept.cardId);
    expect(Number(keptRow.rice_balance_kg)).toBe(0.1);
  });

  test("10b. adding a family member does not reset an existing wallet balance", async () => {
    const a = await seedCard({ headName: "Bulk Add Head", wallet: { rice: 0.3, wheat: 0.2 } });
    const res = await request(app)
      .post("/api/admin/family-members/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        rows: [{ head_mobile: (await pool.query(`SELECT mobile FROM users WHERE id = $1`, [a.userId])).rows[0].mobile, member_name: "Bulk Added", gender: "F", age: 9, relationship: "Daughter" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);

    const w = await pool.query(`SELECT rice_balance_kg, wheat_balance_kg FROM wallets WHERE ration_card_id = $1`, [a.cardId]);
    expect(Number(w.rows[0].rice_balance_kg)).toBe(0.3);
    expect(Number(w.rows[0].wheat_balance_kg)).toBe(0.2);
  });
});
