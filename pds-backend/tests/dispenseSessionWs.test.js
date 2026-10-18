require("./setup");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const request = require("supertest");
const app = require("../src/app");
const { attachWebSocketServers } = require("../src/ws/attachSockets");
const dispenseSessionService = require("../src/services/dispenseSessionService");
const { Pool } = require("pg");
require("dotenv").config();

jest.setTimeout(20000);

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
});
const JWT_SECRET = process.env.JWT_SECRET || "test_secret";

let server, port, shopId, areaId, shopkeeperToken, shopkeeperId;
let deviceId, deviceRawToken;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  checkFn,
  { timeoutMs = 8000, intervalMs = 100 } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await checkFn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error("waitFor: condition not met before timeout");
};

const connectDevice = (devId, token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/iot?deviceId=${devId}`,
      [token],
    );
    const timer = setTimeout(() => {
      reject(
        new Error(
          "connectDevice: timed out waiting for the WS handshake to complete",
        ),
      );
    }, 5000);
    const settle =
      (fn) =>
      (...args) => {
        clearTimeout(timer);
        fn(...args);
      };
    ws.on(
      "open",
      settle(() => resolve(ws)),
    );
    // A rejected upgrade (e.g. bad auth) gets a plain HTTP response, not
    // a 101 — the `ws` client surfaces that as 'unexpected-response', not
    // 'error', so both must be handled or a bad token hangs forever.
    ws.on(
      "unexpected-response",
      settle((req, res) => {
        reject(
          new Error(`connectDevice: unexpected response ${res.statusCode}`),
        );
      }),
    );
    ws.on("error", settle(reject));
  });

const connectShopkeeper = (token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws/shopkeeper/live", [
      token,
    ]);
    const timer = setTimeout(
      () => reject(new Error("connectShopkeeper: timed out")),
      5000,
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const sendReading = (ws, grams, ts = Date.now()) =>
  ws.send(JSON.stringify({ type: "reading", grams, ts, sessionId: null }));

const seedRationCardWithWallet = async ({ cardNumber, riceKg }) => {
  const rcRes = await pool.query(
    `INSERT INTO ration_cards (card_number, category, shop_id, area_id) VALUES ($1, 'BPL', $2, $3) RETURNING id`,
    [cardNumber, shopId, areaId],
  );
  await pool.query(
    `INSERT INTO wallets (ration_card_id, rice_balance_kg) VALUES ($1, $2)`,
    [rcRes.rows[0].id, riceKg],
  );
  return rcRes.rows[0].id;
};

const seedQrSession = async (rationCardId) => {
  const sessionId = crypto.randomBytes(16).toString("hex");
  await pool.query(
    `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [sessionId, rationCardId, shopId, new Date(Date.now() + 60000)],
  );
  return sessionId;
};

const createAndAttachSession = async ({ rationCardId, entitledGrams }) => {
  const qrSessionId = await seedQrSession(rationCardId);
  const createRes = await request(app)
    .post("/api/dispense/session")
    .set("Authorization", `Bearer ${shopkeeperToken}`)
    .send({
      ration_card_id: rationCardId,
      commodity: "rice",
      entitled_grams: entitledGrams,
      qr_session_id: qrSessionId,
    });
  expect(createRes.status).toBe(201);

  const attachRes = await request(app)
    .post(`/api/dispense/session/${createRes.body.session_id}/attach`)
    .set("Authorization", `Bearer ${shopkeeperToken}`)
    .send({ session_jwt: createRes.body.session_jwt });
  expect(attachRes.status).toBe(200);

  return createRes.body.session_id;
};

