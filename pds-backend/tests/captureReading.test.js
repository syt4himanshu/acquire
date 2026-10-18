const { evaluateCaptureReading } = require("../src/services/stabilityDetectorService");
const { CAPTURE_MAX_READING_AGE_MS, CAPTURE_MAX_CLOCK_SKEW_MS } = require("../src/config/iot");

// PROTOTYPE: pure checks for single-reading capture. Not a substitute for the
// multi-sample stability rule, which still gates the 'confirming' state.
const NOW = 1_700_000_000_000;
const reading = (grams, ageMs = 0) => ({ gramsInt: grams, takenAtMs: NOW - ageMs });

describe("evaluateCaptureReading", () => {
  it("accepts a fresh reading within tolerance and returns its grams", () => {
    expect(evaluateCaptureReading(reading(1006), NOW, 1000, 20)).toEqual({ ok: true, grams: 1006 });
  });

  it("accepts a reading exactly at the tolerance boundary", () => {
    expect(evaluateCaptureReading(reading(1020), NOW, 1000, 20)).toEqual({ ok: true, grams: 1020 });
    expect(evaluateCaptureReading(reading(980), NOW, 1000, 20)).toEqual({ ok: true, grams: 980 });
  });

  it("rejects a reading one gram outside tolerance", () => {
    expect(evaluateCaptureReading(reading(1021), NOW, 1000, 20)).toMatchObject({
      ok: false,
      code: "IOT_MEASUREMENT_OUT_OF_TOLERANCE",
    });
    expect(evaluateCaptureReading(reading(979), NOW, 1000, 20)).toMatchObject({
      ok: false,
      code: "IOT_MEASUREMENT_OUT_OF_TOLERANCE",
    });
  });

  it("rejects when there is no reading for the session", () => {
    expect(evaluateCaptureReading(null, NOW, 1000, 20)).toMatchObject({
      ok: false,
      code: "IOT_MEASUREMENT_MISSING",
    });
  });

  it("rejects a reading older than the freshness limit", () => {
    expect(
      evaluateCaptureReading(reading(1000, CAPTURE_MAX_READING_AGE_MS + 1), NOW, 1000, 20),
    ).toMatchObject({ ok: false, code: "IOT_MEASUREMENT_STALE" });
  });

  it("accepts a reading exactly at the freshness limit", () => {
    expect(
      evaluateCaptureReading(reading(1000, CAPTURE_MAX_READING_AGE_MS), NOW, 1000, 20),
    ).toEqual({ ok: true, grams: 1000 });
  });

  it("rejects a reading stamped further in the future than the clock-skew allowance", () => {
    expect(
      evaluateCaptureReading(reading(1000, -(CAPTURE_MAX_CLOCK_SKEW_MS + 1)), NOW, 1000, 20),
    ).toMatchObject({ ok: false, code: "IOT_MEASUREMENT_STALE" });
  });

  it("rejects zero grams even when the entitlement would otherwise accept it", () => {
    expect(evaluateCaptureReading(reading(0), NOW, 0, 20)).toMatchObject({
      ok: false,
      code: "IOT_MEASUREMENT_INVALID",
    });
  });

  it("rejects non-integer and out-of-range grams", () => {
    expect(evaluateCaptureReading({ gramsInt: 1000.5, takenAtMs: NOW }, NOW, 1000, 20)).toMatchObject({
      code: "IOT_MEASUREMENT_INVALID",
    });
    expect(evaluateCaptureReading(reading(5001), NOW, 5001, 20)).toMatchObject({
      code: "IOT_MEASUREMENT_INVALID",
    });
    expect(evaluateCaptureReading(reading(-5), NOW, 0, 20)).toMatchObject({
      code: "IOT_MEASUREMENT_INVALID",
    });
  });
});
