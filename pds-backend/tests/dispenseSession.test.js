require('./setup');
const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../src/app');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
});

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

let shopkeeperId, shopId, areaId, rationCardId, shopkeeperToken;
let shopNoDeviceId;

const seedQrSession = async (overrides = {}) => {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const expiresAt = overrides.expiresAt || new Date(Date.now() + 60 * 1000);
    await pool.query(
        `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, expires_at, is_used)
     VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, overrides.rationCardId || rationCardId, overrides.shopId || shopId, expiresAt, overrides.isUsed || false],
    );
    return sessionId;
};

const createSessionViaApi = async (overrides = {}) => {
    const qrSessionId =
        overrides.qrSessionId ||
        (await seedQrSession({ rationCardId: overrides.rationCardId, shopId: overrides.shopId }));
    return request(app)
        .post('/api/dispense/session')
        .set('Authorization', `Bearer ${shopkeeperToken}`)
        .send({
            ration_card_id: overrides.rationCardId || rationCardId,
            commodity: overrides.commodity || 'rice',
            entitled_grams: overrides.entitledGrams || 3000,
            qr_session_id: qrSessionId,
        });
};

beforeAll(async () => {
    await pool.query(
        `INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES
      ('BPL', 3000, 2000),
      ('APL', 1000, 1000)
     ON CONFLICT (category) DO UPDATE SET rice_per_card_grams = EXCLUDED.rice_per_card_grams,
                                          wheat_per_card_grams = EXCLUDED.wheat_per_card_grams`,
    );

    const areaRes = await pool.query(
        `INSERT INTO areas (name) VALUES ('DispenseSessionArea') ON CONFLICT (name) DO UPDATE SET name='DispenseSessionArea' RETURNING id`,
    );
    areaId = areaRes.rows[0].id;

    const hash = await bcrypt.hash('shoppass', 10);
    const skRes = await pool.query(
        `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', 'ds-sk@test.com', '+919222222222', $1) RETURNING id`,
        [hash],
    );
    shopkeeperId = skRes.rows[0].id;
    shopkeeperToken = jwt.sign({ id: shopkeeperId, role: 'shopkeeper' }, JWT_SECRET, { expiresIn: '1h' });

    const shopRes = await pool.query(
        `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ('DS-001', 'Dispense Session Shop', $1, $2) RETURNING id`,
        [areaId, shopkeeperId],
    );
    shopId = shopRes.rows[0].id;

    // A second shop, assigned to the same shopkeeper user via a fresh token
    // in the specific test that needs it, WITHOUT any iot_devices row.
    const shopNoDeviceRes = await pool.query(
        `INSERT INTO shops (shop_code, shop_name, area_id) VALUES ('DS-002', 'No Device Shop', $1) RETURNING id`,
        [areaId],
    );
    shopNoDeviceId = shopNoDeviceRes.rows[0].id;

    const headRes = await pool.query(`INSERT INTO users (role) VALUES ('beneficiary') RETURNING id`);
    const headId = headRes.rows[0].id;

    const rcRes = await pool.query(
        `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ('BPL-DS-001', 'BPL', $1, $2, $3) RETURNING id`,
        [headId, shopId, areaId],
    );
    rationCardId = rcRes.rows[0].id;

    await pool.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'Head', 30, true)`,
        [rationCardId, headId],
    );

    // 15kg rice balance = 15000g
    await pool.query(
        `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg) VALUES ($1, 3, 2)`,
        [rationCardId],
    );

    // Active IoT device for shopId (used by attach tests).
    const tokenHash = await bcrypt.hash('device-raw-token', 10);
    await pool.query(
        `INSERT INTO iot_devices (device_id, device_token_hash, shop_id) VALUES ('esp32-ds-001', $1, $2)`,
        [tokenHash, shopId],
    );
});

afterAll(async () => {
    await pool.end();
});

describe('POST /api/dispense/session', () => {
    it('creates a session, computes tolerance, and reserves (does not consume) the QR session', async () => {
        const qrSessionId = await seedQrSession();
        const res = await request(app)
            .post('/api/dispense/session')
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ ration_card_id: rationCardId, commodity: 'rice', entitled_grams: 3000, qr_session_id: qrSessionId });

        expect(res.status).toBe(201);
        expect(res.body.session_id).toBeDefined();
        expect(res.body.session_jwt).toBeDefined();

        const sessionRow = await pool.query('SELECT * FROM dispense_sessions WHERE id = $1', [res.body.session_id]);
        expect(sessionRow.rows[0].state).toBe('active');
        expect(sessionRow.rows[0].tolerance_grams).toBe(30); // max(20, 1% of 3000)

        // The first weighing reserves the QR for the whole distribution. It is
        // consumed only by the final distribution, not here.
        const qrRow = await pool.query('SELECT is_used, reserved_until FROM qr_sessions WHERE session_id = $1', [qrSessionId]);
        expect(qrRow.rows[0].is_used).toBe(false);
        expect(qrRow.rows[0].reserved_until).not.toBeNull();
    });

    it('applies the 20g minimum tolerance floor for small quantities', async () => {
        // APL allocates 1000 g, so 1% = 10 g and the 20 g floor applies.
        const aplRc = await pool.query(
            `INSERT INTO ration_cards (card_number, category, shop_id, area_id) VALUES ($1, 'APL', $2, $3) RETURNING id`,
            [`APL-DS-FLOOR-${Date.now()}`, shopId, areaId],
        );
        await pool.query(`INSERT INTO wallets (ration_card_id, rice_balance_kg) VALUES ($1, 1)`, [aplRc.rows[0].id]);
        const res = await createSessionViaApi({ rationCardId: aplRc.rows[0].id, entitledGrams: 1000 });
        expect(res.status).toBe(201);
        const sessionRow = await pool.query('SELECT tolerance_grams FROM dispense_sessions WHERE id = $1', [
            res.body.session_id,
        ]);
        expect(sessionRow.rows[0].tolerance_grams).toBe(20);
    });

    it('rejects an expired QR session with 410 IOT_SESSION_EXPIRED', async () => {
        const qrSessionId = await seedQrSession({ expiresAt: new Date(Date.now() - 1000) });
        const res = await createSessionViaApi({ qrSessionId });
        expect(res.status).toBe(410);
        expect(res.body.code).toBe('IOT_SESSION_EXPIRED');
    });

    it('rejects an already-used QR session with 409 IOT_SESSION_ALREADY_USED', async () => {
        const qrSessionId = await seedQrSession({ isUsed: true });
        const res = await createSessionViaApi({ qrSessionId });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('IOT_SESSION_ALREADY_USED');
    });

    it('rejects entitled_grams exceeding the wallet balance', async () => {
        // Dedicated low-balance (1kg) ration card — entitled_grams must stay
        // <=10000 to pass Joi's sanity-ceiling validation, so this exercises
        // the wallet-balance check specifically, not the schema's own cap.
        const lowBalRcRes = await pool.query(
            `INSERT INTO ration_cards (card_number, category, shop_id, area_id) VALUES ('BPL-DS-LOWBAL', 'BPL', $1, $2) RETURNING id`,
            [shopId, areaId],
        );
        await pool.query(`INSERT INTO wallets (ration_card_id, rice_balance_kg) VALUES ($1, 1)`, [
            lowBalRcRes.rows[0].id,
        ]);

        const res = await createSessionViaApi({ rationCardId: lowBalRcRes.rows[0].id, entitledGrams: 3000 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('IOT_INSUFFICIENT_BALANCE');
    });
});

describe('POST /api/dispense/session/:id/attach', () => {
    it('attaches to the shop\'s active device and marks the jti used', async () => {
        const createRes = await createSessionViaApi();
        const { session_id: sessionId, session_jwt: sessionJwt } = createRes.body;

        const res = await request(app)
            .post(`/api/dispense/session/${sessionId}/attach`)
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ session_jwt: sessionJwt });

        expect(res.status).toBe(200);
        expect(res.body.state).toBe('attached');
        expect(res.body.device_id).toBe('esp32-ds-001');

        const decoded = jwt.verify(sessionJwt, JWT_SECRET);
        const jtiRow = await pool.query('SELECT jti FROM used_jtis WHERE jti = $1', [decoded.jti]);
        expect(jtiRow.rows.length).toBe(1);
    });

    it('rejects replaying the same session_jwt with 409 IOT_SESSION_ALREADY_USED', async () => {
        const createRes = await createSessionViaApi();
        const { session_id: sessionId, session_jwt: sessionJwt } = createRes.body;

        const first = await request(app)
            .post(`/api/dispense/session/${sessionId}/attach`)
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ session_jwt: sessionJwt });
        expect(first.status).toBe(200);

        const second = await request(app)
            .post(`/api/dispense/session/${sessionId}/attach`)
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ session_jwt: sessionJwt });
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('IOT_SESSION_ALREADY_USED');
    });

    it('rejects an expired session_jwt with 410 IOT_SESSION_EXPIRED', async () => {
        const qrSessionId = await seedQrSession();
        // Sign a token that's already expired, bound to a real (but not yet
        // attached) session id — simulates a shopkeeper sitting on the
        // create-session response past the 60s window.
        const createRes = await createSessionViaApi({ qrSessionId });
        const sessionId = createRes.body.session_id;
        const decoded = jwt.decode(createRes.body.session_jwt);
        const expiredJwt = jwt.sign({ sessionId, jti: decoded.jti }, JWT_SECRET, { expiresIn: -1 });

        const res = await request(app)
            .post(`/api/dispense/session/${sessionId}/attach`)
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ session_jwt: expiredJwt });

        expect(res.status).toBe(410);
        expect(res.body.code).toBe('IOT_SESSION_EXPIRED');
    });

    it('returns 404 IOT_DEVICE_NOT_FOUND when the shop has no active device', async () => {
        // Reassign the shopkeeper to the device-less shop just for this call
        // by seeding a session directly against shopNoDeviceId.
        const qrSessionId = crypto.randomBytes(16).toString('hex');
        const rcRes = await pool.query(
            `INSERT INTO ration_cards (card_number, category, shop_id, area_id) VALUES ('BPL-DS-NODEV', 'BPL', $1, $2) RETURNING id`,
            [shopNoDeviceId, areaId],
        );
        await pool.query(
            `INSERT INTO wallets (ration_card_id, rice_balance_kg) VALUES ($1, 3)`,
            [rcRes.rows[0].id],
        );
        await pool.query(
            `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, expires_at) VALUES ($1, $2, $3, $4)`,
            [qrSessionId, rcRes.rows[0].id, shopNoDeviceId, new Date(Date.now() + 60000)],
        );

        const otherSkHash = await bcrypt.hash('pass', 10);
        const otherSkRes = await pool.query(
            `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', 'ds-sk2@test.com', '+919333333333', $1) RETURNING id`,
            [otherSkHash],
        );
        await pool.query(`UPDATE shops SET shopkeeper_id = $1 WHERE id = $2`, [otherSkRes.rows[0].id, shopNoDeviceId]);
        const otherSkToken = jwt.sign({ id: otherSkRes.rows[0].id, role: 'shopkeeper' }, JWT_SECRET, { expiresIn: '1h' });

        const createRes = await request(app)
            .post('/api/dispense/session')
            .set('Authorization', `Bearer ${otherSkToken}`)
            .send({ ration_card_id: rcRes.rows[0].id, commodity: 'rice', entitled_grams: 3000, qr_session_id: qrSessionId });
        expect(createRes.status).toBe(201);

        const res = await request(app)
            .post(`/api/dispense/session/${createRes.body.session_id}/attach`)
            .set('Authorization', `Bearer ${otherSkToken}`)
            .send({ session_jwt: createRes.body.session_jwt });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('IOT_DEVICE_NOT_FOUND');
    });
});