beforeAll(async () => {
  await pool.query(
    `INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES
      ('BPL', 3000, 2000)
    
     ON CONFLICT (category) DO UPDATE SET rice_per_card_grams = EXCLUDED.rice_per_card_grams`,
  );

  const areaRes = await pool.query(
    `INSERT INTO areas (name) VALUES ('DispenseWsArea') ON CONFLICT (name) DO UPDATE SET name='DispenseWsArea' RETURNING id`,
  );
  areaId = areaRes.rows[0].id;

  const hash = await bcrypt.hash("shoppass", 10);
  const skRes = await pool.query(
    `INSERT INTO users (role, email, mobile, password_hash) VALUES ('shopkeeper', 'ws-sk@test.com', '+919444444444', $1) RETURNING id`,
    [hash],
  );
  shopkeeperId = skRes.rows[0].id;
  shopkeeperToken = jwt.sign(
    { id: shopkeeperId, role: "shopkeeper" },
    JWT_SECRET,
    { expiresIn: "1h" },
  );

  const shopRes = await pool.query(
    `INSERT INTO shops (shop_code, shop_name, area_id, shopkeeper_id) VALUES ('WS-001', 'WS Test Shop', $1, $2) RETURNING id`,
    [areaId, shopkeeperId],
  );
  shopId = shopRes.rows[0].id;

  deviceId = "esp32-ws-test-01";
  deviceRawToken = "ws-test-raw-token";
  const tokenHash = await bcrypt.hash(deviceRawToken, 10);
  await pool.query(
    `INSERT INTO iot_devices (device_id, device_token_hash, shop_id) VALUES ($1, $2, $3)`,
    [deviceId, tokenHash, shopId],
  );

  server = http.createServer(app);
  attachWebSocketServers(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

afterAll(async () => {
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    sleep(3000), // don't let a lingering socket hang the whole suite
  ]);
  await pool.end();
});

describe("Phase 1 IoT measurement capture (readings -> stable -> explicit capture)", () => {
  it("relays HX711_NOT_READY to the active shopkeeper session without fabricating a reading", async () => {
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-HX711-FAULT",
      riceKg: 3,
    });
    const sessionId = await createAndAttachSession({
      rationCardId,
      entitledGrams: 3000,
    });
    const deviceWs = await connectDevice(deviceId, deviceRawToken);
    const shopkeeperWs = await connectShopkeeper(shopkeeperToken);
    const receivedEvents = [];
    shopkeeperWs.on("message", (raw) =>
      receivedEvents.push(JSON.parse(raw.toString())),
    );
    shopkeeperWs.send(JSON.stringify({ type: "subscribe", sessionId }));
    await sleep(50);

    deviceWs.send(
      JSON.stringify({
        type: "error",
        code: "HX711_NOT_READY",
        ts: Date.now(),
        detail: "HX711 is not responding",
      }),
    );

    await waitFor(() =>
      receivedEvents.find((event) => event.type === "device_error"),
    );
    expect(receivedEvents).toContainEqual({
      type: "device_error",
      code: "HX711_NOT_READY",
      detail: "HX711 is not responding",
    });
    const readings = await pool.query(
      "SELECT COUNT(*)::int AS count FROM sensor_readings WHERE session_id = $1",
      [sessionId],
    );
    expect(readings.rows[0].count).toBe(0);

    deviceWs.close();
    shopkeeperWs.close();
  });

  it("waits for explicit capture and records no dispense, wallet debit, or blockchain row", async () => {
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-HAPPY",
      riceKg: 3,
    });
    const sessionId = await createAndAttachSession({
      rationCardId,
      entitledGrams: 3000,
    });

    const ws = await connectDevice(deviceId, deviceRawToken);

    // >=15 readings within the 3s stability window, tightly clustered at
    // the entitled amount — satisfies the auto-confirm rule immediately.
    for (let i = 0; i < 20; i++) {
      sendReading(ws, 3000);
      await sleep(20);
    }

    const stableSession = await waitFor(async () => {
      const res = await pool.query(
        "SELECT state FROM dispense_sessions WHERE id = $1",
        [sessionId],
      );
      return res.rows[0].state === "confirming" ? res.rows[0] : null;
    });
    expect(stableSession.state).toBe("confirming");

    let recordRes = await pool.query(
      "SELECT * FROM dispense_records WHERE session_id = $1",
      [sessionId],
    );
    expect(recordRes.rows).toHaveLength(0);
    let walletRes = await pool.query(
      "SELECT rice_balance_kg FROM wallets WHERE ration_card_id = $1",
      [rationCardId],
    );
    expect(Number(walletRes.rows[0].rice_balance_kg)).toBe(3);

    const captureRes = await request(app)
      .post(`/api/dispense/session/${sessionId}/capture`)
      .set("Authorization", `Bearer ${shopkeeperToken}`);
    expect(captureRes.status).toBe(200);
    expect(captureRes.body).toMatchObject({
      state: "captured",
      commodity: "rice",
      entitled_grams: 3000,
      tolerance_grams: 30,
      measured_grams: 3000,
    });

    const capturedSession = await pool.query(
      "SELECT state FROM dispense_sessions WHERE id = $1",
      [sessionId],
    );
    expect(capturedSession.rows[0].state).toBe("captured");
    recordRes = await pool.query(
      "SELECT * FROM dispense_records WHERE session_id = $1",
      [sessionId],
    );
    expect(recordRes.rows).toHaveLength(0);
    walletRes = await pool.query(
      "SELECT rice_balance_kg FROM wallets WHERE ration_card_id = $1",
      [rationCardId],
    );
    expect(Number(walletRes.rows[0].rice_balance_kg)).toBe(3);

    ws.close();
  });

  it("rejects a duplicate capture after the first one closes the session", async () => {
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-CAPTURE-ONCE",
      riceKg: 3,
    });
    const sessionId = await createAndAttachSession({
      rationCardId,
      entitledGrams: 3000,
    });
    const ws = await connectDevice(deviceId, deviceRawToken);

    for (let i = 0; i < 20; i++) {
      sendReading(ws, 3000);
      await sleep(20);
    }

    await waitFor(async () => {
      const res = await pool.query(
        "SELECT state FROM dispense_sessions WHERE id = $1",
        [sessionId],
      );
      return res.rows[0].state === "confirming";
    });

    const firstCapture = await request(app)
      .post(`/api/dispense/session/${sessionId}/capture`)
      .set("Authorization", `Bearer ${shopkeeperToken}`);
    const duplicateCapture = await request(app)
      .post(`/api/dispense/session/${sessionId}/capture`)
      .set("Authorization", `Bearer ${shopkeeperToken}`);

    expect(firstCapture.status).toBe(200);
    expect(duplicateCapture.status).toBe(409);
    expect(duplicateCapture.body.code).toBe("IOT_MEASUREMENT_NOT_STABLE");
    const recordRes = await pool.query(
      "SELECT * FROM dispense_records WHERE session_id = $1",
      [sessionId],
    );
    expect(recordRes.rows).toHaveLength(0);

    ws.close();
  });
});

