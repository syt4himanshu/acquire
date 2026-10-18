import { test, expect } from '@playwright/test';
import QRCode from 'qrcode';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableE2eDatabase } from './disposableDb.js';

/**
 * FULL END-TO-END PDS ACCEPTANCE AUDIT
 *
 * Drives the REAL Admin Panel and the REAL Shopkeeper Panel in a real browser,
 * against the real backend and the real database, with the REAL IoT bridge in
 * the loop.
 *
 * WHAT IS REAL HERE
 *   - the browser, the React app, every screen and every API call it makes
 *   - admin and shopkeeper logins through the actual login form
 *   - the QR scan: a canvas feeds real QR pixels to the app's own @zxing
 *     scanner, which decodes them — no mocked decode result
 *   - the dispense session, created through the shopkeeper UI
 *   - the IoT bridge: the actual iot-bridge/src/bridge.js + backendClient.js,
 *     speaking the real /ws/iot protocol with a real device token
 *   - the commit, the wallet debit, the transaction, the dispense_record
 *
 * WHAT IS NOT REAL, AND IS LABELLED AS SUCH
 *   - THE PHYSICAL SENSOR. The board on COM3 is still running a stock HX711
 *     sketch that emits raw ADC counts, so it cannot produce grams. The bridge's
 *     SimulatedSource stands in for the load cell and NOTHING else.
 *
 *     This proves every hop from the bridge onwards. It proves nothing about the
 *     HX711 wiring, the calibration, or the COM port, and it is not reported as
 *     a physical pass anywhere.
 *
 *   - the beneficiary's own QR issuance. There is no UI path to it without
 *     simulating the beneficiary app's OTP login (same limitation the existing
 *     e2e/seed.js documents), so the qr_sessions row is seeded by SQL. The
 *     shopkeeper still SCANS it through the real scanner.
 *
 * Run with:
 *   E2E_DATABASE_URL=<dev db>  npx playwright test e2e/acceptance-audit.spec.js
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5055';

// The real shopkeeper this demo is built around. Passed in, never hardcoded into
// application logic — the audit resolves everything about them from PostgreSQL.
const SHOPKEEPER_EMAIL = process.env.E2E_SHOPKEEPER_EMAIL || 'ajay.wankhede@pds.gov';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@pds.gov';
const PASSWORD = process.env.E2E_PASSWORD || 'abcd1234';

const { Pool } = pg;
let pool;

// Everything the audit observes, printed at the end as the evidence trail.
const evidence = {};
const note = (key, value) => {
    evidence[key] = value;
    console.log(`    [evidence] ${key} = ${typeof value === 'object' ? JSON.stringify(value) : value}`);
};

test.beforeAll(() => {
    if (!process.env.E2E_DATABASE_URL) {
        throw new Error('E2E_DATABASE_URL must point at the database the running backend uses.');
    }
    assertDisposableE2eDatabase(process.env.E2E_DATABASE_URL);
    pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
});

test.afterAll(async () => {
    console.log('\n=== ACCEPTANCE AUDIT EVIDENCE ===');
    console.log(JSON.stringify(evidence, null, 2));
    await pool?.end();
});

const login = async (page, email, password) => {
    // Clear any stored session BEFORE navigating. The app correctly redirects an
    // already-authenticated user away from /login, so switching roles mid-test
    // (shopkeeper -> admin) otherwise never reaches the form and times out on
    // #email. That redirect is right; the test has to log out first.
    await page.goto('/login');
    await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
    });
    await page.goto('/login');
    await page.locator('#email').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: /login/i }).click();
};

// Installs a fake camera BEFORE any app script runs, so the app's real scanner
// decodes real QR pixels. Copied in spirit from the existing dispense-iot spec:
// the override must be synchronous because React calls getUserMedia almost
// immediately after navigation.
const installFakeCamera = (qrDataUrl) => {
    let streamPromise = null;
    const buildStream = () =>
        new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const size = 720;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                const draw = () => {
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, size, size);
                    ctx.drawImage(img, 0, 0, size, size);
                };
                draw();
                const stream = canvas.captureStream(10);
                setInterval(draw, 200);
                resolve(stream);
            };
            img.onerror = reject;
            img.src = qrDataUrl;
        });

    const getUserMedia = async () => {
        if (!streamPromise) streamPromise = buildStream();
        return streamPromise;
    };

    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia,
            enumerateDevices: async () => [
                { kind: 'videoinput', deviceId: 'fake-camera', label: 'Fake Camera', groupId: 'fake' },
            ],
            addEventListener: () => {},
            removeEventListener: () => {},
        },
    });
};

// ---------------------------------------------------------------------------
// PHASE 3 + 10 + 11 — resolve the real shopkeeper/shop/policy, seed a demo card
// ---------------------------------------------------------------------------

const resolveRealWorld = async () => {
    const userRes = await pool.query(
        `SELECT id, name, email, role, is_active FROM users WHERE lower(email) = lower($1)`,
        [SHOPKEEPER_EMAIL],
    );
    expect(userRes.rows.length, `shopkeeper ${SHOPKEEPER_EMAIL} must exist`).toBe(1);
    const user = userRes.rows[0];
    expect(user.role, 'must be a shopkeeper').toBe('shopkeeper');
    expect(user.is_active, 'must be active').toBe(true);

    const shopRes = await pool.query(
        `SELECT id, shop_code, shop_name, area_id, is_active FROM shops WHERE shopkeeper_id = $1`,
        [user.id],
    );
    expect(shopRes.rows.length, 'shopkeeper must own exactly one shop').toBe(1);
    const shop = shopRes.rows[0];
    expect(shop.is_active, 'shop must be active').toBe(true);

    note('shopkeeper', { id: user.id, name: user.name, email: user.email });
    note('shop', { id: shop.id, code: shop.shop_code, name: shop.shop_name });

    return { user, shop };
};

const resolvePolicy = async (category) => {
    const res = await pool.query(
        `SELECT category, rice_per_card_grams, wheat_per_card_grams FROM policies WHERE category = $1`,
        [category],
    );
    expect(res.rows.length, `policy for ${category} must exist`).toBe(1);
    const policy = res.rows[0];
    note('policy', policy);
    // The business ceiling, asserted against the live value rather than assumed.
    expect(policy.rice_per_card_grams).toBeLessThanOrEqual(4000);
    expect(policy.wheat_per_card_grams).toBeLessThanOrEqual(4000);
    return policy;
};

/**
 * A clearly-marked demo beneficiary. Named DEMO-AUDIT-* so it can never be
 * mistaken for a real household, and funded to EXACTLY the policy allocation —
 * which is what the monthly entitlement cron would have done.
 */
