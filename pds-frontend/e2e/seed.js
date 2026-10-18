import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { assertDisposableE2eDatabase } from './disposableDb.js';

const { Pool } = pg;

export const SHOPKEEPER_PASSWORD = 'E2eShopkeeper123!';
export const ADMIN_PASSWORD = 'E2eAdmin123!';

// Seeds one shopkeeper + shop + IoT device + beneficiary/wallet + a valid
// qr_sessions row directly via SQL — mirrors exactly how pds-backend's own
// integration tests (tests/*.test.js) seed data, since there is no
// UI-driven way to create a beneficiary session without simulating the
// beneficiary app's OTP login (out of scope for this flow's E2E test; see
// iot-device/PHASE2_DONE.md).
export async function seedE2eData() {
    const connectionString = process.env.E2E_DATABASE_URL;
    if (!connectionString) {
        throw new Error(
            'E2E_DATABASE_URL must be set to a pds-backend-migrated Postgres connection string ' +
                '(see iot-device/PHASE2_DONE.md) to run the IoT dispense E2E test.',
        );
    }

    assertDisposableE2eDatabase(connectionString);
    const pool = new Pool({ connectionString });
    const suffix = crypto.randomBytes(4).toString('hex');

    try {
        const adminEmail = `e2e-admin-${suffix}@e2e-test.com`;
        const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        await pool.query(`INSERT INTO users (role, email, password_hash) VALUES ('admin', $1, $2)`, [
            adminEmail,
            adminPasswordHash,
        ]);

        const areaRes = await pool.query(`INSERT INTO areas (name) VALUES ($1) RETURNING id`, [
            `E2E Area ${suffix}`,
        ]);
        const areaId = areaRes.rows[0].id;

        const shopRes = await pool.query(
            `INSERT INTO shops (shop_code, shop_name, area_id) VALUES ($1, $2, $3) RETURNING id`,
            [`E2E-${suffix}`, `E2E Shop ${suffix}`, areaId],
        );
        const shopId = shopRes.rows[0].id;

        const shopkeeperEmail = `e2e-shopkeeper-${suffix}@e2e-test.com`;
        const passwordHash = await bcrypt.hash(SHOPKEEPER_PASSWORD, 10);
        const shopkeeperRes = await pool.query(
            `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', $1, $2, $3) RETURNING id`,
            [shopkeeperEmail, `+9190${suffix}`.slice(0, 13), passwordHash],
        );
        const shopkeeperId = shopkeeperRes.rows[0].id;
        await pool.query(`UPDATE shops SET shopkeeper_id = $1 WHERE id = $2`, [shopkeeperId, shopId]);

        const deviceId = `esp32-e2e-${suffix}`;
        const deviceRawToken = `e2e-device-token-${suffix}`;
        const deviceTokenHash = await bcrypt.hash(deviceRawToken, 10);
        await pool.query(`INSERT INTO iot_devices (device_id, device_token_hash, shop_id) VALUES ($1, $2, $3)`, [
            deviceId,
            deviceTokenHash,
            shopId,
        ]);

        const headRes = await pool.query(`INSERT INTO users (role) VALUES ('beneficiary') RETURNING id`);
        const headId = headRes.rows[0].id;

        const rcRes = await pool.query(
            `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
       VALUES ($1, 'BPL', $2, $3, $4) RETURNING id`,
            [`E2E-CARD-${suffix}`, headId, shopId, areaId],
        );
        const rationCardId = rcRes.rows[0].id;

        await pool.query(
            `INSERT INTO family_members (ration_card_id, user_id, name, age, is_head) VALUES ($1, $2, 'E2E Head', 30, true)`,
            [rationCardId, headId],
        );

        // BPL policy = 5kg rice/person (migration 001's seed); 1 person
        // (head only) => a clean, deterministic 5kg = 5000g wallet balance.
        await pool.query(
            `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg) VALUES ($1, 5, 3)`,
            [rationCardId],
        );

        const qrSessionId = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + 60_000);
        await pool.query(
            `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
            [qrSessionId, rationCardId, shopId, headId, expiresAt],
        );

        return {
            shopId,
            adminEmail,
            adminPassword: ADMIN_PASSWORD,
            shopkeeperEmail,
            shopkeeperPassword: SHOPKEEPER_PASSWORD,
            deviceId,
            deviceRawToken,
            rationCardId,
            qrPayload: { rationCardId, sessionId: qrSessionId, expiresAt: expiresAt.toISOString() },
        };
    } finally {
        await pool.end();
    }
}

// Seeds data for the Phase 3 ops/hardening E2E flows (fleet page + anomaly
// dropdown) — a separate, minimal seed rather than reusing seedE2eData()
// since these flows don't need a beneficiary/QR/wallet at all.
export async function seedIotOpsData() {
    const connectionString = process.env.E2E_DATABASE_URL;
    if (!connectionString) {
        throw new Error('E2E_DATABASE_URL must be set (see iot-device/PHASE3_DONE.md) to run this E2E test.');
    }

    assertDisposableE2eDatabase(connectionString);
    const pool = new Pool({ connectionString });
    const suffix = crypto.randomBytes(4).toString('hex');

    try {
        const adminEmail = `e2e-ops-admin-${suffix}@e2e-test.com`;
        const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        await pool.query(`INSERT INTO users (role, email, password_hash) VALUES ('admin', $1, $2)`, [
            adminEmail,
            adminPasswordHash,
        ]);

        const areaRes = await pool.query(`INSERT INTO areas (name) VALUES ($1) RETURNING id`, [
            `E2E Ops Area ${suffix}`,
        ]);
        const areaId = areaRes.rows[0].id;

        // Shop + device that has never connected -> fleet page should show "Offline".
        const offlineShopRes = await pool.query(
            `INSERT INTO shops (shop_code, shop_name, area_id) VALUES ($1, $2, $3) RETURNING id`,
            [`E2E-OFF-${suffix}`, `E2E Offline Shop ${suffix}`, areaId],
        );
        const offlineDeviceId = `esp32-e2e-offline-${suffix}`;
        const offlineTokenHash = await bcrypt.hash(`offline-token-${suffix}`, 10);
        await pool.query(`INSERT INTO iot_devices (device_id, device_token_hash, shop_id) VALUES ($1, $2, $3)`, [
            offlineDeviceId,
            offlineTokenHash,
            offlineShopRes.rows[0].id,
        ]);

        // A second shop + 7 dispense_records within a 60s window -> trips
        // RAPID_FIRE (limit 6/min), so /api/admin/anomalies/run-now creates
        // a critical flag the admin badge should reflect.
        const rapidShopRes = await pool.query(
            `INSERT INTO shops (shop_code, shop_name, area_id) VALUES ($1, $2, $3) RETURNING id`,
            [`E2E-RAP-${suffix}`, `E2E Rapid Shop ${suffix}`, areaId],
        );
        const rapidShopId = rapidShopRes.rows[0].id;
        const rcRes = await pool.query(
            `INSERT INTO ration_cards (card_number, category, shop_id, area_id) VALUES ($1, 'BPL', $2, $3) RETURNING id`,
            [`E2E-RAP-CARD-${suffix}`, rapidShopId, areaId],
        );
        const rationCardId = rcRes.rows[0].id;

        const now = Date.now();
        for (let i = 0; i < 7; i += 1) {
            const sessionRes = await pool.query(
                `INSERT INTO dispense_sessions (shop_id, ration_card_id, commodity, entitled_grams, tolerance_grams, state, expires_at, committed_at)
         VALUES ($1, $2, 'rice', 5000, 50, 'committed', NOW() + INTERVAL '1 minute', NOW())
         RETURNING id`,
                [rapidShopId, rationCardId],
            );
            const committedAt = new Date(now - (10 - i) * 1000);
            await pool.query(
                `INSERT INTO dispense_records (session_id, ration_card_id, shop_id, commodity, entitled_grams, measured_grams, row_hash, committed_at)
         VALUES ($1, $2, $3, 'rice', 5000, 5000, $4, $5)`,
                [sessionRes.rows[0].id, rationCardId, rapidShopId, `e2e-hash-${suffix}-${i}`, committedAt],
            );
        }

        return {
            adminEmail,
            adminPassword: ADMIN_PASSWORD,
            offlineDeviceId,
            offlineShopName: `E2E Offline Shop ${suffix}`,
            rapidShopId,
        };
    } finally {
        await pool.end();
    }
}