describe("IoT-gated dispense — device disconnect mid-session", () => {
  it("moves the session to device_lost with no partial commit", async () => {
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-LOST",
      riceKg: 3,
    });
    const sessionId = await createAndAttachSession({
      rationCardId,
      entitledGrams: 3000,
    });

    const ws = await connectDevice(deviceId, deviceRawToken);
    sendReading(ws, 100); // nowhere near stable/in-tolerance
    await sleep(200);
    ws.close();

    const lostSession = await waitFor(async () => {
      const res = await pool.query(
        "SELECT state FROM dispense_sessions WHERE id = $1",
        [sessionId],
      );
      return res.rows[0].state === "device_lost" ? res.rows[0] : null;
    });
    expect(lostSession.state).toBe("device_lost");

    const recordRes = await pool.query(
      "SELECT * FROM dispense_records WHERE session_id = $1",
      [sessionId],
    );
    expect(recordRes.rows.length).toBe(0);
  });
});

describe("IoT-gated dispense — insufficient-balance race", () => {
  it("commits exactly one of two concurrent commits against a shared wallet; the other fails cleanly", async () => {
    // 5kg available; two sessions each asking for 4kg — only one can win.
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-RACE",
      riceKg: 3,
    });

    const sessionAId = await createAndAttachSession({
      rationCardId,
      entitledGrams: 3000,
    });
    // A second session on the same wallet needs its own attach — but
    // attach requires the shop's *available* device, and a device can
    // only usefully gate one session's readings at a time in real
    // operation. The race being tested here is specifically the
    // wallet-debit concurrency guard inside commitSession, independent
    // of the device-attach mechanics, so session B is driven directly
    // through the state machine via SQL instead of a second real attach.
    const qrSessionIdB = await seedQrSession(rationCardId);
    const createBRes = await request(app)
      .post("/api/dispense/session")
      .set("Authorization", `Bearer ${shopkeeperToken}`)
      .send({
        ration_card_id: rationCardId,
        commodity: "rice",
        entitled_grams: 3000,
        qr_session_id: qrSessionIdB,
      });
    expect(createBRes.status).toBe(201);
    const sessionBId = createBRes.body.session_id;
    await pool.query(
      `UPDATE dispense_sessions SET state = 'weighing' WHERE id = $1`,
      [sessionBId],
    );

    // Bring session A into 'weighing' too (it's currently 'attached').
    await pool.query(
      `UPDATE dispense_sessions SET state = 'weighing' WHERE id = $1`,
      [sessionAId],
    );

    const [resultA, resultB] = await Promise.all([
      dispenseSessionService.commitSession(sessionAId, 3000),
      dispenseSessionService.commitSession(sessionBId, 3000),
    ]);

    const successes = [resultA, resultB].filter((r) => r.success);
    const failures = [resultA, resultB].filter((r) => !r.success);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0].reason).toBe("insufficient_balance");

    const failedSessionId = resultA.success ? sessionBId : sessionAId;
    const failedSessionRow = await pool.query(
      "SELECT state FROM dispense_sessions WHERE id = $1",
      [failedSessionId],
    );
    expect(failedSessionRow.rows[0].state).toBe("failed_insufficient_balance");

    const walletRes = await pool.query(
      "SELECT rice_balance_kg FROM wallets WHERE ration_card_id = $1",
      [rationCardId],
    );
    expect(Number(walletRes.rows[0].rice_balance_kg)).toBeCloseTo(0, 1); // 3kg - 3kg, only once
  });
});