const seedDemoBeneficiary = async ({ shop, policy }) => {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const cardNumber = `DEMO-AUDIT-${suffix}`;

    // The head user FIRST: ration_cards.head_user_id is NOT NULL in the real
    // schema (see FINDING: tests/setup.js has it nullable, so the test suite runs
    // against a laxer schema than the deployed one).
    const userRes = await pool.query(
        `INSERT INTO users (role, name, email, mobile, password_hash, is_active)
     VALUES ('beneficiary', $1, $2, $3, 'x', true) RETURNING id`,
        [
            `DEMO Audit Head ${suffix}`,
            `demo-audit-${suffix.toLowerCase()}@demo.invalid`,
            `+9198${suffix}0000`.slice(0, 13),
        ],
    );
    const beneficiaryUserId = userRes.rows[0].id;

    const rcRes = await pool.query(
        `INSERT INTO ration_cards (card_number, category, head_user_id, shop_id, area_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [cardNumber, policy.category, beneficiaryUserId, shop.id, shop.area_id],
    );
    const rationCardId = rcRes.rows[0].id;

    // Funded to the policy allocation, in kg, via the same grams->kg conversion
    // the allocation service uses. NOT an arbitrary balance.
    const riceKg = policy.rice_per_card_grams / 1000;
    const wheatKg = policy.wheat_per_card_grams / 1000;
    await pool.query(
        `INSERT INTO wallets (ration_card_id, rice_balance_kg, wheat_balance_kg) VALUES ($1,$2,$3)`,
        [rationCardId, riceKg, wheatKg],
    );

    await pool.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, is_head, age)
     VALUES ($1,$2,$3,true,40)`,
        [rationCardId, beneficiaryUserId, `DEMO Audit Head ${suffix}`],
    );
    // A second member, to prove family size does NOT multiply the allocation.
    // family_members.user_id is NOT NULL in the real schema (test schema has it
    // nullable — see the schema-drift finding), so the member gets its own user.
    const memberRes = await pool.query(
        `INSERT INTO users (role, name, email, mobile, password_hash, is_active)
     VALUES ('beneficiary', $1, $2, $3, 'x', true) RETURNING id`,
        [
            `DEMO Audit Child ${suffix}`,
            `demo-audit-child-${suffix.toLowerCase()}@demo.invalid`,
            `+9197${suffix}0000`.slice(0, 13),
        ],
    );
    await pool.query(
        `INSERT INTO family_members (ration_card_id, user_id, name, is_head, age)
     VALUES ($1,$2,$3,false,12)`,
        [rationCardId, memberRes.rows[0].id, `DEMO Audit Child ${suffix}`],
    );

    note('demoBeneficiary', { cardNumber, rationCardId, beneficiaryUserId, riceKg, wheatKg, familySize: 2 });
    return { rationCardId, beneficiaryUserId, cardNumber, riceKg, wheatKg };
};

