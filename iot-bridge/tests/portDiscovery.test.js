const test = require("node:test");
const assert = require("node:assert/strict");
const { describePorts, likelyEsp32Ports, resolvePort, normalisePortPath } = require("../src/portDiscovery");

// Port lists are passed in as fixtures, so every discovery decision is verified
// without a board attached — including the ones that are hard to stage by hand
// (two boards at once, a pinned port that vanished).

const CP210X = { path: "COM5", vendorId: "10C4", productId: "EA60", manufacturer: "Silicon Labs" };
const CH340 = { path: "COM7", vendorId: "1A86", productId: "7523", manufacturer: "wch.cn" };
const BLUETOOTH = { path: "COM3", vendorId: undefined, friendlyName: "Standard Serial over Bluetooth link" };

test("describePorts", async (t) => {
    await t.test("recognises a CP210x as a likely ESP32 and names the chip", () => {
        const [port] = describePorts([CP210X]);
        assert.equal(port.path, "COM5");
        assert.equal(port.isLikelyEsp32, true);
        assert.match(port.chip, /CP210x/);
    });

    await t.test("normalises the vendor ID case so matching is not case-dependent", () => {
        assert.equal(describePorts([{ path: "COM9", vendorId: "0X10c4" }])[0].vendorId, "10c4");
    });

    await t.test("keeps a non-ESP32 port in the list rather than hiding it", () => {
        // "my board isn't listed" and "my board is listed but not recognised"
        // have different fixes, so the operator has to see both.
        const described = describePorts([BLUETOOTH]);
        assert.equal(described.length, 1);
        assert.equal(described[0].isLikelyEsp32, false);
    });

    await t.test("handles an empty list", () => {
        assert.deepEqual(describePorts([]), []);
        assert.deepEqual(describePorts(undefined), []);
    });
});

test("likelyEsp32Ports filters to candidates only", () => {
    const candidates = likelyEsp32Ports([BLUETOOTH, CP210X, CH340]);
    assert.deepEqual(candidates.map((p) => p.path), ["COM5", "COM7"]);
});

test("resolvePort — auto-detection", async (t) => {
    await t.test("picks the single ESP32-class port", () => {
        const result = resolvePort({ configuredPath: null, ports: [BLUETOOTH, CP210X] });
        assert.equal(result.ok, true);
        assert.equal(result.path, "COM5");
        assert.match(result.reason, /auto-detected/);
    });

    await t.test("refuses to guess between two candidates", () => {
        // Picking the first would be a coin flip, and the wrong board is a
        // scale that silently never reports a weight during a live dispense.
        const result = resolvePort({ configuredPath: null, ports: [CP210X, CH340] });
        assert.equal(result.ok, false);
        assert.equal(result.code, "AMBIGUOUS");
        assert.match(result.message, /COM5/);
        assert.match(result.message, /COM7/);
        assert.match(result.message, /IOT_SERIAL_PORT/);
    });

    await t.test("reports NOT_FOUND, listing what IS present, when no candidate matches", () => {
        const result = resolvePort({ configuredPath: null, ports: [BLUETOOTH] });
        assert.equal(result.ok, false);
        assert.equal(result.code, "NOT_FOUND");
        assert.match(result.message, /COM3/);
    });

    await t.test("reports NOT_FOUND with driver guidance when there are no ports at all", () => {
        const result = resolvePort({ configuredPath: null, ports: [] });
        assert.equal(result.ok, false);
        assert.equal(result.code, "NOT_FOUND");
        assert.match(result.message, /No serial ports found/);
        assert.match(result.message, /CP210x/);
    });
});

