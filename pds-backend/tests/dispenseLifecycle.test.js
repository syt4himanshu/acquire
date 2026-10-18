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

// Lifecycle of one QR across one complete distribution:
//
//   QR scanned -> rice weighing RESERVES the QR -> rice captured
//              -> wheat weighing (same QR)      -> wheat captured
//              -> POST /api/shopkeeper/dispense CONSUMES the QR, debits once,
//                 writes one transaction and one audit row per commodity.
//
// Invariants under test: the same QR authorises both commodities, a QR is
// consumed exactly once, expiry and reservation windows are enforced, racing
// requests cannot double-create or double-debit, and a failed finalization
// leaves nothing behind so it can be retried.
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';
const DEVICE_ID = 'esp32-life-01';

// BPL allocation: rice 3000 g (tolerance 30 g), wheat 2000 g (tolerance 20 g).
const RICE_ALLOC = 3000;
const WHEAT_ALLOC = 2000;

let areaId, shopId, shopkeeperToken;

const seedCard = async (tag) => {
    const head = await pool.query(
        `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
        [`Head ${tag}`, `9${Math.floor(100000000 + Math.random() * 899999999)}`],
    );
    const rc = await pool.query(
        `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, 'BPL', $2, $3, $4) RETURNING id`,
        [`LIFE-${tag}`, head.rows[0].id, shopId, areaId],
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

// A QR as the beneficiary app issues it: bound to the head of household and
// expiring after `expiresInMs`.
const makeQr = async ({ rationCardId, headUserId, expiresInMs = 60000 }) => {
    const sid = crypto.randomBytes(16).toString('hex');
    await pool.query(
        `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
        [sid, rationCardId, shopId, headUserId, new Date(Date.now() + expiresInMs)],
    );
    return sid;
};

const createSession = (rationCardId, commodity, qrSessionId) =>
    request(app)
        .post('/api/dispense/session')
        .set('Authorization', `Bearer ${shopkeeperToken}`)
        .send({
            ration_card_id: rationCardId,
            commodity,
            entitled_grams: commodity === 'rice' ? RICE_ALLOC : WHEAT_ALLOC,
            qr_session_id: qrSessionId,
        });

const attach = (sessionId, sessionJwt) =>
    request(app)
        .post(`/api/dispense/session/${sessionId}/attach`)
        .set('Authorization', `Bearer ${shopkeeperToken}`)
        .send({ session_jwt: sessionJwt });

// Drives an attached session through weighing and confirming, then feeds the
// stability window. Readings are written straight to sensor_readings so the
// test does not need a live device; /capture then runs the real stability rule.
const weighAndCapture = async (sessionId, grams) => {
    await dispenseSessionService.beginWeighing(sessionId);
    await dispenseSessionService.beginConfirming(sessionId);
    await pool.query(
        `INSERT INTO sensor_readings (device_id, grams_int, taken_at, session_id)
         SELECT $1, $2, NOW() - (g * INTERVAL '50 millisecond'), $3 FROM generate_series(0, 19) g`,
        [DEVICE_ID, grams, sessionId],
    );
    return request(app)
        .post(`/api/dispense/session/${sessionId}/capture`)
        .set('Authorization', `Bearer ${shopkeeperToken}`);
};

// Opens, attaches and captures one commodity under the given QR.
const captureCommodity = async (rationCardId, commodity, qrSessionId, grams) => {
    const created = await createSession(rationCardId, commodity, qrSessionId);
    expect(created.status).toBe(201);
    const attached = await attach(created.body.session_id, created.body.session_jwt);
    expect(attached.status).toBe(200);
    const captured = await weighAndCapture(
        created.body.session_id,
        commodity === 'rice' ? RICE_ALLOC : WHEAT_ALLOC,
    );
    expect(captured.status).toBe(200);
    return created.body.session_id;
};

const finalize = (rationCardId, qrSessionId, riceSessionId, wheatSessionId) =>
    request(app)
        .post('/api/shopkeeper/dispense')
        .set('Authorization', `Bearer ${shopkeeperToken}`)
        .send({
            ration_card_id: rationCardId,
            session_id: qrSessionId,
            rice_session_id: riceSessionId,
            wheat_session_id: wheatSessionId,
        });

