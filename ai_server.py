"""
Smart Room IAQ – AI Server (Python)
=====================================
Steps implemented:
  4 → Listen to Firebase Realtime DB
  5 → Isolation Forest anomaly detection on CO2
  6 → Gemini LLM insight generation
  (7) → Serves processed data back to Firebase for React dashboard

Install dependencies:
  pip install firebase-admin scikit-learn google-generativeai pandas numpy joblib python-dotenv

Usage:
  python ai_server.py

Environment variables (create .env file):
  FIREBASE_CREDENTIAL_PATH=serviceAccountKey.json
  FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
  GEMINI_API_KEY=YOUR_GEMINI_API_KEY
"""

import os
import time
import json
import logging
import threading
from datetime import datetime
from collections import deque
from typing import Optional

import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

import firebase_admin
from firebase_admin import credentials, db as rtdb

import google.generativeai as genai
from dotenv import load_dotenv

# ─── Config ───────────────────────────────────────────────────────────────────
load_dotenv()

FIREBASE_CRED_PATH   = os.getenv("FIREBASE_CREDENTIAL_PATH", "serviceAccountKey.json")
FIREBASE_DB_URL      = os.getenv("FIREBASE_DATABASE_URL", "https://your-project-default-rtdb.firebaseio.com")
GEMINI_API_KEY       = os.getenv("GEMINI_API_KEY", "YOUR_GEMINI_API_KEY")

MODEL_PATH           = "isolation_forest_co2.pkl"
SCALER_PATH          = "scaler_co2.pkl"
MIN_TRAIN_SAMPLES    = 50     # Minimum readings before first training
RETRAIN_EVERY        = 100    # Retrain every N new readings
HISTORY_MAXLEN       = 2000   # Rolling window for training data
INSIGHT_COOLDOWN_SEC = 60     # Min seconds between Gemini calls (rate limit)
CO2_CRITICAL_PPM     = 800    # Must match ESP32

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger(__name__)

# ─── Firebase Init ────────────────────────────────────────────────────────────
def init_firebase() -> None:
    cred = credentials.Certificate(FIREBASE_CRED_PATH)
    firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_DB_URL})
    log.info("Firebase initialized  →  %s", FIREBASE_DB_URL)

# ─── Gemini Init ──────────────────────────────────────────────────────────────
def init_gemini() -> genai.GenerativeModel:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel("gemini-1.5-flash")
    log.info("Gemini model ready")
    return model