test("resolvePort — pinned IOT_SERIAL_PORT", async (t) => {
    await t.test("uses the pinned port when present", () => {
        const result = resolvePort({ configuredPath: "COM7", ports: [CP210X, CH340] });
        assert.equal(result.ok, true);
        assert.equal(result.path, "COM7");
        assert.match(result.reason, /IOT_SERIAL_PORT/);
    });

    await t.test("matches case-insensitively (Windows accepts com7, list() reports COM7)", () => {
        assert.equal(resolvePort({ configuredPath: "com7", ports: [CH340] }).path, "COM7");
    });

    await t.test("trims surrounding whitespace from the configured value", () => {
        assert.equal(resolvePort({ configuredPath: " COM7 ", ports: [CH340] }).path, "COM7");
    });

    await t.test("does NOT silently fall back to another port when the pinned one is absent", () => {
        // Opening a different board than the operator named could stream the
        // wrong scale's weights into a live dispense, so this must fail.
        const result = resolvePort({ configuredPath: "COM9", ports: [CP210X] });
        assert.equal(result.ok, false);
        assert.equal(result.code, "CONFIGURED_PORT_ABSENT");
        assert.match(result.message, /COM9/);
        assert.match(result.message, /COM5/); // tells them what IS available
    });

    await t.test("honours a pinned port even if its chip is not a known ESP32 vendor", () => {
        // An explicit instruction from the operator outranks heuristics.
        const result = resolvePort({ configuredPath: "COM3", ports: [BLUETOOTH] });
        assert.equal(result.ok, true);
        assert.equal(result.path, "COM3");
    });

    await t.test("matches /dev/cu.xxx to /dev/tty.xxx on macOS", () => {
        // macOS creates both cu and tty devices for each USB serial port.
        // Operator configures cu (recommended), but SerialPort.list() returns tty.
        const macOsPort = { path: "/dev/tty.usbserial-10", vendorId: "1A86", productId: "7523" };
        const result = resolvePort({ configuredPath: "/dev/cu.usbserial-10", ports: [macOsPort] });
        assert.equal(result.ok, true);
        assert.equal(result.path, "/dev/tty.usbserial-10");
        assert.match(result.reason, /IOT_SERIAL_PORT/);
    });

    await t.test("matches /dev/tty.xxx to /dev/cu.xxx on macOS", () => {
        // Works both ways: if operator configured tty, match it to cu
        const macOsPort = { path: "/dev/cu.usbserial-10", vendorId: "1A86", productId: "7523" };
        const result = resolvePort({ configuredPath: "/dev/tty.usbserial-10", ports: [macOsPort] });
        assert.equal(result.ok, true);
        assert.equal(result.path, "/dev/cu.usbserial-10");
    });
});

test("normalisePortPath — macOS cu/tty normalisation", async (t) => {
    await t.test("normalises /dev/cu.xxx to /dev/tty.xxx", () => {
        assert.equal(normalisePortPath("/dev/cu.usbserial-10"), "/dev/tty.usbserial-10");
        assert.equal(normalisePortPath("/dev/CU.USBSERIAL-10"), "/dev/tty.usbserial-10");
    });

    await t.test("passes through /dev/tty.xxx unchanged (except lowercasing)", () => {
        assert.equal(normalisePortPath("/dev/tty.usbserial-10"), "/dev/tty.usbserial-10");
        assert.equal(normalisePortPath("/dev/TTY.USBSERIAL-10"), "/dev/tty.usbserial-10");
    });

    await t.test("trims whitespace", () => {
        assert.equal(normalisePortPath("  /dev/cu.usbserial-10  "), "/dev/tty.usbserial-10");
    });

    await t.test("passes through Windows COM ports unchanged (except lowercasing)", () => {
        assert.equal(normalisePortPath("COM5"), "com5");
        assert.equal(normalisePortPath(" COM7 "), "com7");
    });

    await t.test("passes through Linux /dev/ttyUSB* unchanged (except lowercasing)", () => {
        assert.equal(normalisePortPath("/dev/ttyUSB0"), "/dev/ttyusb0");
        assert.equal(normalisePortPath("/dev/ttyACM0"), "/dev/ttyacm0");
    });

    await t.test("handles empty/null/undefined", () => {
        assert.equal(normalisePortPath(""), "");
        assert.equal(normalisePortPath(null), "");
        assert.equal(normalisePortPath(undefined), "");
    });
});
