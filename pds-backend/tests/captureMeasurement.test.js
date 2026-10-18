require('./setup');
const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../src/app');
const dispenseSessionService = require('../src/services/dispenseSessionService');
const { Pool } = require('pg');
require('dotenv').config();

jest.setTimeout(60000);

// PROTOTYPE capture rule under test: a measurement may be captured from
// 'weighing' or 'confirming' using the NEWEST reading for the session alone,
// provided it is fresh, a valid non-zero integer, and within the entitlement's
// tolerance. Session ownership and the row-locked state transition still apply.
// This is less reliable than a multi-sample stable weight.
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';
const RUN = crypto.randomBytes(4).toString('hex');
const DEVICE_ID = `esp32-cap-${RUN}`;
const ENTITLED = { rice: 3000, wheat: 2000 };

let areaId, shopA, shopB, tokenA, tokenB;

const shopkeeper = async (tag) => {
    const sk = await pool.query(
        `INSERT INTO users (role, email, mobile, password_hash)
     VALUES ('shopkeeper', $1, $2, $3) RETURNING id`,
        [`cap-${tag}-${RUN}@pds.gov`, `9${Math.floor(100000000 + Math.random() * 899999999)}`, await bcrypt.hash('pw', 10)],
    );
    const shop = await pool.query(
        `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`CAP-${tag.toUpperCase()}-${RUN}`, `Cap ${tag}`, areaId, sk.rows[0].id],
    );
    const token = jwt.sign({ id: sk.rows[0].id, role: 'shopkeeper' }, JWT_SECRET, { expiresIn: '1h' });
    return { shopId: shop.rows[0].id, token };
};

const seedCard = async (tag) => {
    const head = await pool.query(
        `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
        [`Head ${tag}`, `9${Math.floor(100000000 + Math.random() * 899999999)}`],
    );
    const rc = await pool.query(
        `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, 'BPL', $2, $3, $4) RETURNING id`,
        [`CAP-${tag}-${RUN}`, head.rows[0].id, shopA.shopId, areaId],
    );
    await pool.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'H', 40, true)`,
        [rc.rows[0].id, head.rows[0].id],
    );
    await pool.query(
        `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg, last_reset_date)
     VALUES ($1, 3, 2, CURRENT_DATE)`,
        [rc.rows[0].id],
    );
    return { rationCardId: rc.rows[0].id, headUserId: head.rows[0].id };
};

const makeQr = async ({ rationCardId, headUserId }) => {
    const sid = crypto.randomBytes(16).toString('hex');
    await pool.query(
        `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
        [sid, rationCardId, shopA.shopId, headUserId, new Date(Date.now() + 60000)],
    );
    return sid;
};

// Opens and attaches a session at shop A, then moves it to 'weighing' (the
// state the first device reading produces in production).
const openWeighingSession = async (commodity) => {
    const card = await seedCard(`${commodity}-${crypto.randomBytes(3).toString('hex')}`);
    const qr = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });
    const created = await request(app)
        .post('/api/dispense/session')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
            ration_card_id: card.rationCardId,
            commodity,
            entitled_grams: ENTITLED[commodity],
            qr_session_id: qr,
        });
    expect(created.status).toBe(201);
    const sessionId = created.body.session_id;
    const attached = await request(app)
        .post(`/api/dispense/session/${sessionId}/attach`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ session_jwt: created.body.session_jwt });
    expect(attached.status).toBe(200);
    await dispenseSessionService.beginWeighing(sessionId);
    return { sessionId, tolerance: created.body.tolerance_grams };
};

// Writes a device reading for the session, `ageMs` in the past.
const addReading = (sessionId, grams, ageMs = 0) =>
    pool.query(
        `INSERT INTO sensor_readings (device_id, grams_int, taken_at, session_id)
     VALUES ($1, $2, NOW() - ($3 * INTERVAL '1 millisecond'), $4)`,
        [DEVICE_ID, grams, ageMs, sessionId],
    );

const capture = (sessionId, token = tokenA) =>
    request(app)
        .post(`/api/dispense/session/${sessionId}/capture`)
        .set('Authorization', `Bearer ${token}`);

const stateOf = async (sessionId) =>
    (await pool.query('SELECT state, measured_grams FROM dispense_sessions WHERE id = $1', [sessionId])).rows[0];

beforeAll(async () => {
    await pool.query(`
    INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES ('BPL', 3000, 2000)
    ON CONFLICT (category) DO UPDATE SET rice_per_card_grams = EXCLUDED.rice_per_card_grams,
                                         wheat_per_card_grams = EXCLUDED.wheat_per_card_grams
  `);
    const area = await pool.query(
        `INSERT INTO areas (name) VALUES ($1) RETURNING id`,
        [`CapArea-${RUN}`],
    );
    areaId = area.rows[0].id;

    shopA = await shopkeeper('a');
    shopB = await shopkeeper('b');
    tokenA = shopA.token;
    tokenB = shopB.token;

    await pool.query(
        `INSERT INTO iot_devices (device_id, device_token_hash, shop_id) VALUES ($1, $2, $3)`,
        [DEVICE_ID, await bcrypt.hash('cap-token', 10), shopA.shopId],
    );
});