const walletOf = async (rationCardId) => {
    const { rows } = await pool.query(
        `SELECT rice_balance_kg, wheat_balance_kg FROM wallets WHERE ration_card_id = $1`,
        [rationCardId],
    );
    return { rice: Number(rows[0].rice_balance_kg), wheat: Number(rows[0].wheat_balance_kg) };
};

const qrOf = async (qrSessionId) => {
    const { rows } = await pool.query(
        `SELECT is_used, reserved_until FROM qr_sessions WHERE session_id = $1`,
        [qrSessionId],
    );
    return rows[0];
};

const countsOf = async (rationCardId) => {
    const { rows } = await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM transactions WHERE ration_card_id = $1) tx,
            (SELECT COUNT(*)::int FROM dispense_records WHERE ration_card_id = $1) dr`,
        [rationCardId],
    );
    return rows[0];
};

// A card with rice and wheat both captured under one QR, ready to finalise.
const readyDistribution = async (tag) => {
    const card = await seedCard(tag);
    const qr = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });
    const riceId = await captureCommodity(card.rationCardId, 'rice', qr, RICE_ALLOC);
    const wheatId = await captureCommodity(card.rationCardId, 'wheat', qr, WHEAT_ALLOC);
    return { ...card, qr, riceId, wheatId };
};

beforeAll(async () => {
    await pool.query(`
    INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES ('BPL', 3000, 2000)
    ON CONFLICT (category) DO UPDATE SET rice_per_card_grams = EXCLUDED.rice_per_card_grams,
                                         wheat_per_card_grams = EXCLUDED.wheat_per_card_grams
  `);
    const area = await pool.query(
        `INSERT INTO areas (name) VALUES ('LifeArea') ON CONFLICT (name) DO UPDATE SET name='LifeArea' RETURNING id`,
    );
    areaId = area.rows[0].id;

    const sk = await pool.query(
        `INSERT INTO users (role, email, mobile, password_hash)
     VALUES ('shopkeeper', 'life-sk@pds.gov', '+919111222555', $1) RETURNING id`,
        [await bcrypt.hash('pw', 10)],
    );
    shopkeeperToken = jwt.sign({ id: sk.rows[0].id, role: 'shopkeeper' }, JWT_SECRET, { expiresIn: '1h' });

    const shop = await pool.query(
        `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ('LIFE-001', 'Life Shop', $1, $2) RETURNING id`,
        [areaId, sk.rows[0].id],
    );
    shopId = shop.rows[0].id;

    await pool.query(`INSERT INTO iot_devices (device_id, device_token_hash, shop_id) VALUES ($1, $2, $3)`, [
        DEVICE_ID,
        await bcrypt.hash('life-token', 10),
        shopId,
    ]);
});

afterAll(async () => {
    await pool.end();
});

// ------------------------------------------------- full rice-to-wheat flow ----
describe('one QR, rice then wheat, one distribution', () => {
    test('the same QR authorises both commodities, and finalize debits each exactly once', async () => {
        const card = await seedCard('full-flow');
        const qr = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });

        const riceId = await captureCommodity(card.rationCardId, 'rice', qr, RICE_ALLOC);
        // Regression: the second commodity used to be refused because the first
        // createSession had already consumed the QR.
        const wheatId = await captureCommodity(card.rationCardId, 'wheat', qr, WHEAT_ALLOC);

        expect(await qrOf(qr)).toMatchObject({ is_used: false });
        expect((await qrOf(qr)).reserved_until).not.toBeNull();

        const res = await finalize(card.rationCardId, qr, riceId, wheatId);
        expect(res.status).toBe(200);
        expect(res.body.transaction.id).toBeDefined();
        expect(res.body.replayed).toBeUndefined();
        expect(res.body.dispensed).toEqual({ rice_qty_kg: 3, wheat_qty_kg: 2 });

        expect(await walletOf(card.rationCardId)).toEqual({ rice: 0, wheat: 0 });
        expect(await countsOf(card.rationCardId)).toEqual({ tx: 1, dr: 2 });
        expect(await qrOf(qr)).toMatchObject({ is_used: true });

        const sessions = await pool.query(
            `SELECT state FROM dispense_sessions WHERE id IN ($1, $2)`,
            [riceId, wheatId],
        );
        expect(sessions.rows.map((row) => row.state)).toEqual(['committed', 'committed']);

        const records = await pool.query(
            `SELECT commodity, measured_grams, transaction_id, prev_hash, row_hash
             FROM dispense_records WHERE ration_card_id = $1 ORDER BY committed_at ASC`,
            [card.rationCardId],
        );
        expect(records.rows.map((row) => row.commodity).sort()).toEqual(['rice', 'wheat']);
        expect(records.rows.every((row) => row.transaction_id === res.body.transaction.id)).toBe(true);
        expect(records.rows.map((row) => Number(row.measured_grams)).sort((a, b) => a - b)).toEqual([2000, 3000]);
        // The second audit row chains onto the first, so the shop chain stays verifiable.
        expect(records.rows[1].prev_hash).toBe(records.rows[0].row_hash);
    });
});

// ------------------------------------------------------- reused QR ----
describe('reused QR', () => {
    test('a completed QR cannot open a new session, and a finalize retry replays without a second debit', async () => {
        const dist = await readyDistribution('reuse');
        const first = await finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId);
        expect(first.status).toBe(200);

        const newSession = await createSession(dist.rationCardId, 'rice', dist.qr);
        expect(newSession.status).toBe(409);
        expect(newSession.body.code).toBe('IOT_SESSION_ALREADY_USED');

        const retry = await finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId);
        expect(retry.status).toBe(200);
        expect(retry.body.replayed).toBe(true);
        expect(retry.body.transaction.id).toBe(first.body.transaction.id);

        expect(await walletOf(dist.rationCardId)).toEqual({ rice: 0, wheat: 0 });
        expect(await countsOf(dist.rationCardId)).toEqual({ tx: 1, dr: 2 });
    });
});

// ------------------------------------------------------- expired QR ----
describe('expired QR', () => {
    test('an unreserved QR past its scan expiry cannot open a session', async () => {
        const card = await seedCard('expired-scan');
        const qr = await makeQr({
            rationCardId: card.rationCardId,
            headUserId: card.headUserId,
            expiresInMs: -1000,
        });

        const res = await createSession(card.rationCardId, 'rice', qr);
        expect(res.status).toBe(410);
        expect(res.body.code).toBe('IOT_SESSION_EXPIRED');
        expect(await qrOf(qr)).toMatchObject({ is_used: false, reserved_until: null });
    });

    test('a lapsed reservation blocks the next commodity', async () => {
        const card = await seedCard('lapsed-reservation');
        const qr = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });
        await captureCommodity(card.rationCardId, 'rice', qr, RICE_ALLOC);
        await pool.query(
            `UPDATE qr_sessions SET reserved_until = NOW() - INTERVAL '1 minute' WHERE session_id = $1`,
            [qr],
        );

        const res = await createSession(card.rationCardId, 'wheat', qr);
        expect(res.status).toBe(410);
        expect(res.body.code).toBe('IOT_SESSION_EXPIRED');
    });

    test('a lapsed reservation blocks finalization, and nothing is debited or written', async () => {
        const dist = await readyDistribution('lapsed-finalize');
        await pool.query(
            `UPDATE qr_sessions SET reserved_until = NOW() - INTERVAL '1 minute' WHERE session_id = $1`,
            [dist.qr],
        );

        const res = await finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('QR session expired');

        expect(await walletOf(dist.rationCardId)).toEqual({ rice: 3, wheat: 2 });
        expect(await countsOf(dist.rationCardId)).toEqual({ tx: 0, dr: 0 });
        expect(await qrOf(dist.qr)).toMatchObject({ is_used: false });
    });
});

// ----------------------------------------------------- concurrency ----
describe('concurrency', () => {
    test('two racing session creates for one QR and commodity yield exactly one session', async () => {
        const card = await seedCard('race-create');
        const qr = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });

        const [a, b] = await Promise.all([
            createSession(card.rationCardId, 'rice', qr),
            createSession(card.rationCardId, 'rice', qr),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.body.code).toBe('IOT_SESSION_IN_PROGRESS');

        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS n FROM dispense_sessions WHERE qr_session_id = $1 AND commodity = 'rice'`,
            [qr],
        );
        expect(rows[0].n).toBe(1);
    });

    test('two racing finalizations of one distribution debit the wallet once', async () => {
        const dist = await readyDistribution('race-finalize');

        const [a, b] = await Promise.all([
            finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId),
            finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId),
        ]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect([a.body.replayed, b.body.replayed].filter(Boolean)).toHaveLength(1);
        expect(a.body.transaction.id).toBe(b.body.transaction.id);

        expect(await walletOf(dist.rationCardId)).toEqual({ rice: 0, wheat: 0 });
        expect(await countsOf(dist.rationCardId)).toEqual({ tx: 1, dr: 2 });
    });
});