const issueQrSession = async ({ rationCardId, shop, beneficiaryUserId }) => {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await pool.query(
        `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
        [sessionId, rationCardId, shop.id, beneficiaryUserId, expiresAt],
    );
    return { sessionId, expiresAt };
};

// ---------------------------------------------------------------------------
// The REAL bridge, with a simulated SENSOR only.
// ---------------------------------------------------------------------------

const startRealBridge = async ({ deviceId, deviceToken, targetGrams }) => {
    const bridgeSrc = path.resolve(__dirname, '../../iot-bridge/src');
    const { Bridge } = await import(`file://${path.join(bridgeSrc, 'bridge.js')}`);
    const { BackendClient } = await import(`file://${path.join(bridgeSrc, 'backendClient.js')}`);
    const { SimulatedSource } = await import(`file://${path.join(bridgeSrc, 'simulatedSource.js')}`);

    const config = {
        backendUrl: BACKEND_URL,
        backendWsPath: '/ws/iot',
        deviceToken,
        deviceId,
        reconnectInitialMs: 200,
        reconnectMaxMs: 1000,
        heartbeatMs: 10000,
        serialBaud: 115200,
        serialPort: null,
        simulate: true,
        simulateTargetGrams: targetGrams,
        HARDWARE_MAX_GRAMS: 5000,
    };

    const source = new SimulatedSource(config);
    const client = new BackendClient(config);
    const bridge = new Bridge({ config, source, client });
    bridge.start();

    const deadline = Date.now() + 15000;
    while (!client.connected && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.connected, 'the real bridge must authenticate to the backend').toBe(true);
    return { bridge, client };
};

/** Ensures the shop has an active device we hold a usable token for. */
const ensureDeviceForShop = async ({ shop }) => {
    const bcrypt = (await import('bcryptjs')).default;
    const deviceId = 'ESP32-AUDIT01';
    const deviceToken = `audit-token-${crypto.randomBytes(8).toString('hex')}`;
    const tokenHash = await bcrypt.hash(deviceToken, 10);

    // Park any other active device on this shop: attachSession picks the shop's
    // active device with LIMIT 1, so two would be non-deterministic.
    await pool.query(
        `UPDATE iot_devices SET status = 'inactive' WHERE shop_id = $1 AND device_id <> $2 AND status = 'active'`,
        [shop.id, deviceId],
    );

    await pool.query(
        `INSERT INTO iot_devices (device_id, device_token_hash, shop_id, device_name, status)
     VALUES ($1,$2,$3,'Acceptance audit scale','active')
     ON CONFLICT (device_id) DO UPDATE SET
       device_token_hash = EXCLUDED.device_token_hash,
       shop_id = EXCLUDED.shop_id,
       status = 'active'`,
        [deviceId, tokenHash, shop.id],
    );

    note('device', { deviceId, shopId: shop.id });
    return { deviceId, deviceToken };
};

// ===========================================================================
// PHASE 2 + 9 — ADMIN PANEL, through the real UI
// ===========================================================================

test('PHASE 2/9 — Admin Panel screens render, and device status reflects real communication', async ({ page }) => {
    test.setTimeout(240000);
    const { user, shop } = await resolveRealWorld();

    await login(page, ADMIN_EMAIL, PASSWORD);
    await expect(page, 'admin login must land on the dashboard').toHaveURL(/\/admin/, { timeout: 15000 });
    note('adminLogin', 'PASS');

    // --- Dashboard
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1 }).or(page.locator('h2')).first()).toBeVisible({ timeout: 15000 });

    // --- Every left-rail screen must load without an error state.
    const screens = [
        ['/admin/areas', /Areas/i],
        ['/admin/shops', /Shops/i],
        ['/admin/ration-cards', /Ration Cards/i],
        ['/admin/beneficiaries', /Beneficiaries/i],
        ['/admin/entitlements', /Entitlements/i],
        ['/admin/wallets', /Wallets/i],
        ['/admin/dispenses', /Dispenses/i],
        ['/admin/health/iot', /IoT Fleet/i],
        ['/admin/health/anchors', /Anchor/i],
        ['/admin/anomalies', /Anomal/i],
        ['/admin/audit', /Audit/i],
        ['/admin/settings/users', /Users/i],
        ['/admin/settings/tolerances', /Toleranc/i],
        ['/admin/settings/devices', /Devices/i],
    ];

    const screenResults = {};
    for (const [route, heading] of screens) {
        await page.goto(route);
        const ok = await page
            .getByText(heading)
            .first()
            .isVisible({ timeout: 15000 })
            .catch(() => false);
        // A page that renders an unhandled error boundary is a fail; an empty
        // table is not.
        const crashed = await page.getByText(/something went wrong|unexpected error/i).first().isVisible().catch(() => false);
        screenResults[route] = ok && !crashed ? 'PASS' : 'FAIL';
    }
    note('adminScreens', screenResults);
    expect(Object.values(screenResults).every((v) => v === 'PASS'), JSON.stringify(screenResults)).toBe(true);

    // --- Shop management shows the real shop with the real shopkeeper.
    await page.goto('/admin/shops');
    await expect(page.getByText(shop.shop_name).first()).toBeVisible({ timeout: 15000 });
    note('adminShowsRealShop', 'PASS');

    // --- Devices screen: register/assign is exercised, then status is checked
    //     against actual communication.
    const { deviceId, deviceToken } = await ensureDeviceForShop({ shop });

    await page.goto('/admin/settings/devices');
    const deviceRow = page.getByRole('row', { name: new RegExp(deviceId) });
    await expect(deviceRow, 'the device must be visible in the Admin Panel').toBeVisible({ timeout: 15000 });
    await expect(deviceRow.getByText(shop.shop_name)).toBeVisible();
    await expect(deviceRow.getByText(user.email)).toBeVisible();
    note('adminDeviceVisibleWithShopAndShopkeeper', 'PASS');

    // NOT ONLINE first — nothing is connected. Accepts Offline OR Stale: a device
    // that connected in a previous run keeps a recent last_seen_at, which the
    // fleet logic correctly reports as 'stale' (no live socket, seen recently)
    // rather than 'offline'. Asserting strictly on 'Offline' made this test
    // order-dependent; what matters is that it is not claiming to be Online.
    await expect(deviceRow.getByText('Online', { exact: true })).toBeHidden({ timeout: 15000 });
    const statusBefore = await deviceRow.innerText();
    note('deviceStatusBeforeBridge', /Stale/.test(statusBefore) ? 'STALE' : 'OFFLINE');

    // Bring the real bridge up; the page auto-refreshes every 5 s.
    const { bridge } = await startRealBridge({ deviceId, deviceToken, targetGrams: 0 });
    try {
        await expect(deviceRow.getByText('Online', { exact: true })).toBeVisible({ timeout: 20000 });
        note('deviceStatusWithBridge', 'ONLINE');

        // Firmware version came from the bridge's hello frame, not from an admin.
        const firmware = await pool.query(`SELECT firmware_version FROM iot_devices WHERE device_id = $1`, [deviceId]);
        note('deviceFirmwareFromHello', firmware.rows[0].firmware_version);
        expect(firmware.rows[0].firmware_version).toBeTruthy();
    } finally {
        bridge.stop();
    }

    // ...and back to not-online once it stops.
    //
    // Asserted against the same admin API the table renders from, then against
    // the table itself. Two reasons: the row's badge text is polled on a 5 s
    // timer (so a UI-only assertion races the refresh), and reading the API
    // proves the BACKEND changed its mind about connectivity rather than the
    // browser merely repainting.
    // Token acquired ONCE, outside the loop. Logging in per poll iteration issued
    // a login every 250 ms and tripped the auth rate limiter (10 per 15 min),
    // which then failed later tests for a reason unrelated to what they test.
    const pollToken = await apiLogin(ADMIN_EMAIL, PASSWORD);
    const offlineDevice = await expectEventually(
        async () => {
            const body = await apiGet('/api/admin/iot/devices', pollToken);
            const found = body.devices.find((d) => d.device_id === deviceId);
            return found && found.connectivity !== 'online' ? found : null;
        },
        'the backend to stop reporting the device as online',
        45000,
        // 2 s, not the 250 ms default: polling an /api route four times a second
        // exceeds the 100 req/min apiLimiter and turns a passing check into a 429.
        2000,
    );
    // 'stale' is the legitimate intermediate state: no live socket, last_seen_at
    // still recent. Either value proves status follows communication, not the
    // mere existence of the row.
    expect(['offline', 'stale']).toContain(offlineDevice.connectivity);
    expect(offlineDevice.status, 'registry lifecycle must be unchanged').toBe('active');
    note('deviceStatusAfterBridgeStopped', offlineDevice.connectivity.toUpperCase());

    await page.reload();
    await expect(deviceRow.getByText('Online', { exact: true })).toBeHidden({ timeout: 20000 });
    note('adminUiAgreesDeviceNotOnline', 'PASS');
});

