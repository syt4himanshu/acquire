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

// The blockchain write runs after commit and is fire-and-forget. Stub it so the
// hash state in each test is exactly what the test sets, not a race.
jest.mock('../src/services/blockchainService', () => ({
  recordDispense: jest.fn(() => new Promise(() => {})),
}));

// Receipt read path: GET /api/shopkeeper/transactions/:id/receipt. It must
// reflect the committed rows, stay scoped to the serving shop, and never expose
// a full card number.
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';
const RUN = crypto.randomBytes(4).toString('hex');
const DEVICE_ID = `esp32-rcpt-${RUN}`;
const ENTITLED = { rice: 3000, wheat: 2000 };
const MEASURED = { rice: 2994, wheat: 2010 };
const VALID_HASH = `0x${'ab'.repeat(32)}`;

let areaId, shopA, shopB;

const shopkeeper = async (tag) => {
  const sk = await pool.query(
    `INSERT INTO users (role, email, mobile, password_hash)
     VALUES ('shopkeeper', $1, $2, $3) RETURNING id`,
    [`rcpt-${tag}-${RUN}@pds.gov`, `9${Math.floor(100000000 + Math.random() * 899999999)}`, await bcrypt.hash('pw', 10)],
  );
  const shop = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`RCPT-${tag.toUpperCase()}-${RUN}`, `Receipt Shop ${tag}`, areaId, sk.rows[0].id],
  );
  return {
    shopId: shop.rows[0].id,
    token: jwt.sign({ id: sk.rows[0].id, role: 'shopkeeper' }, JWT_SECRET, { expiresIn: '1h' }),
  };
};