# ─────────────────────────────────────────────────────────────────────────────
# Step 5 – AI / ML Model: Isolation Forest Anomaly Detection
# ─────────────────────────────────────────────────────────────────────────────
class CO2AnomalyDetector:
    """
    Uses Isolation Forest to detect anomalous CO2 readings.
    Trains on rolling historical data and persists model to disk.
    """

    def __init__(self):
        self.model:   Optional[IsolationForest] = None
        self.scaler:  Optional[StandardScaler]  = None
        self.history: deque = deque(maxlen=HISTORY_MAXLEN)
        self.trained  = False
        self.sample_count = 0
        self._load_model()

    # ── Persistence ────────────────────────────────────────────────────────
    def _load_model(self) -> None:
        if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
            try:
                self.model   = joblib.load(MODEL_PATH)
                self.scaler  = joblib.load(SCALER_PATH)
                self.trained = True
                log.info("Loaded existing model from disk")
            except Exception as e:
                log.warning("Could not load saved model: %s", e)

    def _save_model(self) -> None:
        if self.model and self.scaler:
            joblib.dump(self.model,  MODEL_PATH)
            joblib.dump(self.scaler, SCALER_PATH)
            log.info("Model saved to disk")

    # ── Feature Engineering ────────────────────────────────────────────────
    @staticmethod
    def _build_features(history: list) -> np.ndarray:
        """
        Features: [co2_ppm, rolling_mean_10, rolling_std_10,
                   rolling_mean_30, hour_of_day]
        """
        arr = np.array(history)              # shape (N, 2): [timestamp_hour, co2]
        co2  = arr[:, 1]
        hour = arr[:, 0]

        rm10  = pd.Series(co2).rolling(10, min_periods=1).mean().values
        rs10  = pd.Series(co2).rolling(10, min_periods=1).std().fillna(0).values
        rm30  = pd.Series(co2).rolling(30, min_periods=1).mean().values

        return np.column_stack([co2, rm10, rs10, rm30, hour])

    # ── Train ───────────────────────────────────────────────────────────────
    def train(self) -> bool:
        if len(self.history) < MIN_TRAIN_SAMPLES:
            log.info("Not enough samples yet (%d/%d)", len(self.history), MIN_TRAIN_SAMPLES)
            return False

        X_raw = self._build_features(list(self.history))

        self.scaler = StandardScaler()
        X = self.scaler.fit_transform(X_raw)

        self.model = IsolationForest(
            n_estimators=200,
            contamination=0.05,   # 5% expected anomaly rate
            max_samples="auto",
            random_state=42,
            n_jobs=-1
        )
        self.model.fit(X)
        self.trained = True
        self._save_model()
        log.info("Isolation Forest trained on %d samples", len(self.history))
        return True

    # ── Add Reading ─────────────────────────────────────────────────────────
    def add_reading(self, co2_ppm: float, hour: float) -> None:
        self.history.append([hour, co2_ppm])
        self.sample_count += 1

        # Retrain periodically
        if self.sample_count % RETRAIN_EVERY == 0:
            log.info("Scheduled retraining (sample #%d)…", self.sample_count)
            threading.Thread(target=self.train, daemon=True).start()
        elif self.sample_count == MIN_TRAIN_SAMPLES:
            log.info("Reached minimum samples – initial training…")
            threading.Thread(target=self.train, daemon=True).start()

    # ── Predict ─────────────────────────────────────────────────────────────
    def predict(self, co2_ppm: float, hour: float) -> bool:
        """Returns True if anomaly detected."""
        if not self.trained or self.model is None:
            return False

        hist_list = list(self.history)
        if len(hist_list) < 5:
            return False

        X_raw = self._build_features(hist_list)
        X = self.scaler.transform(X_raw)

        prediction = self.model.predict(X[-1:])    # latest reading only
        score      = self.model.score_samples(X[-1:])[0]

        is_anomaly = prediction[0] == -1
        log.info("ML predict  CO2=%.0f  score=%.3f  anomaly=%s",
                 co2_ppm, score, is_anomaly)
        return is_anomaly

    # ── Stats for Dashboard ─────────────────────────────────────────────────
    def get_stats(self) -> dict:
        if len(self.history) < 2:
            return {}
        vals = [h[1] for h in self.history]
        return {
            "samples":    len(vals),
            "mean_co2":   round(float(np.mean(vals)), 1),
            "std_co2":    round(float(np.std(vals)),  1),
            "min_co2":    float(np.min(vals)),
            "max_co2":    float(np.max(vals)),
            "trained":    self.trained,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Step 6 – Gen AI Insight (Gemini LLM)
# ─────────────────────────────────────────────────────────────────────────────
class GeminiInsightGenerator:
    def __init__(self, model: genai.GenerativeModel):
        self.model      = model
        self.last_call  = 0.0

    def generate(self, sensor_data: dict, ml_status: str, stats: dict) -> str:
        now = time.time()
        if now - self.last_call < INSIGHT_COOLDOWN_SEC:
            return ""   # Rate-limit: don't spam Gemini

        prompt = f"""
You are an expert indoor air quality (IAQ) monitoring AI assistant for a smart building system.

Current sensor readings (Room 1):
- Temperature : {sensor_data.get('temperature', 'N/A')} °C
- Humidity    : {sensor_data.get('humidity',    'N/A')} %RH
- CO₂         : {sensor_data.get('co2_ppm',     'N/A')} ppm
- Motion (PIR): {'Detected' if sensor_data.get('pir') else 'Not detected'}
- Room status : {'Occupied' if sensor_data.get('room_occupied') else 'Vacant'}

ML Model Status  : {ml_status}
Historical stats (last {stats.get('samples', 0)} readings):
  - Mean CO₂  : {stats.get('mean_co2', 'N/A')} ppm
  - Std CO₂   : {stats.get('std_co2',  'N/A')} ppm
  - Min / Max : {stats.get('min_co2',  'N/A')} / {stats.get('max_co2', 'N/A')} ppm
Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

Provide a concise JSON response with these exact keys:
{{
  "assessment": "<1-2 sentence air quality assessment>",
  "health_impact": "<1 sentence on health implications, if any>",
  "recommendation": "<1 actionable recommendation>",
  "severity": "<one of: GOOD | MODERATE | WARNING | CRITICAL>"
}}
Respond ONLY with valid JSON, no markdown, no extra text.
"""
        try:
            response = self.model.generate_content(prompt)
            self.last_call = time.time()
            text = response.text.strip()
            # Strip any accidental markdown fences
            text = text.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(text)
            log.info("Gemini insight: severity=%s", parsed.get("severity"))
            return parsed
        except json.JSONDecodeError as e:
            log.warning("Gemini JSON parse error: %s | raw: %s", e, response.text[:200])
            return {"assessment": response.text[:300], "severity": "UNKNOWN",
                    "health_impact": "", "recommendation": ""}
        except Exception as e:
            log.error("Gemini API error: %s", e)
            return {}


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 – Listen to Firebase  +  Orchestrator
# ─────────────────────────────────────────────────────────────────────────────
class AIServer:
    def __init__(self):
        self.detector  = CO2AnomalyDetector()
        self.gemini    = None
        self.running   = True

    def setup(self):
        init_firebase()
        gemini_model  = init_gemini()
        self.gemini   = GeminiInsightGenerator(gemini_model)

    def _write_command(self, command: str) -> None:
        rtdb.reference("/command/room1").set(command)
        log.info("Firebase ← command: %s", command)

    def _write_insight(self, insight: dict, status: str, co2: float) -> None:
        if not insight:
            return
        rtdb.reference("/insights/room1").set({
            **insight,
            "ml_status": status,
            "co2_at_insight": co2,
            "timestamp": datetime.now().isoformat(),
        })
        log.info("Firebase ← insight written")

    def _write_model_stats(self, stats: dict) -> None:
        if stats:
            rtdb.reference("/model_stats/room1").set(stats)

    def on_sensor_event(self, event) -> None:
        """Callback fired whenever /sensors/room1 changes in Firebase."""
        if event.data is None:
            return

        data = event.data
        if not isinstance(data, dict):
            return

        co2_ppm = float(data.get("co2_ppm", 0))
        hour    = datetime.now().hour + datetime.now().minute / 60.0

        log.info("New reading → CO2=%.0f ppm  Temp=%.1f°C  Hum=%.1f%%",
                 co2_ppm,
                 data.get("temperature", 0),
                 data.get("humidity", 0))

        # ── Step 5: Add reading + predict ─────────────────────────────────
        self.detector.add_reading(co2_ppm, hour)

        # Don't process further if CO2 already critical (ESP32 handles hardware)
        if co2_ppm > CO2_CRITICAL_PPM:
            log.info("CO2 critical – ESP32 handles hardware, writing CRITICAL to Firebase")
            self._write_command("CRITICAL_RED")
            return

        is_anomaly = self.detector.predict(co2_ppm, hour)
        ml_status  = "WARNING_YELLOW" if is_anomaly else "NORMAL_GREEN"

        # ── Write ML command to Firebase (ESP32 reads this) ───────────────
        self._write_command(ml_status)

        # ── Step 6: Gemini Insight ────────────────────────────────────────
        stats   = self.detector.get_stats()
        insight = self.gemini.generate(data, ml_status, stats)
        self._write_insight(insight, ml_status, co2_ppm)

        # ── Write model stats for dashboard ───────────────────────────────
        self._write_model_stats(stats)

    def run(self) -> None:
        self.setup()
        log.info("Listening to /sensors/room1 …")

        # Step 4: Attach Firebase listener
        sensor_ref = rtdb.reference("/sensors/room1")
        sensor_ref.listen(self.on_sensor_event)

        log.info("AI Server running. Press Ctrl+C to stop.")
        try:
            while self.running:
                time.sleep(1)
        except KeyboardInterrupt:
            log.info("Shutting down AI Server…")
            self.running = False


# ─────────────────────────────────────────────────────────────────────────────
# Training Script (Standalone)
# ─────────────────────────────────────────────────────────────────────────────
def train_from_firebase_history(n_samples: int = 500) -> None:
    """
    Fetch historical data from Firebase and train the model offline.
    Run once before deploying the live server for a warm-started model.

    Usage:
        python ai_server.py --train
    """
    log.info("Fetching last %d sensor readings from Firebase…", n_samples)
    init_firebase()

    # Read snapshot
    snap = rtdb.reference("/sensors/room1").get()
    if not snap:
        log.error("No data at /sensors/room1")
        return

    detector = CO2AnomalyDetector()

    # If data is a dict with timestamp keys
    if isinstance(snap, dict):
        readings = list(snap.values())
    elif isinstance(snap, list):
        readings = snap
    else:
        readings = [snap]

    readings = readings[-n_samples:]
    log.info("Training on %d readings…", len(readings))

    for r in readings:
        if isinstance(r, dict):
            co2  = float(r.get("co2_ppm", 0))
            hour = 12.0  # Default if no timestamp
            detector.add_reading(co2, hour)

    success = detector.train()
    if success:
        log.info("Offline training complete – model saved")
    else:
        log.warning("Training failed – not enough samples")


# ─────────────────────────────────────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    if "--train" in sys.argv:
        train_from_firebase_history()
    else:
        server = AIServer()
        server.run()
