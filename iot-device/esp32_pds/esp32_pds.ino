#include "HX711.h"

// ===============================
// ESP32 + HX711 CONNECTION
// ===============================
#define DT 5
#define SCK 18

HX711 scale;

// ===============================
// YOUR WORKING CALIBRATION
// ===============================
const float ZERO_RAW = -27536.5;
const float CALIBRATION_FACTOR = -397715.2;

// Maximum capacity of your load cell
const float MAX_WEIGHT_KG = 5.0;
const float MAX_WEIGHT_GRAMS = 5000.0;

// ===============================
// PDS DEVICE INFORMATION
// ===============================
const char* DEVICE_ID = "ESP32-AUDIT01";
const char* FIRMWARE_VERSION = "2.1.0-serial";

// ===============================
// TIMERS
// ===============================
unsigned long lastHeartbeat = 0;
unsigned long lastReading = 0;

const unsigned long HEARTBEAT_INTERVAL = 5000;
const unsigned long READING_INTERVAL = 1000;

// ===============================
// SEND HELLO
// ===============================
void sendHello() {

  Serial.print("{\"type\":\"hello\"");
  Serial.print(",\"deviceId\":\"");
  Serial.print(DEVICE_ID);
  Serial.print("\"");

  Serial.print(",\"firmware\":\"");
  Serial.print(FIRMWARE_VERSION);
  Serial.print("\"");

  Serial.print(",\"transport\":\"serial\"");
  Serial.print(",\"cellRatedGrams\":5000");
  Serial.print(",\"calibrated\":true");

  Serial.print(",\"calibrationFactor\":");
  Serial.print(CALIBRATION_FACTOR, 2);

  Serial.println("}");
}

// ===============================
// SEND HEARTBEAT
// ===============================
void sendHeartbeat() {

  Serial.print("{\"type\":\"heartbeat\"");
  Serial.print(",\"ts\":");
  Serial.print(millis());
  Serial.println("}");
}

// ===============================
// SEND ERROR
// ===============================
void sendError(const char* code, const char* detail) {

  Serial.print("{\"type\":\"error\"");
  Serial.print(",\"code\":\"");
  Serial.print(code);
  Serial.print("\"");

  Serial.print(",\"detail\":\"");
  Serial.print(detail);
  Serial.print("\"");

  Serial.println("}");
}

// ===============================
// SEND WEIGHT READING
// ===============================
void sendReading(float grams) {

  Serial.print("{\"type\":\"reading\"");
  Serial.print(",\"grams\":");
  Serial.print(grams, 1);

  Serial.print(",\"ts\":");
  Serial.print(millis());

  Serial.println("}");
}

// ===============================
// SETUP
// ===============================
void setup() {

  Serial.begin(115200);

  delay(1000);

  scale.begin(DT, SCK);

  delay(1000);

  // Send PDS device identification
  sendHello();
}

// ===============================
// MAIN LOOP
// ===============================
void loop() {

  // -------------------------------
  // Check HX711
  // -------------------------------
  if (!scale.is_ready()) {

    sendError(
      "HX711_NOT_READY",
      "HX711 is not responding"
    );

    delay(1000);

    return;
  }

  // -------------------------------
  // Read sensor
  // -------------------------------
  long rawValue = scale.read_average(10);

  // -------------------------------
  // Calculate weight
  // -------------------------------
  float weightKg =
      (rawValue - ZERO_RAW) / CALIBRATION_FACTOR;

  float weightGrams = weightKg * 1000.0;

  // -------------------------------
  // Remove small negative noise
  // -------------------------------
  if (weightGrams < 0 && weightGrams > -20) {

    weightGrams = 0;
    weightKg = 0;
  }

  // -------------------------------
  // Detect serious negative value
  // -------------------------------
  if (weightGrams < -500) {

    sendError(
      "SENSOR_FAULT",
      "Negative sensor reading - check load cell and tare"
    );

    delay(1000);

    return;
  }

  // -------------------------------
  // Remove remaining negative values
  // -------------------------------
  if (weightGrams < 0) {

    weightGrams = 0;
    weightKg = 0;
  }

  // -------------------------------
  // Maximum 5 KG
  // -------------------------------
  if (weightGrams > MAX_WEIGHT_GRAMS) {

    sendError(
      "OVERLOAD",
      "Weight exceeds 5 kg"
    );

    delay(1000);

    return;
  }

  // -------------------------------
  // Send JSON reading
  // -------------------------------
  if (millis() - lastReading >= READING_INTERVAL) {

    sendReading(weightGrams);

    lastReading = millis();
  }

  // -------------------------------
  // Heartbeat
  // -------------------------------
  if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL) {

    sendHeartbeat();

    lastHeartbeat = millis();
  }

  delay(100);
}