// Beneficiary token for the role-gate test.
const beneficiaryToken = async () => {
  const user = await pool.query(
    `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
    [`Ben ${RUN}`, `9${Math.floor(100000000 + Math.random() * 899999999)}`],
  );
  return jwt.sign({ id: user.rows[0].id, role: 'beneficiary' }, JWT_SECRET, { expiresIn: '1h' });
};

const seedCard = async (tag, headName = `Head ${tag}`) => {
  const head = await pool.query(
    `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', $1, $2) RETURNING id`,
    [headName, `9${Math.floor(100000000 + Math.random() * 899999999)}`],
  );
  const rc = await pool.query(
    `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, 'BPL', $2, $3, $4) RETURNING id`,
    [String(Math.floor(1e15 + Math.random() * 9e15)), head.rows[0].id, shopA.shopId, areaId],
  );
  // Two family members, so the receipt's family size is a real count.
  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'H', 40, true)`,
    [rc.rows[0].id, head.rows[0].id],
  );
  await pool.query(
    `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'M', 35, false)`,
    [rc.rows[0].id, head.rows[0].id],
  );
  await pool.query(
    `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg, last_reset_date)
     VALUES ($1, 3, 2, CURRENT_DATE)`,
    [rc.rows[0].id],
  );
  return { rationCardId: rc.rows[0].id, headUserId: head.rows[0].id, cardNumber: rc.rows[0].card_number };
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

// Opens, attaches and weighs one commodity with a fresh in-range reading, then
// captures it, using the same HTTP path as the shopkeeper screen.
const captureCommodity = async (card, qr, commodity, grams) => {
  const created = await request(app)
    .post('/api/dispense/session')
    .set('Authorization', `Bearer ${shopA.token}`)
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
    .set('Authorization', `Bearer ${shopA.token}`)
    .send({ session_jwt: created.body.session_jwt });
  expect(attached.status).toBe(200);
  await dispenseSessionService.beginWeighing(sessionId);
  await pool.query(
    `INSERT INTO sensor_readings (device_id, grams_int, taken_at, session_id)
     VALUES ($1, $2, NOW(), $3)`,
    [DEVICE_ID, grams, sessionId],
  );
  const captured = await request(app)
    .post(`/api/dispense/session/${sessionId}/capture`)
    .set('Authorization', `Bearer ${shopA.token}`);
  expect(captured.status).toBe(200);
  return sessionId;
};

// Completes a full rice + wheat distribution and returns the committed ids.
const completeDistribution = async (tag) => {
  const card = await seedCard(tag);
  const qr = await makeQr(card);
  const riceSessionId = await captureCommodity(card, qr, 'rice', MEASURED.rice);
  const wheatSessionId = await captureCommodity(card, qr, 'wheat', MEASURED.wheat);
  const res = await request(app)
    .post('/api/shopkeeper/dispense')
    .set('Authorization', `Bearer ${shopA.token}`)
    .send({
      ration_card_id: card.rationCardId,
      session_id: qr,
      rice_session_id: riceSessionId,
      wheat_session_id: wheatSessionId,
    });
  expect(res.status).toBe(200);
  return { card, transactionId: res.body.transaction.id };
};

const getReceipt = (transactionId, token = shopA.token) =>
  request(app)
    .get(`/api/shopkeeper/transactions/${transactionId}/receipt`)
    .set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await pool.query(`
    INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES ('BPL', 3000, 2000)
    ON CONFLICT (category) DO UPDATE SET rice_per_card_grams = EXCLUDED.rice_per_card_grams,
                                         wheat_per_card_grams = EXCLUDED.wheat_per_card_grams
  `);
  const area = await pool.query(`INSERT INTO areas (name) VALUES ($1) RETURNING id`, [`RcptArea-${RUN}`]);
  areaId = area.rows[0].id;
  shopA = await shopkeeper('a');
  shopB = await shopkeeper('b');
  await pool.query(
    `INSERT INTO iot_devices (device_id, device_token_hash, shop_id) VALUES ($1, $2, $3)`,
    [DEVICE_ID, await bcrypt.hash('rcpt-token', 10), shopA.shopId],
  );
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/shopkeeper/transactions/:id/receipt', () => {
  let completed;

  beforeAll(async () => {
    completed = await completeDistribution('main');
  });

  it('returns the committed transaction, beneficiary and shop details', async () => {
    const res = await getReceipt(completed.transactionId);

    expect(res.status).toBe(200);
    const { receipt } = res.body;
    expect(receipt.reference).toBe(completed.transactionId);
    expect(receipt.status).toBe('completed');
    expect(receipt.issuedAt).toBeTruthy();
    expect(receipt.shop).toEqual({ code: `RCPT-A-${RUN}`, name: 'Receipt Shop a' });
    expect(receipt.beneficiary).toMatchObject({
      name: 'Head main',
      category: 'BPL',
      familySize: 2,
    });
  });

  it('reports each commodity from the committed measurements, with the difference and tolerance', async () => {
    const { receipt } = (await getReceipt(completed.transactionId)).body;
    const byCommodity = Object.fromEntries(receipt.commodities.map((row) => [row.commodity, row]));

    expect(receipt.commodities.map((row) => row.commodity)).toEqual(['rice', 'wheat']);
    expect(byCommodity.rice).toMatchObject({
      entitledGrams: ENTITLED.rice,
      measuredGrams: MEASURED.rice,
      differenceGrams: MEASURED.rice - ENTITLED.rice,
      withinTolerance: true,
    });
    expect(byCommodity.wheat).toMatchObject({
      entitledGrams: ENTITLED.wheat,
      measuredGrams: MEASURED.wheat,
      differenceGrams: MEASURED.wheat - ENTITLED.wheat,
      withinTolerance: true,
    });
    expect(receipt.totals).toEqual({
      entitledGrams: ENTITLED.rice + ENTITLED.wheat,
      measuredGrams: MEASURED.rice + MEASURED.wheat,
    });
  });

  it('matches the measurements recorded in the database, not any client value', async () => {
    const { receipt } = (await getReceipt(completed.transactionId)).body;
    const rows = await pool.query(
      `SELECT commodity, entitled_grams, measured_grams FROM dispense_records WHERE transaction_id = $1 ORDER BY commodity`,
      [completed.transactionId],
    );
    const fromDb = Object.fromEntries(rows.rows.map((r) => [r.commodity, r]));
    for (const row of receipt.commodities) {
      expect(row.measuredGrams).toBe(Number(fromDb[row.commodity].measured_grams));
      expect(row.entitledGrams).toBe(Number(fromDb[row.commodity].entitled_grams));
    }
  });

  it('never returns the full ration card number', async () => {
    const res = await getReceipt(completed.transactionId);
    const card = (await pool.query('SELECT card_number FROM ration_cards WHERE id = $1', [completed.card.rationCardId])).rows[0].card_number;

    expect(res.body.receipt.beneficiary.maskedCardNumber.endsWith(card.slice(-4))).toBe(true);
    expect(res.body.receipt.beneficiary.maskedCardNumber).not.toContain(card.slice(0, -4));
    expect(JSON.stringify(res.body)).not.toContain(card);
  });

  it('reports the blockchain record as pending while no hash exists and no anchor error is recorded', async () => {
    const { receipt } = (await getReceipt(completed.transactionId)).body;

    expect(receipt.blockchain).toEqual({ status: 'pending', txHash: null, explorerUrl: null });
  });

  it('reports the blockchain record as recorded, with a Sepolia link, once a valid hash is stored', async () => {
    await pool.query('UPDATE transactions SET blockchain_tx_hash = $1 WHERE id = $2', [VALID_HASH, completed.transactionId]);

    const { receipt } = (await getReceipt(completed.transactionId)).body;

    expect(receipt.blockchain).toEqual({
      status: 'recorded',
      txHash: VALID_HASH,
      explorerUrl: `https://sepolia.etherscan.io/tx/${VALID_HASH}`,
    });
    await pool.query('UPDATE transactions SET blockchain_tx_hash = NULL WHERE id = $1', [completed.transactionId]);
  });

  it('does not link a stored value that is not a well-formed transaction hash', async () => {
    await pool.query("UPDATE transactions SET blockchain_tx_hash = 'not-a-hash' WHERE id = $1", [completed.transactionId]);

    const { receipt } = (await getReceipt(completed.transactionId)).body;

    expect(receipt.blockchain.explorerUrl).toBeNull();
    expect(receipt.blockchain.txHash).toBeNull();
    expect(receipt.blockchain.status).toBe('pending');
    await pool.query('UPDATE transactions SET blockchain_tx_hash = NULL WHERE id = $1', [completed.transactionId]);
  });

  it('reports the blockchain record as unavailable once anchoring has recorded an error', async () => {
    await pool.query(
      `UPDATE dispense_records SET last_anchor_error = 'rpc unreachable' WHERE transaction_id = $1`,
      [completed.transactionId],
    );

    const { receipt } = (await getReceipt(completed.transactionId)).body;

    expect(receipt.blockchain.status).toBe('unavailable');
    await pool.query(`UPDATE dispense_records SET last_anchor_error = NULL WHERE transaction_id = $1`, [
      completed.transactionId,
    ]);
  });

  it('returns 404 to a different shop, the same as for a transaction that does not exist', async () => {
    const foreign = await getReceipt(completed.transactionId, shopB.token);
    const missing = await getReceipt(crypto.randomUUID(), shopA.token);

    expect({ status: foreign.status, body: foreign.body }).toEqual({ status: 404, body: { error: 'Receipt not found' } });
    expect({ status: missing.status, body: missing.body }).toEqual({ status: 404, body: { error: 'Receipt not found' } });
  });

  it('returns 404 for a malformed transaction id instead of a database error', async () => {
    const res = await getReceipt('not-a-uuid');

    expect(res.status).toBe(404);
  });

  it('refuses unauthenticated requests', async () => {
    const res = await request(app).get(`/api/shopkeeper/transactions/${completed.transactionId}/receipt`);

    expect(res.status).toBe(401);
  });

  it('refuses a beneficiary token', async () => {
    const res = await getReceipt(completed.transactionId, await beneficiaryToken());

    expect(res.status).toBe(403);
  });
});

describe('replayed distribution', () => {
  it('returns the same transaction id on a retried finalize, so the receipt is the original one', async () => {
    const card = await seedCard('replay');
    const qr = await makeQr(card);
    const riceSessionId = await captureCommodity(card, qr, 'rice', MEASURED.rice);
    const wheatSessionId = await captureCommodity(card, qr, 'wheat', MEASURED.wheat);
    const body = {
      ration_card_id: card.rationCardId,
      session_id: qr,
      rice_session_id: riceSessionId,
      wheat_session_id: wheatSessionId,
    };
    const first = await request(app).post('/api/shopkeeper/dispense').set('Authorization', `Bearer ${shopA.token}`).send(body);
    const replay = await request(app).post('/api/shopkeeper/dispense').set('Authorization', `Bearer ${shopA.token}`).send(body);

    expect(first.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.transaction.id).toBe(first.body.transaction.id);
    const { receipt } = (await getReceipt(first.body.transaction.id)).body;
    expect(receipt.totals.measuredGrams).toBe(MEASURED.rice + MEASURED.wheat);
  });
});
