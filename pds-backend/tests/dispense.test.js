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

let shopkeeperId, shopId, areaId, rationCardId, shopkeeperToken;
let shop2Id, rationCard2Id;

beforeAll(async () => {
    // Policies
    await pool.query(`
    INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES
      ('BPL', 3000, 2000)
    
    ON CONFLICT (category) DO UPDATE
      SET rice_per_card_grams = EXCLUDED.rice_per_card_grams,
          wheat_per_card_grams = EXCLUDED.wheat_per_card_grams
  `);

    // Area
    const areaRes = await pool.query(
        `INSERT INTO areas (name) VALUES ('DispenseArea') ON CONFLICT (name) DO UPDATE SET name='DispenseArea' RETURNING id`,
    );
    areaId = areaRes.rows[0].id;

    // Shopkeeper user
    const hash = await bcrypt.hash('shoppass', 10);
    const skRes = await pool.query(
        `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', 'sk@test.com', '+919111111111', $1) RETURNING id`,
        [hash],
    );
    shopkeeperId = skRes.rows[0].id;
    shopkeeperToken = jwt.sign({ id: shopkeeperId, role: 'shopkeeper' }, JWT_SECRET, { expiresIn: '1h' });

    // Shop 1
    const shopRes = await pool.query(
        `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ('DSP-001', 'Dispense Shop', $1, $2)
     ON CONFLICT (shop_code) DO UPDATE SET shopkeeper_id=$2 RETURNING id`,
        [areaId, shopkeeperId],
    );
    shopId = shopRes.rows[0].id;

    // Head beneficiary
    const headRes = await pool.query(`INSERT INTO users (role) VALUES ('beneficiary') RETURNING id`);
    const headId = headRes.rows[0].id;

    // BPL ration card (3 members)
    const rcRes = await pool.query(
        `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ('BPL-DISP-001', 'BPL', $1, $2, $3) RETURNING id`,
        [headId, shopId, areaId],
    );
    rationCardId = rcRes.rows[0].id;

    await pool.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'Head', 30, true)`,
        [rationCardId, headId],
    );
    for (let i = 1; i < 3; i++) {
        const mRes = await pool.query(`INSERT INTO users (role) VALUES ('beneficiary') RETURNING id`);
        await pool.query(
            `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, $3, 20, false)`,
            [rationCardId, mRes.rows[0].id, `Member${i}`],
        );
    }

    // Wallet: rice=15, wheat=9
    await pool.query(
        `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg)
     VALUES ($1, 3, 2)`,
        [rationCardId],
    );

    // Shop 2 (for cross-shop test)
    const shop2Res = await pool.query(
        `INSERT INTO shops (shop_code, shop_name, area_id) VALUES ('DSP-002', 'Other Shop', $1) RETURNING id`,
        [areaId],
    );
    shop2Id = shop2Res.rows[0].id;

    const head2Res = await pool.query(`INSERT INTO users (role) VALUES ('beneficiary') RETURNING id`);
    const head2Id = head2Res.rows[0].id;

    const rc2Res = await pool.query(
        `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ('BPL-DISP-002', 'BPL', $1, $2, $3) RETURNING id`,
        [head2Id, shop2Id, areaId],
    );
    rationCard2Id = rc2Res.rows[0].id;

    await pool.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'Head2', 30, true)`,
        [rationCard2Id, head2Id],
    );
    await pool.query(
        `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg) VALUES ($1, 3, 2)`,
        [rationCard2Id],
    );
});

afterAll(async () => {
    await pool.end();
});