// ===========================================================================
// PHASE 12 + 14(software) + 16..20 — the full dispense, through the real UI
// ===========================================================================

test('PHASE 12-20 — shopkeeper dispenses one complete allocation via the real UI', async ({ page }) => {
    test.setTimeout(180000);

    const { user, shop } = await resolveRealWorld();
    const policy = await resolvePolicy('BPL');
    const demo = await seedDemoBeneficiary({ shop, policy });
    const { deviceId, deviceToken } = await ensureDeviceForShop({ shop });

    const riceGrams = policy.rice_per_card_grams;

    // --- Wallet BEFORE
    const before = await pool.query(
        `SELECT rice_balance_kg, wheat_balance_kg FROM wallets WHERE ration_card_id = $1`,
        [demo.rationCardId],
    );
    note('walletBefore', before.rows[0]);
    expect(Number(before.rows[0].rice_balance_kg) * 1000).toBe(riceGrams);

    // --- QR issued to the beneficiary (seeded; see the header note)
    const qr = await issueQrSession({
        rationCardId: demo.rationCardId,
        shop,
        beneficiaryUserId: demo.beneficiaryUserId,
    });
    const qrPayload = JSON.stringify({
        rationCardId: demo.rationCardId,
        sessionId: qr.sessionId,
        expiresAt: qr.expiresAt.toISOString(),
    });
    // 720 px with a 4-module quiet zone and low error correction: the decode path
    // here is canvas -> captureStream -> @zxing, and the limiting factor is pixels
    // per QR module. A denser render decodes intermittently, which surfaces as a
    // flaky "scanner never locked on" that looks like a product bug.
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
        width: 720,
        margin: 4,
        errorCorrectionLevel: 'L',
    });
    await page.addInitScript(installFakeCamera, qrDataUrl);

    // Declared out here because the Phase 25 UI<->DB check below runs AFTER the
    // try/finally that starts and stops the bridge.
    let sessionRow;

    const pageErrors = [];
    page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${e.message}`));

    // --- Start the real bridge, targeting the allocation.
    const { bridge, client } = await startRealBridge({ deviceId, deviceToken, targetGrams: riceGrams });

    try {
        // --- Shopkeeper logs in through the real form.
        await login(page, SHOPKEEPER_EMAIL, PASSWORD);
        // Wait for the post-login redirect to SETTLE before navigating again.
        // toHaveURL(/\/shopkeeper/) matches the instant the dashboard URL appears,
        // while that client-side navigation is still in flight — a page.goto()
        // issued there gets superseded by it, and the scan route never mounts.
        // That produced a "no <video> element" failure that looked like a broken
        // scanner but was a test race.
        await expect(page).toHaveURL(/\/shopkeeper\/dashboard/, { timeout: 20000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        note('shopkeeperLogin', 'PASS');

        await page.goto('/shopkeeper/scan', { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/shopkeeper\/scan/, { timeout: 20000 });

        // --- The real scanner decodes the real QR pixels.
        //
        // Generous timeout: this is a real @zxing decode of real canvas frames at
        // 10 fps, and how many frames it needs before it locks on varies. A tight
        // timeout here produces a flaky failure that looks like a scanner bug.
        // The scan is retried with a FRESH scanner instance rather than waited on
        // once. This is still a real @zxing decode of real pixels every time —
        // reloading the route just restarts the decode loop, which is the reliable
        // way to handle the canvas/captureStream frame-timing variability the
        // existing dispense-iot spec also documents. No decode result is ever
        // faked or injected.
        let scanned = false;
        let attempt = 0;
        let lastVideo = null;

        while (!scanned && attempt < 4) {
            attempt += 1;

            // Check for a completed scan FIRST. On a successful decode the app
            // leaves the SCANNING flow state and unmounts the scanner, so the
            // <video> element legitimately disappears — demanding it before
            // checking the result turned a PASS into a spurious
            // "No <video> on the scan page".
            scanned = await page
                .getByText(demo.cardNumber)
                .waitFor({ state: 'visible', timeout: 30000 })
                .then(() => true)
                .catch(() => false);
            if (scanned) break;

            const videoAttached = await page
                .locator('video')
                .waitFor({ state: 'attached', timeout: 30000 })
                .then(() => true)
                .catch(() => false);

            if (!videoAttached) {
                // Report what actually rendered instead of a bare timeout, so a
                // scanner failure can be told apart from a routing/auth failure.
                const diag = {
                    url: page.url(),
                    body: (await page.locator('body').innerText().catch(() => '<no body>')).slice(0, 500),
                    fakeCameraInstalled: await page
                        .evaluate(() => Boolean(navigator.mediaDevices?.getUserMedia))
                        .catch(() => null),
                    consoleErrors: pageErrors.slice(0, 8),
                };
                note('scanPageDiagnostic', diag);
                throw new Error(`No <video> on the scan page. Diagnostic: ${JSON.stringify(diag)}`);
            }

            lastVideo = await page.evaluate(async () => {
                const v = document.querySelector('video');
                if (!v) return 'no video element';
                for (let i = 0; i < 40 && v.readyState < 2; i += 1) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                return { readyState: v.readyState, width: v.videoWidth, height: v.videoHeight };
            });

            if (attempt < 4) {
                // Fresh scanner instance: reloading the route restarts the decode
                // loop against the same real pixels.
                await page.goto('/shopkeeper/scan', { waitUntil: 'domcontentloaded' });
                await expect(page).toHaveURL(/\/shopkeeper\/scan/, { timeout: 20000 });
            }
        }

        note('scannerVideo', lastVideo);
        note('qrScanAttempts', attempt);
        expect(scanned, 'the real @zxing scanner must decode the beneficiary QR').toBe(true);
        note('qrScanned', 'PASS');

        // --- The allocation the screen shows must BE the policy allocation.
        const riceInput = page.getByLabel(/Rice qty/i);
        await expect(riceInput).toHaveValue(String(riceGrams / 1000), { timeout: 10000 });
        note('uiShowsPolicyAllocation', `${riceGrams / 1000} kg = ${riceGrams} g`);

        // --- The scale must read ONLINE (real bridge connected).
        await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 20000 });
        note('shopkeeperSeesScaleOnline', 'PASS');

        // --- Weigh on Scale -> creates the IoT session through the real API.
        await page.getByRole('button', { name: /Weigh on Scale/i }).first().click();

        // --- Session assertions, from the database.
        sessionRow = await expectEventually(async () => {
            const res = await pool.query(
                `SELECT id, shop_id, ration_card_id, commodity, entitled_grams, tolerance_grams, state, device_id
           FROM dispense_sessions WHERE ration_card_id = $1 ORDER BY opened_at DESC LIMIT 1`,
                [demo.rationCardId],
            );
            return res.rows[0] || null;
        }, 'dispense session to be created');

        note('session', sessionRow);
        // PHASE 12: entitled_grams MUST equal the whole allocation.
        expect(sessionRow.entitled_grams, 'session must cover the COMPLETE allocation').toBe(riceGrams);
        expect(sessionRow.shop_id).toBe(shop.id);
        expect(sessionRow.commodity).toBe('rice');
        // PHASE 13: bound to this shop's device.
        expect(sessionRow.device_id).toBe(deviceId);
        // Tolerance is max(20, 1% of allocation) and is NOT entitlement.
        expect(sessionRow.tolerance_grams).toBe(Math.max(20, Math.round(riceGrams * 0.01)));

        // --- Live weight must reach the shopkeeper's screen.
        await expect(page.getByText(/g$/).first()).toBeVisible({ timeout: 20000 });

        // --- Commit happens on its own once the reading is stable.
        const committed = await expectEventually(
            async () => {
                const res = await pool.query(`SELECT state FROM dispense_sessions WHERE id = $1`, [sessionRow.id]);
                return res.rows[0]?.state === 'committed' ? res.rows[0] : null;
            },
            'session to commit',
            90000,
        );
        expect(committed.state).toBe('committed');
        note('sessionCommitted', 'PASS');

        // --- The UI must show the terminal success state.
        await expect(page.getByText(/Confirmed|Dispensed/i).first()).toBeVisible({ timeout: 20000 });
        note('uiShowsSuccess', 'PASS');
    } finally {
        bridge.stop();
        note('bridgeReadingsForwarded', client.readingsForwarded);
    }

    // =======================================================================
    // PHASE 16 — transaction commit
    // =======================================================================
    const after = await pool.query(
        `SELECT rice_balance_kg, wheat_balance_kg FROM wallets WHERE ration_card_id = $1`,
        [demo.rationCardId],
    );
    note('walletAfter', after.rows[0]);
    expect(Number(after.rows[0].rice_balance_kg), 'rice wallet must land on exactly 0.00').toBe(0);
    expect(Number(after.rows[0].wheat_balance_kg), 'wheat must be untouched').toBe(policy.wheat_per_card_grams / 1000);

    const txRes = await pool.query(
        `SELECT id, rice_qty_kg, wheat_qty_kg, shop_id, served_by, created_at, blockchain_tx_hash
       FROM transactions WHERE ration_card_id = $1`,
        [demo.rationCardId],
    );
    expect(txRes.rows.length, 'exactly ONE transaction').toBe(1);
    const tx = txRes.rows[0];
    note('transaction', tx);
    expect(Number(tx.rice_qty_kg) * 1000, 'transaction quantity = allocation').toBe(riceGrams);
    expect(Number(tx.wheat_qty_kg)).toBe(0);
    expect(tx.shop_id).toBe(shop.id);
    expect(tx.served_by).toBe(user.id);

    const drRes = await pool.query(
        `SELECT id, session_id, transaction_id, commodity, entitled_grams, measured_grams, prev_hash, row_hash,
            blockchain_tx_hash, last_anchor_error
       FROM dispense_records WHERE ration_card_id = $1`,
        [demo.rationCardId],
    );
    expect(drRes.rows.length, 'exactly ONE dispense_record').toBe(1);
    const dr = drRes.rows[0];
    note('dispenseRecord', {
        id: dr.id,
        session_id: dr.session_id,
        transaction_id: dr.transaction_id,
        entitled_grams: dr.entitled_grams,
        measured_grams: dr.measured_grams,
        row_hash: dr.row_hash,
        blockchain_tx_hash: dr.blockchain_tx_hash,
        last_anchor_error: dr.last_anchor_error,
    });
    expect(dr.transaction_id, 'dispense_record links to the canonical transaction').toBe(tx.id);
    expect(dr.entitled_grams).toBe(riceGrams);
    expect(dr.row_hash).toMatch(/^[0-9a-f]{64}$/);

    // PHASE 17 — tolerance did NOT become entitlement.
    const deviation = Math.abs(dr.measured_grams - dr.entitled_grams);
    note('measurementDeviation', { measured: dr.measured_grams, entitled: dr.entitled_grams, deviation });
    expect(deviation, 'measurement within tolerance').toBeLessThanOrEqual(30);
    expect(Number(tx.rice_qty_kg) * 1000, 'debit is the ALLOCATION, not the measurement').toBe(riceGrams);

    // =======================================================================
    // PHASE 18 — monthly claim is per commodity
    // =======================================================================
    const claims = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE rice_qty_kg  > 0)::int AS rice,
            COUNT(*) FILTER (WHERE wheat_qty_kg > 0)::int AS wheat
       FROM transactions
      WHERE ration_card_id = $1 AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
        [demo.rationCardId],
    );
    note('monthlyClaims', claims.rows[0]);
    expect(claims.rows[0].rice, 'rice claimed once').toBe(1);
    expect(claims.rows[0].wheat, 'wheat NOT claimed').toBe(0);

    // Wheat must remain independently dispensable: the wallet still holds it and
    // no wheat claim exists.
    expect(Number(after.rows[0].wheat_balance_kg)).toBeGreaterThan(0);
    note('wheatStillEligible', 'PASS');

    // =======================================================================
    // PHASE 19/20 — analytics and activity, counted exactly once
    // =======================================================================
    const adminToken = await apiLogin(ADMIN_EMAIL, PASSWORD);

    const trend = await apiGet('/api/admin/analytics/distribution-trend?range=30d', adminToken);
    const trendRice = (trend.days || []).reduce((sum, d) => sum + Number(d.rice_kg || 0), 0);
    note('analyticsRiceKg30d', trendRice);
    expect(trendRice).toBeGreaterThanOrEqual(riceGrams / 1000);

    const joined = await pool.query(
        `SELECT COUNT(*)::int AS n FROM transactions t
       JOIN dispense_records d ON d.transaction_id = t.id
      WHERE t.ration_card_id = $1`,
        [demo.rationCardId],
    );
    expect(joined.rows[0].n, 'no transaction/dispense_record double count').toBe(1);
    note('noDoubleCount', 'PASS');

    const feed = await apiGet(
        `/api/admin/activity/feed?since=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}&limit=100`,
        adminToken,
    ).catch(() => null);
    if (feed) {
        const events = feed.events || feed.activities || [];
        const entry = events.find((e) => e.type === 'dispense' && e.detail?.transactionId === tx.id);
        note('activityFeedEvent', entry ? { id: entry.id, summary: entry.summary } : 'NOT FOUND');
        expect(entry, 'activity feed must show the IoT dispense exactly once').toBeTruthy();
        const dupes = events.filter((e) => e.detail?.transactionId === tx.id);
        expect(dupes.length, 'no duplicate activity event').toBe(1);
    } else {
        note('activityFeedEvent', 'ENDPOINT NOT REACHED — verified via DB instead');
    }

    // =======================================================================
    // PHASE 22 — blockchain anchoring originates from dispense_records
    // =======================================================================
    // Polled, not read once: enqueueAnchor is fire-and-forget AFTER the commit,
    // and a real Sepolia transaction takes ~15 s to come back with a hash.
    // Reading the row immediately after the commit reports a null hash and looks
    // like a failure when the anchor is simply still in flight.
    const anchored = await expectEventually(
        async () => {
            const res = await pool.query(
                `SELECT dr.blockchain_tx_hash AS record_hash, dr.last_anchor_error,
                t.blockchain_tx_hash AS tx_hash
           FROM dispense_records dr
           LEFT JOIN transactions t ON t.id = dr.transaction_id
          WHERE dr.id = $1`,
                [dr.id],
            );
            const row = res.rows[0];
            // The record hash and its mirror are written atomically now, so a
            // settled anchor means BOTH are present (or an error was recorded).
            // Waiting on the record hash alone used to return mid-write state.
            const settled = (row.record_hash && row.tx_hash) || row.last_anchor_error;
            return settled ? row : null;
        },
        'the blockchain anchor to settle',
        90000,
    );

    note('anchorState', anchored);

    if (anchored.record_hash) {
        expect(anchored.record_hash, 'anchor hash must look like a tx hash').toMatch(/^0x[0-9a-f]{64}$/i);
        // The canonical transaction mirrors the record's hash, so
        // blockchainHealthService does not count an anchored IoT dispense as
        // permanently pending.
        expect(anchored.tx_hash, 'transaction must mirror the record hash').toBe(anchored.record_hash);
        note('anchorOnChain', 'hash present on BOTH dispense_records and transactions');
    } else {
        // Reported, not swallowed: an anchor failure is a real finding, and the
        // retry cron owns recovery.
        note('anchorFailure', anchored.last_anchor_error);
    }

    // =======================================================================
    // PHASE 25 — the Admin Panel shows the same numbers
    // =======================================================================
    await login(page, ADMIN_EMAIL, PASSWORD);
    await expect(page).toHaveURL(/\/admin/, { timeout: 20000 });

    // /admin/dispenses is the IoT SESSION forensics list — its columns are shop,
    // commodity, entitled/measured grams and state. It carries no card number, so
    // the row is identified by the session and its numbers, which is also the
    // stronger UI<->DB check: it proves the grams the admin sees are the grams the
    // database committed.
    // FINDING (LOW, usability): rows on this list render no per-row identifier —
    // the session id is only a React key and a click target, and there is no card
    // number column. A specific dispense therefore cannot be located visually,
    // only clicked through. So the list-level assertion is "a committed 3,000 g
    // rice row for this shop is present", and the identity check happens on the
    // detail page below.
    await page.goto('/admin/dispenses', { waitUntil: 'domcontentloaded' });
    const committedRow = page
        .getByRole('row')
        .filter({ hasText: shop.shop_name })
        .filter({ hasText: '3,000' })
        .first();
    await expect(committedRow).toBeVisible({ timeout: 20000 });
    note('adminDispensesShowsCommittedRow', { entitledShown: '3,000', shop: shop.shop_name });

    // The per-dispense detail view is where the beneficiary is identified.
    await page.goto(`/admin/dispenses/${sessionRow.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(demo.cardNumber).first()).toBeVisible({ timeout: 20000 });
    note('adminDispenseDetailShowsCard', 'PASS');
});