describe('POST /api/dispense/session/:id/cancel', () => {
    it('cancels an attached session and rejects cancelling it twice', async () => {
        const createRes = await createSessionViaApi();
        const { session_id: sessionId, session_jwt: sessionJwt } = createRes.body;
        await request(app)
            .post(`/api/dispense/session/${sessionId}/attach`)
            .set('Authorization', `Bearer ${shopkeeperToken}`)
            .send({ session_jwt: sessionJwt });

        const first = await request(app)
            .post(`/api/dispense/session/${sessionId}/cancel`)
            .set('Authorization', `Bearer ${shopkeeperToken}`);
        expect(first.status).toBe(200);
        expect(first.body.state).toBe('cancelled');

        const second = await request(app)
            .post(`/api/dispense/session/${sessionId}/cancel`)
            .set('Authorization', `Bearer ${shopkeeperToken}`);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('IOT_SESSION_NOT_CANCELLABLE');
    });
});

describe('GET /api/dispense/session/:id', () => {
    it('returns the current session state', async () => {
        const createRes = await createSessionViaApi();
        const res = await request(app)
            .get(`/api/dispense/session/${createRes.body.session_id}`)
            .set('Authorization', `Bearer ${shopkeeperToken}`);

        expect(res.status).toBe(200);
        expect(res.body.session.state).toBe('active');
        expect(res.body.session.commodity).toBe('rice');
    });
});