// ---------------------------------------- failed and retried finalization ----
describe('failed and retried finalization', () => {
    test('a refused finalize changes nothing, and a retry after the balance is restored succeeds once', async () => {
        const dist = await readyDistribution('retry');
        await pool.query(`UPDATE wallets SET rice_balance_kg = 0 WHERE ration_card_id = $1`, [dist.rationCardId]);

        const refused = await finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId);
        expect(refused.status).toBe(400);
        expect(refused.body.error).toMatch(/exceeds wallet balance/);

        expect(await qrOf(dist.qr)).toMatchObject({ is_used: false });
        expect(await countsOf(dist.rationCardId)).toEqual({ tx: 0, dr: 0 });
        const states = await pool.query(
            `SELECT state FROM dispense_sessions WHERE id IN ($1, $2)`,
            [dist.riceId, dist.wheatId],
        );
        expect(states.rows.map((row) => row.state)).toEqual(['captured', 'captured']);

        await pool.query(`UPDATE wallets SET rice_balance_kg = 3 WHERE ration_card_id = $1`, [dist.rationCardId]);
        const retried = await finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId);
        expect(retried.status).toBe(200);
        expect(retried.body.replayed).toBeUndefined();
        expect(await walletOf(dist.rationCardId)).toEqual({ rice: 0, wheat: 0 });
        expect(await countsOf(dist.rationCardId)).toEqual({ tx: 1, dr: 2 });
    });

    test('a rice session authorised by a different QR cannot be used to finalize', async () => {
        const card = await seedCard('cross-qr');
        const qrA = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });
        const riceId = await captureCommodity(card.rationCardId, 'rice', qrA, RICE_ALLOC);

        const qrB = await makeQr({ rationCardId: card.rationCardId, headUserId: card.headUserId });
        const wheatId = await captureCommodity(card.rationCardId, 'wheat', qrB, WHEAT_ALLOC);

        const res = await finalize(card.rationCardId, qrB, riceId, wheatId);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Rice IoT session was not authorised by this QR');
        expect(await countsOf(card.rationCardId)).toEqual({ tx: 0, dr: 0 });
        expect(await walletOf(card.rationCardId)).toEqual({ rice: 3, wheat: 2 });
    });

    test('a captured measurement outside tolerance is refused at finalization', async () => {
        const dist = await readyDistribution('out-of-tol');
        await pool.query(`UPDATE dispense_sessions SET measured_grams = 2900 WHERE id = $1`, [dist.riceId]);

        const res = await finalize(dist.rationCardId, dist.qr, dist.riceId, dist.wheatId);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Rice measurement is outside tolerance');
        expect(await countsOf(dist.rationCardId)).toEqual({ tx: 0, dr: 0 });
        expect(await walletOf(dist.rationCardId)).toEqual({ rice: 3, wheat: 2 });
    });
});
