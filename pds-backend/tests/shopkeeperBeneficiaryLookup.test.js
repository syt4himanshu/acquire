require('./setup');
const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

let shopkeeperId, shopId, areaId;
let rationCardWithWallet, rationCardWithoutWallet, rationCardOtherShop;
let beneficiaryUserWithWallet, beneficiaryUserWithoutWallet, beneficiaryUserOtherShop;
let shopkeeperToken;

beforeAll(async () => {
  // Policies
  await pool.query(`
    INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams)
    VALUES ('APL', 1000, 700), ('BPL', 3000, 2000)
    ON CONFLICT (category) DO UPDATE
    SET rice_per_card_grams = EXCLUDED.rice_per_card_grams,
        wheat_per_card_grams = EXCLUDED.wheat_per_card_grams
  `);

  // Area
  const areaRes = await pool.query(
    `INSERT INTO areas (name) VALUES ('BenefLookupArea') 
     ON CONFLICT (name) DO UPDATE SET name='BenefLookupArea' 
     RETURNING id`,
  );
  areaId = areaRes.rows[0].id;

  // Shopkeeper user
  const hash = await bcrypt.hash('shoppass', 10);
  const skRes = await pool.query(
    `INSERT INTO users (role, email, mobile, password_hash) 
     VALUES ('shopkeeper', 'sk-lookup@test.com', '+919111111112', $1) 
     RETURNING id`,
    [hash],
  );
  shopkeeperId = skRes.rows[0].id;
  shopkeeperToken = jwt.sign(
    { id: shopkeeperId, role: 'shopkeeper' },
    JWT_SECRET,
    { expiresIn: '1h' },
  );

  // Shop
  const shopRes = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) 
     VALUES ('BLOOKUP-001', 'Beneficiary Lookup Shop', $1, $2)
     ON CONFLICT (shop_code) DO UPDATE SET shopkeeper_id=$2 
     RETURNING id`,
    [areaId, shopkeeperId],
  );
  shopId = shopRes.rows[0].id;

  // Card 1: With wallet (normal case)
  const user1 = await pool.query(
    `INSERT INTO users (role, email) VALUES ('beneficiary', 'benef1@test.com') RETURNING id`,
  );
  beneficiaryUserWithWallet = user1.rows[0].id;

  const rc1 = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id, is_active)
     VALUES ('BLOOKUP-WITH-WALLET', 'APL', $1, $2, $3, true) RETURNING id`,
    [beneficiaryUserWithWallet, shopId, areaId],
  );
  rationCardWithWallet = rc1.rows[0].id;

  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) 
     VALUES ($1, $2, 'Beneficiary With Wallet', 35, true)`,
    [rationCardWithWallet, beneficiaryUserWithWallet],
  );

  await pool.query(
    `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg)
     VALUES ($1, 1.0, 0.7)`,
    [rationCardWithWallet],
  );

  // Card 2: WITHOUT wallet (regression test case)
  const user2 = await pool.query(
    `INSERT INTO users (role, email) VALUES ('beneficiary', 'benef2@test.com') RETURNING id`,
  );
  beneficiaryUserWithoutWallet = user2.rows[0].id;

  const rc2 = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id, is_active)
     VALUES ('BLOOKUP-NO-WALLET', 'BPL', $1, $2, $3, true) RETURNING id`,
    [beneficiaryUserWithoutWallet, shopId, areaId],
  );
  rationCardWithoutWallet = rc2.rows[0].id;

  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) 
     VALUES ($1, $2, 'Beneficiary Without Wallet', 28, true)`,
    [rationCardWithoutWallet, beneficiaryUserWithoutWallet],
  );
  // Deliberately NOT creating wallet for this card

  // Card 3: Different shop (for authorization test)
  const otherShop = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id) 
     VALUES ('BLOOKUP-002', 'Other Shop', $1) RETURNING id`,
    [areaId],
  );
  const otherShopId = otherShop.rows[0].id;

  const user3 = await pool.query(
    `INSERT INTO users (role, email) VALUES ('beneficiary', 'benef3@test.com') RETURNING id`,
  );
  beneficiaryUserOtherShop = user3.rows[0].id;

  const rc3 = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id, is_active)
     VALUES ('BLOOKUP-OTHER-SHOP', 'APL', $1, $2, $3, true) RETURNING id`,
    [beneficiaryUserOtherShop, otherShopId, areaId],
  );
  rationCardOtherShop = rc3.rows[0].id;

  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) 
     VALUES ($1, $2, 'Beneficiary Other Shop', 40, true)`,
    [rationCardOtherShop, beneficiaryUserOtherShop],
  );

  await pool.query(
    `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg)
     VALUES ($1, 1.0, 0.7)`,
    [rationCardOtherShop],
  );
});