describe("IoT-gated dispense — sanity-ceiling spikes", () => {
  it("drops out-of-range readings and flags needs_recalibration after 3 within 60s", async () => {
    const ws = await connectDevice(deviceId, deviceRawToken);

    for (let i = 0; i < 3; i++) {
      sendReading(ws, 15000); // >10000g ceiling
      await sleep(50);
    }

    const flagged = await waitFor(async () => {
      const res = await pool.query(
        "SELECT needs_recalibration FROM iot_devices WHERE device_id = $1",
        [deviceId],
      );
      return res.rows[0].needs_recalibration ? res.rows[0] : null;
    });
    expect(flagged.needs_recalibration).toBe(true);

    // None of the spikes were persisted as sensor_readings.
    const readingsRes = await pool.query(
      "SELECT COUNT(*)::int AS count FROM sensor_readings WHERE device_id = $1 AND grams_int = 15000",
      [deviceId],
    );
    expect(readingsRes.rows[0].count).toBe(0);

    ws.close();

    // Reset the flag so it doesn't leak into other tests/manual smoke checks.
    await pool.query(
      `UPDATE iot_devices SET needs_recalibration = false WHERE device_id = $1`,
      [deviceId],
    );
  });
});

describe("IoT weighing state synchronisation over the shopkeeper socket", () => {
  const listen = (ws) => {
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    return messages;
  };

  const subscribe = (ws, sessionId) =>
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));

  const reachConfirming = async (deviceWs, extraReadings = 0) => {
    for (let i = 0; i < 20 + extraReadings; i++) {
      sendReading(deviceWs, 3000);
      await sleep(20);
    }
  };

  it("a shopkeeper that subscribes after the readings have overwritten the event still receives confirming first", async () => {
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-LATE-SUB",
      riceKg: 3,
    });
    const sessionId = await createAndAttachSession({ rationCardId, entitledGrams: 3000 });
    const deviceWs = await connectDevice(deviceId, deviceRawToken);
    await reachConfirming(deviceWs);
    await waitFor(async () => {
      const res = await pool.query("SELECT state FROM dispense_sessions WHERE id = $1", [sessionId]);
      return res.rows[0].state === "confirming";
    });
    // Readings keep arriving after confirming, overwriting any "latest" slot.
    await reachConfirming(deviceWs, 30);

    const shopkeeperWs = await connectShopkeeper(shopkeeperToken);
    const messages = listen(shopkeeperWs);
    subscribe(shopkeeperWs, sessionId);
    await sleep(300);

    const states = messages.filter((m) => m.type === "state");
    expect(states[0]).toEqual({ type: "state", state: "confirming" });

    deviceWs.close();
    shopkeeperWs.close();
  });

  it("a shopkeeper that reconnects is brought back to confirming", async () => {
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-RECONNECT",
      riceKg: 3,
    });
    const sessionId = await createAndAttachSession({ rationCardId, entitledGrams: 3000 });
    const deviceWs = await connectDevice(deviceId, deviceRawToken);

    const first = await connectShopkeeper(shopkeeperToken);
    subscribe(first, sessionId);
    await sleep(50);
    first.close();

    await reachConfirming(deviceWs);
    await waitFor(async () => {
      const res = await pool.query("SELECT state FROM dispense_sessions WHERE id = $1", [sessionId]);
      return res.rows[0].state === "confirming";
    });

    const second = await connectShopkeeper(shopkeeperToken);
    const messages = listen(second);
    subscribe(second, sessionId);
    await sleep(300);
    expect(messages.find((m) => m.type === "state")).toEqual({ type: "state", state: "confirming" });

    deviceWs.close();
    second.close();
  });

  it("a live subscriber is told the measurement was captured, with the grams", async () => {
    const rationCardId = await seedRationCardWithWallet({
      cardNumber: "BPL-WS-CAPTURED-EVENT",
      riceKg: 3,
    });
    const sessionId = await createAndAttachSession({ rationCardId, entitledGrams: 3000 });
    const deviceWs = await connectDevice(deviceId, deviceRawToken);
    const shopkeeperWs = await connectShopkeeper(shopkeeperToken);
    const messages = listen(shopkeeperWs);
    subscribe(shopkeeperWs, sessionId);
    await sleep(50);

    await reachConfirming(deviceWs);
    await waitFor(async () => {
      const res = await pool.query("SELECT state FROM dispense_sessions WHERE id = $1", [sessionId]);
      return res.rows[0].state === "confirming";
    });

    const captureRes = await request(app)
      .post(`/api/dispense/session/${sessionId}/capture`)
      .set("Authorization", `Bearer ${shopkeeperToken}`);
    expect(captureRes.status).toBe(200);

    await waitFor(() => messages.find((m) => m.type === "state" && m.state === "captured"));
    expect(messages.find((m) => m.state === "captured")).toEqual({
      type: "state",
      state: "captured",
      measuredGrams: 3000,
    });

    deviceWs.close();
    shopkeeperWs.close();
  });
});

