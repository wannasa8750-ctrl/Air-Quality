/**
 * Smart Room IAQ Control System - ESP32 Firmware
 * ================================================
 * Hardware:
 *   - DHT22  → Pin 4   (Temperature & Humidity)
 *   - MQ135  → Pin 34  (CO2 / Air Quality, ADC)
 *   - PIR    → Pin 14  (Motion Sensor)
 *   - Buzzer → Pin 27
 *   - LED Red    → Pin 25
 *   - LED Yellow → Pin 26
 *   - LED Green  → Pin 33
 *   - Fan Relay  → Pin 32
 *   - AC Relay   → Pin 13
 *
 * Libraries Required (PlatformIO / Arduino):
 *   - Firebase ESP32 Client  (mobizt/Firebase-ESP-Client)
 *   - DHT sensor library     (adafruit/DHT sensor library)
 *   - ArduinoJson            (bblanchon/ArduinoJson)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <FirebaseESP32.h>
#include <DHT.h>
#include <ArduinoJson.h>

// ─── WiFi Credentials ─────────────────────────────────────────────────────────
#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// ─── Firebase Config ───────────────────────────────────────────────────────────
#define FIREBASE_HOST "your-project-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "YOUR_DATABASE_SECRET_OR_API_KEY"

// ─── Firebase Paths ────────────────────────────────────────────────────────────
#define PATH_SENSORS  "/sensors/room1"
#define PATH_COMMAND  "/command/room1"

// ─── Pin Definitions ───────────────────────────────────────────────────────────
#define DHT_PIN        4
#define DHT_TYPE       DHT22
#define MQ135_PIN      34    // ADC1 channel (0–4095 raw)
#define PIR_PIN        14
#define BUZZER_PIN     27
#define LED_RED_PIN    25
#define LED_YELLOW_PIN 26
#define LED_GREEN_PIN  33
#define FAN_PIN        32
#define AC_PIN         13

// ─── Thresholds ────────────────────────────────────────────────────────────────
#define CO2_CRITICAL_PPM    800          // MQ135 ADC value mapped ≈ 800 ppm
#define PIR_VACANT_MS       (15UL * 60 * 1000)  // 15 minutes
#define LOOP_INTERVAL_MS    5000         // Send data every 5 seconds
#define RETRAIN_INTERVAL_MS (60UL * 1000)// Re-read command every 60s (safety)

// ─── MQ135 Calibration (adjust for your sensor) ───────────────────────────────
// Raw ADC range 0–4095. Map to ppm using datasheet curve.
// Simple linear approximation: ppm = (raw / 4095.0) * 5000
#define MQ135_MAX_PPM  5000.0f

// ─── Global Objects ────────────────────────────────────────────────────────────
DHT           dht(DHT_PIN, DHT_TYPE);
FirebaseData  fbdo;
FirebaseAuth  fbAuth;
FirebaseConfig fbConfig;

// ─── State Variables ───────────────────────────────────────────────────────────
unsigned long lastMotionTime    = 0;
unsigned long lastLoopTime      = 0;
bool          roomOccupied      = false;
String        aiCommand         = "NORMAL_GREEN";  // Default safe state

// ─── Structs ───────────────────────────────────────────────────────────────────
struct SensorData {
  float temperature;   // °C
  float humidity;      // %RH
  float co2Ppm;        // ppm (converted from ADC)
  int   co2Raw;        // Raw ADC 0–4095
  bool  pirDetected;
  bool  valid;
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

void setTrafficLight(bool red, bool yellow, bool green) {
  digitalWrite(LED_RED_PIN,    red    ? HIGH : LOW);
  digitalWrite(LED_YELLOW_PIN, yellow ? HIGH : LOW);
  digitalWrite(LED_GREEN_PIN,  green  ? HIGH : LOW);
}

void setBuzzer(bool on) {
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
}

void setFan(bool on) {
  digitalWrite(FAN_PIN, on ? HIGH : LOW);
}

void setAC(bool on) {
  digitalWrite(AC_PIN, on ? HIGH : LOW);
}

float mapCO2(int rawAdc) {
  // Linear mapping: 0 → 400 ppm (ambient), 4095 → 5000 ppm
  // Replace with your sensor-specific calibration curve
  float ppm = 400.0f + ((float)rawAdc / 4095.0f) * (MQ135_MAX_PPM - 400.0f);
  return ppm;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 1 – Data Acquisition
// Read DHT22, MQ135, PIR
// ──────────────────────────────────────────────────────────────────────────────
SensorData readSensors() {
  SensorData data;
  data.temperature = dht.readTemperature();
  data.humidity    = dht.readHumidity();
  data.co2Raw      = analogRead(MQ135_PIN);
  data.co2Ppm      = mapCO2(data.co2Raw);
  data.pirDetected = digitalRead(PIR_PIN) == HIGH;
  data.valid       = !isnan(data.temperature) && !isnan(data.humidity);

  if (!data.valid) {
    Serial.println("[DHT22] Read failed – using previous values");
    data.temperature = 25.0f;
    data.humidity    = 50.0f;
  }

  Serial.printf("[Sensors] Temp=%.1f°C  Hum=%.1f%%  CO2=%.0fppm(raw:%d)  PIR=%s\n",
    data.temperature, data.humidity, data.co2Ppm, data.co2Raw,
    data.pirDetected ? "YES" : "NO");

  return data;
}

// ──────────────────────────────────────────────────────────────────────────────
// AC Control (Rule-Based)
// PIR vacant > 15 min → Energy Saving (OFF)
// PIR occupied        → Comfort Mode (adjust setpoint based on DHT22)
// ──────────────────────────────────────────────────────────────────────────────
void controlAC(const SensorData& data) {
  if (data.pirDetected) {
    lastMotionTime = millis();
    roomOccupied   = true;
  }

  unsigned long vacantMs = millis() - lastMotionTime;

  if (roomOccupied && vacantMs >= PIR_VACANT_MS) {
    // ── Energy Saving Mode ──
    roomOccupied = false;
    setAC(false);
    Serial.println("[AC] Energy Saving Mode → OFF");

  } else if (roomOccupied) {
    // ── Comfort Mode ──
    setAC(true);
    // Optionally send target temp to AC via IR / PWM (expand here)
    float targetTemp = 25.0f; // Default comfort setpoint
    Serial.printf("[AC] Comfort Mode → ON  (Current: %.1f°C, Target: %.1f°C)\n",
      data.temperature, targetTemp);

  } else {
    // Room never occupied since boot or long-vacant
    setAC(false);
    Serial.println("[AC] Standby (not occupied)");
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 2A – Read AI Command from Firebase
// Returns "WARNING_YELLOW" | "NORMAL_GREEN"
// ──────────────────────────────────────────────────────────────────────────────
void fetchAICommand() {
  if (Firebase.getString(fbdo, PATH_COMMAND)) {
    aiCommand = fbdo.stringData();
    Serial.printf("[Firebase] AI Command = %s\n", aiCommand.c_str());
  } else {
    Serial.printf("[Firebase] Failed to read command: %s\n", fbdo.errorReason().c_str());
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// IAQ Control & Traffic Light
// MQ135 CO2 > 800 ppm → Critical Alert (Reactive)
// Else               → Check AI Command (Proactive / Normal)
// ──────────────────────────────────────────────────────────────────────────────
void controlIAQ(const SensorData& data) {

  if (data.co2Ppm > CO2_CRITICAL_PPM) {
    // ── CRITICAL ALERT (Reactive) ──────────────────────────────────────
    setTrafficLight(true, false, false);   // Red ON
    setFan(true);
    setBuzzer(true);
    Serial.println("[IAQ] *** CRITICAL ALERT *** CO2 > 800 ppm!");

  } else {
    // ── Below critical – check AI command ──────────────────────────────
    setBuzzer(false);
    fetchAICommand();

    if (aiCommand == "WARNING_YELLOW") {
      // Proactive Warning (ML anomaly detected)
      setTrafficLight(false, true, false);  // Yellow ON
      setFan(true);
      Serial.println("[IAQ] Proactive Warning (ML) → Fan ON, Yellow LED");

    } else {
      // Normal State
      setTrafficLight(false, false, true);  // Green ON
      setFan(false);
      Serial.println("[IAQ] Normal State → Fan OFF, Green LED");
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 2B – Sync with Firebase Realtime Database
// Push to /sensors/room1
// ──────────────────────────────────────────────────────────────────────────────
void syncFirebase(const SensorData& data) {
  FirebaseJson json;
  json.set("temperature",  data.temperature);
  json.set("humidity",     data.humidity);
  json.set("co2_ppm",      data.co2Ppm);
  json.set("co2_raw",      data.co2Raw);
  json.set("pir",          data.pirDetected);
  json.set("room_occupied",roomOccupied);
  json.set("ai_command",   aiCommand);
  json.set("timestamp",    (int)(millis() / 1000));

  if (Firebase.setJSON(fbdo, PATH_SENSORS, json)) {
    Serial.println("[Firebase] Data pushed to /sensors/room1");
  } else {
    Serial.printf("[Firebase] Push failed: %s\n", fbdo.errorReason().c_str());
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Smart Room IAQ System Booting ===");

  // Pin modes
  pinMode(PIR_PIN,        INPUT);
  pinMode(MQ135_PIN,      INPUT);
  pinMode(BUZZER_PIN,     OUTPUT);
  pinMode(LED_RED_PIN,    OUTPUT);
  pinMode(LED_YELLOW_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN,  OUTPUT);
  pinMode(FAN_PIN,        OUTPUT);
  pinMode(AC_PIN,         OUTPUT);

  // Startup: all off
  setTrafficLight(false, false, false);
  setFan(false);
  setAC(false);
  setBuzzer(false);

  // DHT22
  dht.begin();
  delay(2000); // DHT22 warm-up

  // WiFi
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] FAILED – running offline");
  }

  // Firebase
  fbConfig.host                        = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token  = FIREBASE_AUTH;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);
  fbdo.setResponseSize(4096);
  Serial.println("[Firebase] Initialized");

  // MQ135 warm-up (ideally 24h, short warm-up for demo)
  Serial.println("[MQ135] Warming up 30s...");
  delay(30000);

  lastMotionTime = millis();
  Serial.println("=== System Ready ===\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Loop
// ──────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  if (now - lastLoopTime < LOOP_INTERVAL_MS) {
    return;
  }
  lastLoopTime = now;

  // Step 1: Data Acquisition
  SensorData data = readSensors();

  // AC Control (Rule-Based)
  controlAC(data);

  // IAQ Control & Traffic Light
  controlIAQ(data);

  // Step 2: Firebase Sync
  if (WiFi.status() == WL_CONNECTED && Firebase.ready()) {
    syncFirebase(data);
  } else {
    Serial.println("[System] Offline – skipping Firebase sync");
  }

  Serial.println("─────────────────────────────────────────");
}
