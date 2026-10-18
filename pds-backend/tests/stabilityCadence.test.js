const { isStable, filterToWindow } = require("../src/services/stabilityDetectorService");
const { STABILITY_MIN_READINGS, STABILITY_WINDOW_MS } = require("../src/config/iot");

// The auto-confirm rule needs STABILITY_MIN_READINGS samples inside a window of
// STABILITY_WINDOW_MS. With evenly spaced samples that means the gap between
// samples must be at most window / (min - 1). Anything slower can never confirm,
// however steady the weight is.
const MAX_SAMPLE_GAP_MS = STABILITY_WINDOW_MS / (STABILITY_MIN_READINGS - 1);

// Feeds a perfectly steady weight at a fixed sample interval through the real
// windowing and stability functions, and reports whether it ever confirms.
const replay = ({ intervalMs, samples = 60, entitled = 3000, tolerance = 30 }) => {
  let window = [];
  let maxWindow = 0;
  let stableAt = null;
  for (let i = 0; i < samples; i++) {
    const nowMs = i * intervalMs;
    window = filterToWindow([...window, { gramsInt: entitled, takenAtMs: nowMs }], nowMs);
    maxWindow = Math.max(maxWindow, window.length);
    if (stableAt === null && isStable(window, entitled, tolerance)) stableAt = nowMs;
  }
  return { maxWindow, stableAt };
};

describe("stability rule vs. sample cadence (regression for weighing that never confirms)", () => {
  test("the rule's maximum tolerated sample gap is 1500 ms (3 samples inside 3 s)", () => {
    expect(MAX_SAMPLE_GAP_MS).toBe(1500);
  });

  test("a steady weight sampled every 1730 ms (the cadence observed on the live device) never confirms", () => {
    const result = replay({ intervalMs: 1730 });
    expect(result.maxWindow).toBeLessThan(STABILITY_MIN_READINGS);
    expect(result.stableAt).toBeNull();
  });

  test("the same steady weight at 1000 ms confirms within a few samples", () => {
    const result = replay({ intervalMs: 1000 });
    expect(result.stableAt).not.toBeNull();
    expect(result.stableAt).toBeLessThanOrEqual(2000);
  });

  test("at 100 ms (the documented 10 Hz target) confirms almost immediately", () => {
    const result = replay({ intervalMs: 100 });
    expect(result.stableAt).toBeLessThanOrEqual(300);
  });

  test("the rule itself is unchanged: a window of 2 samples is still not enough", () => {
    const two = [
      { gramsInt: 3000, takenAtMs: 0 },
      { gramsInt: 3000, takenAtMs: 1000 },
    ];
    expect(isStable(two, 3000, 30)).toBe(false);
  });
});
