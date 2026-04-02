# Smart Room IAQ System – Setup Guide

## Architecture Overview
```
ESP32 (C++) ─── Firebase Realtime DB ─── Python AI Server
                         │                      │
                    React Dashboard         Gemini LLM
```

---

## 1. Firebase Setup

1. Go to https://console.firebase.google.com → Create project
2. Enable **Realtime Database** (Start in test mode for development)
3. Note your **Database URL**: `https://your-project-default-rtdb.firebaseio.com`
4. For Python AI Server: Project Settings → Service Accounts → **Generate new private key** → save as `serviceAccountKey.json`
5. For ESP32: Project Settings → General → **Web API Key** (use as `FIREBASE_AUTH`)

### Database Rules (development)
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

---

## 2. ESP32 (C++) – `esp32_main.cpp`

### PlatformIO `platformio.ini`
```ini
[env:esp32dev]
platform  = espressif32
board     = esp32dev
framework = arduino
lib_deps  =
    mobizt/Firebase ESP32 Client@^4.4.10
    adafruit/DHT sensor library@^1.4.6
    bblanchon/ArduinoJson@^6.21.4
```

### Edit these constants at the top of `esp32_main.cpp`:
```cpp
#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define FIREBASE_HOST "your-project-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "YOUR_DATABASE_SECRET"
```

### Wiring
| Component | ESP32 Pin |
|-----------|-----------|
| DHT22 DATA | GPIO 4 |
| MQ135 AOUT | GPIO 34 (ADC) |
| PIR OUT    | GPIO 14 |
| Buzzer +   | GPIO 27 |
| LED Red    | GPIO 25 |
| LED Yellow | GPIO 26 |
| LED Green  | GPIO 33 |
| Fan Relay  | GPIO 32 |
| AC Relay   | GPIO 13 |

> **MQ135 Calibration**: The sensor needs 24h warm-up for accurate readings.
> Adjust `mapCO2()` function with your sensor's datasheet calibration curve.

---

## 3. Python AI Server – `ai_server.py`

### Install dependencies
```bash
pip install firebase-admin scikit-learn google-generativeai pandas numpy joblib python-dotenv
```

### Create `.env` file
```env
FIREBASE_CREDENTIAL_PATH=serviceAccountKey.json
FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

Get Gemini API key: https://aistudio.google.com/app/apikey

### Run (offline training first, then live server)
```bash
# Optional: Pre-train on existing Firebase data
python ai_server.py --train

# Start live AI server
python ai_server.py
```

### What it does
- **Step 4**: Listens to `/sensors/room1` in Firebase
- **Step 5**: Runs Isolation Forest anomaly detection on CO₂ readings
  - Writes `WARNING_YELLOW` or `NORMAL_GREEN` to `/command/room1`
- **Step 6**: Calls Gemini Flash for natural language insights
  - Writes structured insight to `/insights/room1`
- Writes model stats to `/model_stats/room1` for dashboard

---

## 4. React Dashboard – `Dashboard.jsx`

### Create React project
```bash
npm create vite@latest smart-room-dashboard -- --template react
cd smart-room-dashboard
npm install firebase recharts lucide-react
```

### Replace `src/App.jsx` with `Dashboard.jsx`

### Edit Firebase config inside `Dashboard.jsx`
```js
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "your-project.firebaseapp.com",
  databaseURL:       "https://your-project-default-rtdb.firebaseio.com",
  projectId:         "your-project",
  // ...
};
```

### Run
```bash
npm run dev
```

---

## Firebase Data Structure

```
/
├── sensors/
│   └── room1/
│       ├── temperature   (float, °C)
│       ├── humidity      (float, %RH)
│       ├── co2_ppm       (float, ppm)
│       ├── co2_raw       (int, 0-4095)
│       ├── pir           (bool)
│       ├── room_occupied (bool)
│       ├── ai_command    (string)
│       └── timestamp     (int, unix seconds)
│
├── command/
│   └── room1             (string: "NORMAL_GREEN" | "WARNING_YELLOW" | "CRITICAL_RED")
│
├── insights/
│   └── room1/
│       ├── assessment    (string)
│       ├── health_impact (string)
│       ├── recommendation(string)
│       ├── severity      (string: GOOD|MODERATE|WARNING|CRITICAL)
│       ├── ml_status     (string)
│       ├── co2_at_insight(float)
│       └── timestamp     (ISO string)
│
└── model_stats/
    └── room1/
        ├── samples  (int)
        ├── mean_co2 (float)
        ├── std_co2  (float)
        ├── min_co2  (float)
        ├── max_co2  (float)
        └── trained  (bool)
```

---

## CO₂ Level Reference

| Level (ppm) | Status | Action |
|-------------|--------|--------|
| < 600 | 🟢 Good | Normal |
| 600–800 | 🟡 Moderate | ML monitoring |
| > 800 | 🔴 Critical | Fan + Buzzer (immediate) |