afterAll(async () => {
    await pool.end();
});

describe.each([
    { commodity: 'rice', target: ENTITLED.rice, toleranceGrams: 30 },
    { commodity: 'wheat', target: ENTITLED.wheat, toleranceGrams: 20 },
])('single-reading capture ($commodity)', ({ commodity, target }) => {
    it('captures a fresh in-range reading from weighing and stores its grams', async () => {
        const { sessionId, tolerance } = await openWeighingSession(commodity);
        await addReading(sessionId, target + 2, 800);
        await addReading(sessionId, target + 6, 0);

        const res = await capture(sessionId);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            state: 'captured',
            commodity,
            entitled_grams: target,
            tolerance_grams: tolerance,
            measured_grams: target + 6,
        });
        expect(await stateOf(sessionId)).toEqual({ state: 'captured', measured_grams: target + 6 });
        const records = await pool.query('SELECT id FROM dispense_records WHERE session_id = $1', [sessionId]);
        expect(records.rows).toHaveLength(0);
    });

    it('captures from confirming with the same single-reading rule', async () => {
        const { sessionId } = await openWeighingSession(commodity);
        await dispenseSessionService.beginConfirming(sessionId);
        await addReading(sessionId, target, 0);

        const res = await capture(sessionId);

        expect(res.status).toBe(200);
        expect(res.body.measured_grams).toBe(target);
    });

    it('rejects a reading just outside tolerance and leaves the session weighing', async () => {
        const { sessionId, tolerance } = await openWeighingSession(commodity);
        await addReading(sessionId, target + tolerance + 1, 0);

        const res = await capture(sessionId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IOT_MEASUREMENT_OUT_OF_TOLERANCE');
        expect((await stateOf(sessionId)).state).toBe('weighing');
    });

    it('rejects a stale reading even when it was in range', async () => {
        const { sessionId } = await openWeighingSession(commodity);
        await addReading(sessionId, target, 10000);

        const res = await capture(sessionId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IOT_MEASUREMENT_STALE');
        expect((await stateOf(sessionId)).state).toBe('weighing');
    });

    it('rejects a session that has no reading yet', async () => {
        const { sessionId } = await openWeighingSession(commodity);

        const res = await capture(sessionId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IOT_MEASUREMENT_MISSING');
    });

    it('rejects a zero reading', async () => {
        const { sessionId } = await openWeighingSession(commodity);
        await addReading(sessionId, 0, 0);

        const res = await capture(sessionId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IOT_MEASUREMENT_INVALID');
        expect((await stateOf(sessionId)).state).toBe('weighing');
    });

    it('judges only the newest reading, not an earlier in-range one', async () => {
        const { sessionId, tolerance } = await openWeighingSession(commodity);
        await addReading(sessionId, target, 500);
        await addReading(sessionId, target + tolerance + 50, 0);

        const res = await capture(sessionId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IOT_MEASUREMENT_OUT_OF_TOLERANCE');
    });

    it('refuses a duplicate capture and keeps the first measurement', async () => {
        const { sessionId } = await openWeighingSession(commodity);
        await addReading(sessionId, target + 3, 0);

        const first = await capture(sessionId);
        await addReading(sessionId, target + 5, 0);
        const duplicate = await capture(sessionId);

        expect(first.status).toBe(200);
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.code).toBe('IOT_MEASUREMENT_NOT_STABLE');
        expect(await stateOf(sessionId)).toEqual({ state: 'captured', measured_grams: target + 3 });
    });

    it('lets exactly one of two concurrent captures succeed', async () => {
        const { sessionId } = await openWeighingSession(commodity);
        await addReading(sessionId, target, 0);

        const [a, b] = await Promise.all([capture(sessionId), capture(sessionId)]);

        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect((await stateOf(sessionId)).state).toBe('captured');
    });
});

describe('capture ownership and session state', () => {
    it('refuses a shopkeeper whose shop does not own the session', async () => {
        const { sessionId } = await openWeighingSession('rice');
        await addReading(sessionId, ENTITLED.rice, 0);

        const res = await capture(sessionId, tokenB);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('IOT_SESSION_WRONG_SHOP');
        expect((await stateOf(sessionId)).state).toBe('weighing');
    });

    it('refuses capture from an attached session that has not started weighing', async () => {
        const card = await seedCard(`attached-${crypto.randomBytes(3).toString('hex')}`);
        const qr = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });
        const created = await request(app)
            .post('/api/dispense/session')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({
                ration_card_id: card.rationCardId,
                commodity: 'rice',
                entitled_grams: ENTITLED.rice,
                qr_session_id: qr,
            });
        const sessionId = created.body.session_id;
        await request(app)
            .post(`/api/dispense/session/${sessionId}/attach`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ session_jwt: created.body.session_jwt });
        await addReading(sessionId, ENTITLED.rice, 0);

        const res = await capture(sessionId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IOT_MEASUREMENT_NOT_STABLE');
        expect((await stateOf(sessionId)).state).toBe('attached');
    });
});
