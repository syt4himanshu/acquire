/**
 * portDiscovery.js
 *
 * Finds the COM port the ESP32 is on, without hardcoding COM3.
 *
 * WHY AUTO-DETECTION MATTERS HERE
 * Windows allocates COM numbers from its own USB enumeration order. Move the
 * board to a different socket, plug in a phone, reboot with a hub attached, and
 * the same board becomes COM5, then COM11. A pinned port number describes the
 * cable, not the hardware, so the bridge treats it as a hint (IOT_SERIAL_PORT)
 * and identity as something only the board can tell it (the `hello` frame's
 * MAC-derived UID).
 *
 * HOW A BOARD IS RECOGNISED
 * Almost every ESP32 devkit reaches the PC through one of a handful of USB-UART
 * bridge chips, each with a fixed USB vendor ID. Matching on vendor ID is
 * reliable and needs no drivers or probing; matching on the friendly name
 * ("Silicon Labs CP210x...") is not, because it is localised and varies by
 * driver version.
 *
 * The pure functions here take a port list as an argument rather than fetching
 * it, so every discovery decision is testable without a serial port attached.
 */

// USB vendor IDs, as SerialPort.list() reports them (hex, no 0x prefix, case
// varies by platform — compared lowercased).
const KNOWN_USB_SERIAL_VENDORS = {
    "10c4": "Silicon Labs CP210x (common on ESP32 DevKitC / NodeMCU-32S)",
    "1a86": "QinHeng CH340 / CH9102 (common on ESP32 clones)",
    "0403": "FTDI FT232 (common on ESP32 DevKit v1)",
    "303a": "Espressif native USB (ESP32-S2 / S3 / C3)",
    "067b": "Prolific PL2303",
};

const normaliseVendorId = (vendorId) => (vendorId ? String(vendorId).toLowerCase().replace(/^0x/, "") : null);

/**
 * Annotates each port with whether it looks like an ESP32-class board and why.
 * Never filters anything out — the operator needs to see the ports that were
 * rejected as much as the one that was chosen, because "my board isn't listed"
 * and "my board was listed but not recognised" have different fixes.
 */
const describePorts = (ports) =>
    (ports || []).map((port) => {
        const vendorId = normaliseVendorId(port.vendorId);
        const vendorLabel = vendorId ? KNOWN_USB_SERIAL_VENDORS[vendorId] : null;
        return {
            path: port.path,
            vendorId: vendorId || null,
            productId: normaliseVendorId(port.productId),
            manufacturer: port.manufacturer || null,
            serialNumber: port.serialNumber || null,
            friendlyName: port.friendlyName || port.pnpId || null,
            isLikelyEsp32: Boolean(vendorLabel),
            chip: vendorLabel || null,
        };
    });

const likelyEsp32Ports = (ports) => describePorts(ports).filter((port) => port.isLikelyEsp32);

/**
 * Normalises a serial port path for matching.
 * 
 * On macOS, each USB serial device appears as BOTH /dev/cu.xxx and /dev/tty.xxx:
 *   - /dev/cu.xxx — callout device (non-blocking, preferred for dialout)
 *   - /dev/tty.xxx — terminal device (blocking I/O)
 * 
 * The operator typically configures /dev/cu.xxx (the recommended device), but
 * SerialPort.list() returns /dev/tty.xxx. This normalises both to the same
 * canonical form so they match.
 * 
 * Windows COM ports and Linux /dev/ttyUSB* are passed through unchanged.
 */
const normalisePortPath = (path) => {
    if (!path) return "";
    const lower = String(path).trim().toLowerCase();
    // Replace /dev/cu. with /dev/tty. so cu and tty variants match
    return lower.replace(/^\/dev\/cu\./, "/dev/tty.");
};

/**
 * Decides which port to open.
 *
 * @param {object} params
 * @param {string|null} params.configuredPath IOT_SERIAL_PORT, if the operator pinned one.
 * @param {Array} params.ports Raw output of SerialPort.list().
 * @returns {{ok: true, path: string, reason: string, port: object|null} | {ok: false, code: string, message: string, candidates: Array}}
 *
 * Returns a result rather than throwing: "no board attached" is the single most
 * common state this process starts in (the operator plugs it in a moment later),
 * and it has to be a retry, not a crash.
 */
const resolvePort = ({ configuredPath, ports }) => {
    const described = describePorts(ports);

    if (configuredPath) {
        // Normalised matching handles:
        //   - Case differences (Windows accepts "com5" but list() reports "COM5")
        //   - macOS cu/tty duality (/dev/cu.xxx in .env matches /dev/tty.xxx from list())
        const wanted = normalisePortPath(configuredPath);
        const match = described.find((port) => normalisePortPath(port.path) === wanted);

        if (match) {
            return {
                ok: true,
                path: match.path,
                port: match,
                reason: `IOT_SERIAL_PORT=${configuredPath}`,
            };
        }

        // A pinned port that is not present is NOT silently replaced by a guess.
        // Opening a different board than the one the operator named would, at
        // best, stream the wrong scale's weights into a live dispense.
        return {
            ok: false,
            code: "CONFIGURED_PORT_ABSENT",
            message:
                `IOT_SERIAL_PORT is set to ${configuredPath}, but that port is not present. ` +
                (described.length
                    ? `Available: ${described.map((p) => p.path).join(", ")}. `
                    : "No serial ports are present at all. ") +
                "Check the USB cable, or unset IOT_SERIAL_PORT to auto-detect.",
            candidates: described,
        };
    }

    const candidates = described.filter((port) => port.isLikelyEsp32);

    if (candidates.length === 1) {
        return {
            ok: true,
            path: candidates[0].path,
            port: candidates[0],
            reason: `auto-detected ${candidates[0].chip}`,
        };
    }

    if (candidates.length > 1) {
        // Refusing to guess: with two USB-UART boards attached, picking the
        // first would be a coin flip, and the wrong one produces a scale that
        // silently never reports a weight.
        return {
            ok: false,
            code: "AMBIGUOUS",
            message:
                `Found ${candidates.length} USB-serial devices that could be an ESP32 ` +
                `(${candidates.map((p) => `${p.path} - ${p.chip}`).join("; ")}). ` +
                "Set IOT_SERIAL_PORT in iot-bridge/.env to the right one, or run `npm run iot:devices`.",
            candidates: described,
        };
    }

    return {
        ok: false,
        code: "NOT_FOUND",
        message: described.length
            ? "No recognised ESP32/USB-serial device found. Present ports: " +
            described.map((p) => `${p.path}${p.friendlyName ? ` (${p.friendlyName})` : ""}`).join(", ") +
            ". If one of those IS the board, set IOT_SERIAL_PORT to it in iot-bridge/.env."
            : "No serial ports found. Plug the ESP32 in over USB, and make sure its " +
            "USB-UART driver (CP210x / CH340 / FTDI) is installed.",
        candidates: described,
    };
};

/**
 * Live port list. Kept as the only impure function in this file, and it
 * requires `serialport` lazily so the pure logic above (and its tests) never
 * pull in a native module.
 */
const listSystemPorts = async () => {
    const { SerialPort } = require("serialport");
    return SerialPort.list();
};

module.exports = {
    KNOWN_USB_SERIAL_VENDORS,
    describePorts,
    likelyEsp32Ports,
    resolvePort,
    listSystemPorts,
    normalisePortPath,
};