describe("IoT-gated dispense — complete rice-then-wheat flow over the sockets", () => {
  it("captures rice and wheat under one QR, sees each capture on the socket, and finalises exactly one transaction", async () => {
    await pool.query(
      `INSERT INTO policies (category, rice_per_card_grams, wheat_per_card_grams) VALUES ('BPL', 3000, 2000)
       ON CONFLICT (category) DO UPDATE SET rice_per_card_grams = 3000, wheat_per_card_grams = 2000`,
    );
    const rationCardId = await seedRationCardWithWallet({ cardNumber: "BPL-WS-FLOW", riceKg: 3 });
    await pool.query(`UPDATE wallets SET wheat_balance_kg = 2 WHERE ration_card_id = $1`, [rationCardId]);
    const beneficiary = await pool.query(
      `INSERT INTO users (role, name, mobile) VALUES ('beneficiary', 'Flow Head', '9000000777') RETURNING id`,
    );
    const qrSessionId = crypto.randomBytes(16).toString("hex");
    await pool.query(
      `INSERT INTO qr_sessions (session_id, ration_card_id, shop_id, issued_to_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [qrSessionId, rationCardId, shopId, beneficiary.rows[0].id, new Date(Date.now() + 60000)],
    );

    const deviceWs = await connectDevice(deviceId, deviceRawToken);
    const shopkeeperWs = await connectShopkeeper(shopkeeperToken);
    const messages = [];
    shopkeeperWs.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    const weigh = async (commodity, grams) => {
      const created = await request(app)
        .post("/api/dispense/session")
        .set("Authorization", `Bearer ${shopkeeperToken}`)
        .send({
          ration_card_id: rationCardId,
          commodity,
          entitled_grams: grams,
          qr_session_id: qrSessionId,
        });
      expect(created.status).toBe(201);
      const sessionId = created.body.session_id;

      const attached = await request(app)
        .post(`/api/dispense/session/${sessionId}/attach`)
        .set("Authorization", `Bearer ${shopkeeperToken}`)
        .send({ session_jwt: created.body.session_jwt });
      expect(attached.status).toBe(200);

      shopkeeperWs.send(JSON.stringify({ type: "subscribe", sessionId }));
      await sleep(50);
      for (let i = 0; i < 20; i++) {
        sendReading(deviceWs, grams);
        await sleep(20);
      }
      await waitFor(() => messages.some((m) => m.type === "state" && m.state === "confirming"));

      const captured = await request(app)
        .post(`/api/dispense/session/${sessionId}/capture`)
        .set("Authorization", `Bearer ${shopkeeperToken}`);
      expect(captured.status).toBe(200);
      expect(captured.body).toMatchObject({ state: "captured", measured_grams: grams });
      await waitFor(() => messages.some((m) => m.type === "state" && m.state === "captured"));
      return sessionId;
    };

    const riceId = await weigh("rice", 3000);
    // The socket saw the rice session through to captured before wheat began.
    expect(messages.filter((m) => m.type === "state").map((m) => m.state)).toEqual(
      expect.arrayContaining(["confirming", "captured"]),
    );
    const wheatId = await weigh("wheat", 2000);

    const finalized = await request(app)
      .post("/api/shopkeeper/dispense")
      .set("Authorization", `Bearer ${shopkeeperToken}`)
      .send({
        ration_card_id: rationCardId,
        session_id: qrSessionId,
        rice_session_id: riceId,
        wheat_session_id: wheatId,
      });
    expect(finalized.status).toBe(200);
    expect(finalized.body.dispensed).toEqual({ rice_qty_kg: 3, wheat_qty_kg: 2 });

    const wallet = await pool.query(
      `SELECT rice_balance_kg, wheat_balance_kg FROM wallets WHERE ration_card_id = $1`,
      [rationCardId],
    );
    expect(Number(wallet.rows[0].rice_balance_kg)).toBe(0);
    expect(Number(wallet.rows[0].wheat_balance_kg)).toBe(0);
    const txs = await pool.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE ration_card_id = $1`, [rationCardId]);
    expect(txs.rows[0].n).toBe(1);

    deviceWs.close();
    shopkeeperWs.close();
  });
});

describe("weighing -> confirming depends on the device sample cadence (end to end)", () => {
  const streamAt = async (intervalMs, samples, cardNumber) => {
    const rationCardId = await seedRationCardWithWallet({ cardNumber, riceKg: 3 });
    const sessionId = await createAndAttachSession({ rationCardId, entitledGrams: 3000 });
    const deviceWs = await connectDevice(deviceId, deviceRawToken);
    for (let i = 0; i < samples; i++) {
      sendReading(deviceWs, 3000);
      await sleep(intervalMs);
    }
    const res = await pool.query("SELECT state FROM dispense_sessions WHERE id = $1", [sessionId]);
    deviceWs.close();
    return res.rows[0].state;
  };

  it("a steady weight streamed at 1 s reaches confirming", async () => {
    const state = await streamAt(1000, 6, "BPL-WS-CADENCE-1S");
    expect(state).toBe("confirming");
  }, 30000);

  it("a steady weight streamed at the observed 1.7 s cadence stays in weighing", async () => {
    const state = await streamAt(1700, 6, "BPL-WS-CADENCE-1P7S");
    expect(state).toBe("weighing");
  }, 30000);
});