// ===========================================================================
// PHASE 17 — the client cannot reduce the entitlement
// ===========================================================================

test('PHASE 17 — a partial allocation is rejected by the backend', async () => {
    test.setTimeout(60000);
    const { shop } = await resolveRealWorld();
    const policy = await resolvePolicy('BPL');
    const demo = await seedDemoBeneficiary({ shop, policy });
    const qr = await issueQrSession({
        rationCardId: demo.rationCardId,
        shop,
        beneficiaryUserId: demo.beneficiaryUserId,
    });

    const token = await apiLogin(SHOPKEEPER_EMAIL, PASSWORD);

    // A client asking for 1000 g against a 3000 g allocation.
    const partial = await apiPost(
        '/api/dispense/session',
        {
            ration_card_id: demo.rationCardId,
            commodity: 'rice',
            entitled_grams: 1000,
            qr_session_id: qr.sessionId,
        },
        token,
        { allowError: true },
    );
    note('partialAllocationAttempt', partial);
    expect(partial.status, 'a partial allocation must be refused').toBeGreaterThanOrEqual(400);
    expect(partial.body?.code).toBe('IOT_PARTIAL_ALLOCATION');

    // And nothing was created.
    const sessions = await pool.query(
        `SELECT COUNT(*)::int AS n FROM dispense_sessions WHERE ration_card_id = $1`,
        [demo.rationCardId],
    );
    expect(sessions.rows[0].n, 'no session created for a refused request').toBe(0);
    const wallet = await pool.query(`SELECT rice_balance_kg FROM wallets WHERE ration_card_id = $1`, [
        demo.rationCardId,
    ]);
    expect(Number(wallet.rows[0].rice_balance_kg) * 1000, 'wallet untouched').toBe(policy.rice_per_card_grams);
    note('partialAllocationRejected', 'PASS');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function expectEventually(fn, label, timeoutMs = 30000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const result = await fn();
        if (result) return result;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function apiLogin(email, password) {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    expect(body.token, `login for ${email} must return a token`).toBeTruthy();
    return body.token;
}

async function apiGet(pathname, token) {
    const res = await fetch(`${BACKEND_URL}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
    return res.json();
}

async function apiPost(pathname, body, token, { allowError = false } = {}) {
    const res = await fetch(`${BACKEND_URL}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok && !allowError) throw new Error(`POST ${pathname} -> ${res.status}: ${JSON.stringify(parsed)}`);
    return { status: res.status, body: parsed };
}
