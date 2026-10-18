const { deviceErrorFrameSchema } = require("../src/validators/iotFrames");

// The firmware reports these codes (iot-device/esp32_pds/esp32_pds.ino). A code
// the schema does not know is dropped before it reaches the shopkeeper UI, so
// every code the firmware can send must validate here.
describe("deviceErrorFrameSchema", () => {
  it.each(["OVERLOAD", "SENSOR_FAULT", "NOT_CALIBRATED", "HX711_NOT_READY"])(
    "accepts the %s hardware fault code",
    (code) => {
      const { error, value } = deviceErrorFrameSchema.validate({
        type: "error",
        code,
        detail: "HX711 is not responding",
      });
      expect(error).toBeUndefined();
      expect(value.code).toBe(code);
    },
  );

  it("rejects an unknown fault code", () => {
    const { error } = deviceErrorFrameSchema.validate({ type: "error", code: "MADE_UP" });
    expect(error).toBeDefined();
  });

  it("carries no grams field, so a fault can never be read as a measurement", () => {
    const { error } = deviceErrorFrameSchema.validate({
      type: "error",
      code: "HX711_NOT_READY",
      grams: 1000,
    });
    expect(error).toBeDefined();
  });
});