afterAll(async () => {
  await pool.end();
});

// Helper: create a QR session
const createQrSession = async (rcId, sId, userId) => {
  const sessionId = `blookup-session-${Date.now()}-${Math.random()}`;
  const expiresAt = new Date(Date.now() + 60000);
  await pool.query(
    `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at, is_used)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [sessionId, rcId, sId, userId, expiresAt],
  );
  return sessionId;
};

describe('GET /api/shopkeeper/beneficiary/:id - Beneficiary Lookup', () => {
  test('1. should return 200 with beneficiary and wallet when wallet exists', async () => {
    const sessionId = await createQrSession(
      rationCardWithWallet,
      shopId,
      beneficiaryUserWithWallet,
    );

    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithWallet}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId });

    expect(res.status).toBe(200);
    expect(res.body.beneficiary).toBeDefined();
    expect(res.body.beneficiary.ration_card_id).toBe(rationCardWithWallet);
    expect(res.body.beneficiary.name).toBe('Beneficiary With Wallet');
    expect(res.body.beneficiary.card_number).toBe('BLOOKUP-WITH-WALLET');
    expect(res.body.beneficiary.category).toBe('APL');
    expect(res.body.wallet).toBeDefined();
    expect(res.body.wallet.rice_balance_kg).toBe(1.0);
    expect(res.body.wallet.wheat_balance_kg).toBe(0.7);
    expect(res.body.allocation).toBeDefined();
    expect(res.body.allocation.rice_kg).toBe(1);
    expect(res.body.allocation.wheat_kg).toBe(0.7);
  });

  test('2. REGRESSION: should return 400 WALLET_NOT_PROVISIONED (not 404) when wallet is missing', async () => {
    const sessionId = await createQrSession(
      rationCardWithoutWallet,
      shopId,
      beneficiaryUserWithoutWallet,
    );

    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithoutWallet}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Wallet not provisioned');
    expect(res.body.detail).toBe('WALLET_NOT_PROVISIONED');
    // Should NOT return 404 "Beneficiary not found" — that was the bug
  });

  test('3. should return 400 for QR mismatch with non-existent ration card', async () => {
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const sessionId = await createQrSession(rationCardWithWallet, shopId, beneficiaryUserWithWallet);

    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${fakeUuid}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId });

    expect(res.status).toBe(400); // QR does not match ration card
    expect(res.body.error).toContain('does not match');
  });

  test('4. should return 403 when beneficiary belongs to another shop', async () => {
    const sessionId = await createQrSession(
      rationCardOtherShop,
      shopId, // Wrong shop - session says shopId but card belongs to otherShopId
      beneficiaryUserOtherShop,
    );

    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardOtherShop}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('different shop');
  });

  test('5. should return 400 when sessionId is missing', async () => {
    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithWallet}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sessionId');
  });

  test('6. should return 401 when QR session does not exist', async () => {
    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithWallet}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId: 'nonexistent-session' });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid session');
  });

  test('7. should return 401 when QR session has expired', async () => {
    const sessionId = `expired-session-${Date.now()}`;
    const expiredAt = new Date(Date.now() - 60000); // 1 minute ago
    await pool.query(
      `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at, is_used)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [sessionId, rationCardWithWallet, shopId, beneficiaryUserWithWallet, expiredAt],
    );

    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithWallet}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('expired');
  });

  test('8. should return 409 when QR session already used', async () => {
    const sessionId = `used-session-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 60000);
    await pool.query(
      `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at, is_used)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [sessionId, rationCardWithWallet, shopId, beneficiaryUserWithWallet, expiresAt],
    );

    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithWallet}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already used');
  });

  test('9. should return 400 when QR session does not match ration card', async () => {
    const sessionId = await createQrSession(
      rationCardWithWallet,
      shopId,
      beneficiaryUserWithWallet,
    );

    // Try to use session for a different ration card
    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithoutWallet}`)
      .set('Authorization', `Bearer ${shopkeeperToken}`)
      .query({ sessionId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('does not match');
  });

  test('10. should return 401 when not authenticated', async () => {
    const sessionId = await createQrSession(
      rationCardWithWallet,
      shopId,
      beneficiaryUserWithWallet,
    );

    const res = await request(app)
      .get(`/api/shopkeeper/beneficiary/${rationCardWithWallet}`)
      .query({ sessionId });

    expect(res.status).toBe(401);
  });
});
