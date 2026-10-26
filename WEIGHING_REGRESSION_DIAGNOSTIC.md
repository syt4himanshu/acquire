# Weighing Regression — Diagnostic Only

**Symptom:** ESP32/load-cell path previously returned working weights, but now the shopkeeper UI displays 0 g for any load.  
**Scope:** Diagnose first. Do not modify firmware, calibration constants, parser behavior, backend rules, or UI until the failing layer is proven.

## Repository findings

- Latest `main` commit at time of investigation: `a504f91` (2026-10-26, message `abcd`). It modifies `pds-backend/src/controllers/shopkeeperController.js` for wallet lookup and adds `shopkeeperBeneficiaryLookup.test.js`; this diff does not itself modify the sensor path.
- Earlier commit `4251225` has the same known hard-coded calibration values in `iot-device/esp32_pds/esp32_pds.ino` and a 1000 ms reading interval.
- Current `main` firmware still uses `ZERO_RAW = -27536.5`, `CALIBRATION_FACTOR = -397715.2`, HX711 pins DT=5 / SCK=18, and computes grams as `((rawValue - ZERO_RAW) / CALIBRATION_FACTOR) * 1000`. It floors all negative values to 0 after only reporting values below -500 g as a sensor fault. **This creates a plausible symptom: if the raw sensor count shifts in the negative direction or the sign/offset no longer matches the physical setup, positive loads can be converted to negative grams and then silently clamped to 0.** This is a hypothesis, not yet proven.
- The current `iot-device/README_USB_SERIAL.md` documents a newer modular firmware/calibration implementation (`scale.cpp`, persisted NVS calibration, `t` and `c` commands, 10 Hz sampling), but the checked-in `iot-device/esp32_pds/esp32_pds.ino` is still the older hard-coded-calibration sketch. That mismatch makes it important to establish which sketch is actually flashed on the board.
- Bridge pipeline is `iot-bridge/src/serialSource.js` → `serialParser.js` → `bridge.js` → `backendClient.js` → backend WebSocket. The parser accepts JSON `{"type":"reading","grams":N}`; error and heartbeat frames are not measurements. The bridge tracks `lastGrams` and forwards parsed numeric readings.
- Firmware's hello frame hard-codes `"calibrated":true`, so that field alone is not proof the current calibration is valid.

## First checks — perform in order

1. Stop `iot-bridge` so it releases the serial port. Close any other serial monitor/app, then open the board's serial output at **115200 baud**.
2. With no load on the platform, record the raw HX711 value and the JSON `grams` reading. Add a known 500 g or 1 kg reference and record both again.
3. Check the sign and magnitude of the raw count change. In the current sketch, if adding weight makes `weightGrams` negative, it is later forced to zero; if it stays nearly unchanged, inspect wiring, HX711 readiness, and the actual flashed sketch before changing constants.
4. If Serial Monitor itself shows a non-zero, plausible `grams` value under a known load, stop it and run the bridge. Check bridge startup logs and its local health endpoint for serial port status, `lastGrams`, `linesSeen`, `linesUnparsed`, and backend connection status.
5. Compare the same reading at each boundary: firmware serial JSON → bridge's latest reading / forwarded counter → backend device stream/state → shopkeeper UI. The first boundary where a non-zero reading becomes 0 or stops updating identifies the layer to investigate.
6. Inspect git history/diffs for both the firmware and UI/IOT state path. Avoid reverting unrelated shopkeeper-wallet changes or touching entitlement/dispense logic during diagnosis.

## Evidence required before fixing

Capture:
- The exact firmware/sketch path that was last uploaded and current firmware hello frame.
- Serial output with empty platform and a known weight, including any `error` frames.
- Bridge health snapshot plus last 30–50 log lines (redact device tokens/secrets).
- The UI value and the corresponding backend/bridge reading at the same timestamp.
- `git diff` / recent commits touching `iot-device`, `iot-bridge`, backend IoT state, and shopkeeper weight UI.

## Guardrails

- Do not change calibration constants by guesswork.
- Do not accept raw ADC values as grams.
- Do not turn a missing reading/error into a valid 0 g dispense.
- Do not change transaction, wallet, entitlement, tolerance, or blockchain behavior as part of this investigation.
- Make no code fix until the failing boundary and root cause are documented.
