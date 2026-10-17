const {
  isStable,
  filterToWindow,
} = require("../src/services/stabilityDetectorService");
const { STABILITY_MIN_READINGS } = require("../src/config/iot");

const makeReadings = (grams, count, takenAtMs = 0) =>
  Array.from({ length: count }, () => ({ gramsInt: grams, takenAtMs }));

describe("stabilityDetectorService.isStable", () => {
  it("is false with fewer readings than the configured minimum", () => {
    const readings = makeReadings(5000, STABILITY_MIN_READINGS - 1);
    expect(isStable(readings, 5000, 50)).toBe(false);
  });

  it("is true at the configured minimum with tightly-clustered readings within tolerance", () => {
    const readings = makeReadings(5000, STABILITY_MIN_READINGS);
    expect(isStable(readings, 5000, 50)).toBe(true);
  });

  it("is false when the spread exceeds 5g even with enough readings", () => {
    const readings = Array.from({ length: 20 }, (_, i) => ({
      gramsInt: 5000 + (i % 2 === 0 ? 0 : 6), // spread of 6g
      takenAtMs: 0,
    }));
    expect(isStable(readings, 5000, 50)).toBe(false);
  });

  it("is false when the mean is outside tolerance of entitled_grams", () => {
    const readings = makeReadings(5200, 20); // 200g off
    expect(isStable(readings, 5000, 50)).toBe(false);
  });

  it("is true right at the tolerance boundary", () => {
    const readings = makeReadings(5050, 20);
    expect(isStable(readings, 5000, 50)).toBe(true);
  });

  it("rejects non-array input", () => {
    expect(isStable(null, 5000, 50)).toBe(false);
    expect(isStable(undefined, 5000, 50)).toBe(false);
  });
});

describe("stabilityDetectorService.filterToWindow", () => {
  it("keeps only readings within the window", () => {
    const readings = [
      { gramsInt: 100, takenAtMs: 0 },
      { gramsInt: 100, takenAtMs: 2000 },
      { gramsInt: 100, takenAtMs: 4000 },
    ];
    const result = filterToWindow(readings, 4000, 3000);
    expect(result).toEqual([
      { gramsInt: 100, takenAtMs: 2000 },
      { gramsInt: 100, takenAtMs: 4000 },
    ]);
  });

  it("returns an empty array when nothing is within the window", () => {
    const readings = [{ gramsInt: 100, takenAtMs: 0 }];
    expect(filterToWindow(readings, 10000, 3000)).toEqual([]);
  });
});