// Helper: create a fresh QR session for a given ration card + shop + user
const createSession = async (rcId, sId, userId, expiresInMs = 60000) => {
    const sessionId = `test-session-${Date.now()}-${Math.random()}`;
    const expiresAt = new Date(Date.now() + expiresInMs);
    await pool.query(
        `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, rcId, sId, userId, expiresAt],
    );
    return sessionId;
};

// Helper: seed captured IoT sessions for rice and wheat, bound to the QR that
// authorises the distribution. Finalization accepts only captured sessions
// whose measurement is inside tolerance and which belong to this QR.
const seedVerifiedSessions = async (rcId, sId, qrSessionId) => {
    const riceSessionId = crypto.randomUUID();
    const wheatSessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60000);

    await pool.query(
        `INSERT INTO dispense_sessions (id, shop_id, ration_card_id, commodity, entitled_grams, tolerance_grams, state, expires_at, qr_session_id, measured_grams)
         VALUES ($1, $3, $2, 'rice', 3000, 30, 'captured', $4, $6, 3000),
                ($5, $3, $2, 'wheat', 2000, 20, 'captured', $4, $6, 2000)`,
        [riceSessionId, rcId, sId, expiresAt, wheatSessionId, qrSessionId],
    );

    return { riceSessionId, wheatSessionId };
};

// Reset wallet before each test
beforeEach(async () => {
    await pool.query(
        `UPDATE wallets SET rice_balance_kg=3, wheat_balance_kg=2 WHERE ration_card_id=$1`,
        [rationCardId],
    );
    await pool.query(
        `UPDATE wallets SET rice_balance_kg=3, wheat_balance_kg=2 WHERE ration_card_id=$1`,
        [rationCard2Id],
    );
    // Delete children before parents: audit rows reference transactions and
    // sessions, and sessions reference QR sessions (all RESTRICT).
    await pool.query(`DELETE FROM dispense_records`);
    await pool.query(`DELETE FROM transactions`);
    await pool.query(`DELETE FROM dispense_sessions`);
    await pool.query(`DELETE FROM qr_sessions`);
});

describe('POST /api/shopkeeper/dispense', () => {
    test('1. valid dispense → 200 + wallet deducted', async () => {
        const sessionId = await createSession(rationCardId, shopId, shopkeeperId);
        const { riceSessionId, wheatSessionId } = await seedVerifiedSessions(rationCardId, shopId, sessionId);

        const res = await request(app)
            .post('/api/shopkeeper/dispense')
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({
                ration_card_id: rationCardId,
                session_id: sessionId,
                rice_session_id: riceSessionId,
                wheat_session_id: wheatSessionId,
                rice_qty_kg: 3,
                wheat_qty_kg: 2,
            });

        expect(res.status).toBe(200);
        expect(res.body.remaining_wallet.rice_balance_kg).toBe(0); // whole allocation

        const txRes = await pool.query(`SELECT * FROM transactions WHERE ration_card_id=$1`, [rationCardId]);
        expect(txRes.rows.length).toBe(1);
    });

    test('2. missing IoT sessions → 400 rejection', async () => {
        const sessionId = await createSession(rationCardId, shopId, shopkeeperId);

        const res = await request(app)
            .post('/api/shopkeeper/dispense')
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ ration_card_id: rationCardId, session_id: sessionId, rice_qty_kg: 3, wheat_qty_kg: 2 });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('IoT scale');

        const walletRes = await pool.query(`SELECT rice_balance_kg FROM wallets WHERE ration_card_id=$1`, [rationCardId]);
        expect(Number(walletRes.rows[0].rice_balance_kg)).toBe(3);
    });

    test('3. ration card from different shop → 403, wallet unchanged', async () => {
        const sessionId = await createSession(rationCard2Id, shopId, shopkeeperId);
        const { riceSessionId, wheatSessionId } = await seedVerifiedSessions(rationCard2Id, shop2Id, sessionId);

        const res = await request(app)
            .post('/api/shopkeeper/dispense')
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({
                ration_card_id: rationCard2Id,
                session_id: sessionId,
                rice_session_id: riceSessionId,
                wheat_session_id: wheatSessionId,
                rice_qty_kg: 3,
                wheat_qty_kg: 2,
            });

        expect(res.status).toBe(403);

        const walletRes = await pool.query(`SELECT rice_balance_kg FROM wallets WHERE ration_card_id=$1`, [rationCard2Id]);
        expect(Number(walletRes.rows[0].rice_balance_kg)).toBe(3);
    });

    test('4. invalid ration_card_id format → 400', async () => {
        const res = await request(app)
            .post('/api/shopkeeper/dispense')
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ ration_card_id: 'not-a-uuid', session_id: 'some-session', rice_qty_kg: 3, wheat_qty_kg: 2 });

        expect(res.status).toBe(400);
    });

    test('5. dispense creates single transaction record with correct fields', async () => {
        const sessionId = await createSession(rationCardId, shopId, shopkeeperId);
        const { riceSessionId, wheatSessionId } = await seedVerifiedSessions(rationCardId, shopId, sessionId);

        await request(app)
            .post('/api/shopkeeper/dispense')
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({
                ration_card_id: rationCardId,
                session_id: sessionId,
                rice_session_id: riceSessionId,
                wheat_session_id: wheatSessionId,
                rice_qty_kg: 3,
                wheat_qty_kg: 2,
            });

        const txRes = await pool.query(
            `SELECT * FROM transactions WHERE ration_card_id=$1`,
            [rationCardId],
        );
        expect(txRes.rows.length).toBe(1);
        expect(txRes.rows[0].shop_id).toBe(shopId);
        expect(txRes.rows[0].served_by).toBe(shopkeeperId);
        expect(Number(txRes.rows[0].rice_qty_kg)).toBe(3);
        expect(Number(txRes.rows[0].wheat_qty_kg)).toBe(2);
    });
});
