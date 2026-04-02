/**
 * Smart Room IAQ Dashboard – React
 * ==================================
 * Setup:
 *   npm create vite@latest smart-room-dashboard -- --template react
 *   cd smart-room-dashboard
 *   npm install firebase recharts lucide-react
 *
 * Replace firebaseConfig with your project values.
 * Put this file at: src/App.jsx
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, off, set } from "firebase/database";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  Thermometer, Droplets, Wind, Activity, Zap,
  AlertTriangle, CheckCircle, AlertCircle, Cpu, BrainCircuit,
} from "lucide-react";

// ─── Firebase Config ────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "your-project.firebaseapp.com",
  databaseURL:       "https://your-project-default-rtdb.firebaseio.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// ─── Helpers ────────────────────────────────────────────────────────────────
const CO2_CRITICAL = 800;

const getStatusConfig = (command, co2) => {
  if (co2 > CO2_CRITICAL || command === "CRITICAL_RED")
    return { label: "CRITICAL", color: "#ef4444", bg: "#fef2f2", icon: AlertTriangle, glow: "#ef444440" };
  if (command === "WARNING_YELLOW")
    return { label: "WARNING",  color: "#f59e0b", bg: "#fffbeb", icon: AlertCircle,  glow: "#f59e0b40" };
  return   { label: "NORMAL",   color: "#22c55e", bg: "#f0fdf4", icon: CheckCircle,  glow: "#22c55e40" };
};

const fmtTime = (isoStr) => {
  try { return new Date(isoStr).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch { return "--:--"; }
};

// ─── Stat Card ──────────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, unit, color, sub }) {
  return (
    <div style={{
      background: "#1e2030", borderRadius: 16, padding: "20px 24px",
      border: `1px solid ${color}25`, display: "flex", flexDirection: "column", gap: 8,
      boxShadow: `0 0 24px ${color}15`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10, background: `${color}20`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Icon size={18} color={color} />
        </div>
        <span style={{ color: "#94a3b8", fontSize: 13, fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ color: "#f1f5f9", fontSize: 32, fontWeight: 700, lineHeight: 1 }}>{value ?? "—"}</span>
        {unit && <span style={{ color: "#64748b", fontSize: 14 }}>{unit}</span>}
      </div>
      {sub && <span style={{ color: "#475569", fontSize: 12 }}>{sub}</span>}
    </div>
  );
}

// ─── Traffic Light ──────────────────────────────────────────────────────────
function TrafficLight({ command, co2 }) {
  const isRed    = co2 > CO2_CRITICAL || command === "CRITICAL_RED";
  const isYellow = !isRed && command === "WARNING_YELLOW";
  const isGreen  = !isRed && !isYellow;

  const bulb = (active, color) => (
    <div style={{
      width: 48, height: 48, borderRadius: "50%",
      background: active ? color : "#1a1a2e",
      boxShadow: active ? `0 0 24px ${color}, 0 0 48px ${color}60` : "none",
      border: `2px solid ${active ? color : "#2d2d4e"}`,
      transition: "all 0.4s ease",
    }} />
  );

  return (
    <div style={{
      background: "#0f1117", borderRadius: 24, padding: "24px 20px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
      border: "1px solid #1e2030", width: 100, flexShrink: 0,
    }}>
      {bulb(isRed,    "#ef4444")}
      {bulb(isYellow, "#f59e0b")}
      {bulb(isGreen,  "#22c55e")}
      <span style={{ color: "#475569", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>IAQ</span>
    </div>
  );
}

// ─── Alert Banner ───────────────────────────────────────────────────────────
function AlertBanner({ config }) {
  const Icon = config.icon;
  return (
    <div style={{
      background: `${config.color}15`, border: `1px solid ${config.color}40`,
      borderRadius: 12, padding: "14px 20px",
      display: "flex", alignItems: "center", gap: 12,
      boxShadow: `0 0 20px ${config.glow}`,
      animation: config.label === "CRITICAL" ? "pulse 1.5s infinite" : "none",
    }}>
      <Icon size={20} color={config.color} />
      <div>
        <div style={{ color: config.color, fontWeight: 700, fontSize: 14 }}>
          {config.label === "CRITICAL" && "⚠ Critical CO₂ Alert – Fan + Buzzer Active"}
          {config.label === "WARNING"  && "⚡ AI Proactive Warning – Ventilation Enabled"}
          {config.label === "NORMAL"   && "✓ Normal – Indoor Air Quality is Good"}
        </div>
      </div>
    </div>
  );
}

// ─── Insight Card ───────────────────────────────────────────────────────────
function InsightCard({ insight }) {
  const severityColor = {
    GOOD: "#22c55e", MODERATE: "#3b82f6", WARNING: "#f59e0b", CRITICAL: "#ef4444", UNKNOWN: "#6b7280"
  };
  const color = severityColor[insight?.severity] ?? "#6b7280";

  return (
    <div style={{
      background: "#1e2030", borderRadius: 16, padding: 24,
      border: `1px solid ${color}30`, gridColumn: "1 / -1",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <BrainCircuit size={18} color="#818cf8" />
        <span style={{ color: "#94a3b8", fontWeight: 600, fontSize: 14 }}>Gemini AI Insight</span>
        {insight?.severity && (
          <span style={{
            marginLeft: "auto", padding: "2px 10px", borderRadius: 20,
            background: `${color}20`, color, fontSize: 12, fontWeight: 700,
          }}>{insight.severity}</span>
        )}
      </div>
      {insight ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { key: "assessment",    label: "📊 Assessment"     },
            { key: "health_impact", label: "🫁 Health Impact"  },
            { key: "recommendation",label: "💡 Recommendation" },
          ].map(({ key, label }) => insight[key] && (
            <div key={key}>
              <div style={{ color: "#64748b", fontSize: 11, marginBottom: 2 }}>{label}</div>
              <div style={{ color: "#cbd5e1", fontSize: 14 }}>{insight[key]}</div>
            </div>
          ))}
          {insight.timestamp && (
            <div style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
              Updated: {fmtTime(insight.timestamp)}
            </div>
          )}
        </div>
      ) : (
        <div style={{ color: "#475569", fontSize: 14 }}>Waiting for AI insights…</div>
      )}
    </div>
  );
}

// ─── Model Stats Card ───────────────────────────────────────────────────────
function ModelStatsCard({ stats }) {
  return (
    <div style={{
      background: "#1e2030", borderRadius: 16, padding: 24,
      border: "1px solid #818cf820",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <Cpu size={16} color="#818cf8" />
        <span style={{ color: "#94a3b8", fontWeight: 600, fontSize: 14 }}>Isolation Forest Model</span>
        <span style={{
          marginLeft: "auto", padding: "2px 10px", borderRadius: 20,
          background: stats?.trained ? "#22c55e20" : "#f59e0b20",
          color: stats?.trained ? "#22c55e" : "#f59e0b",
          fontSize: 11, fontWeight: 700,
        }}>
          {stats?.trained ? "TRAINED" : "TRAINING…"}
        </span>
      </div>
      {stats ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            { label: "Samples",  value: stats.samples   },
            { label: "Mean CO₂", value: `${stats.mean_co2} ppm` },
            { label: "Std CO₂",  value: `${stats.std_co2} ppm`  },
            { label: "Range",    value: `${stats.min_co2}–${stats.max_co2} ppm` },
          ].map(({ label, value }) => (
            <div key={label} style={{
              background: "#0f1117", borderRadius: 10, padding: "10px 14px",
            }}>
              <div style={{ color: "#475569", fontSize: 11 }}>{label}</div>
              <div style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: "#475569", fontSize: 14 }}>Waiting for model data…</div>
      )}
    </div>
  );
}

// ─── Custom Tooltip ─────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#1e2030", border: "1px solid #2d3748",
      borderRadius: 8, padding: "8px 14px", fontSize: 13,
    }}>
      <div style={{ color: "#64748b", marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color, fontWeight: 600 }}>
          {p.name}: {p.value}
        </div>
      ))}
    </div>
  );
}

// ─── Control Panel ───────────────────────────────────────────────────────────
function ToggleSwitch({ checked, onChange, color }) {
  return (
    <label style={{ position: "relative", width: 50, height: 28, cursor: "pointer", flexShrink: 0 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ opacity: 0, width: 0, height: 0, position: "absolute" }} />
      <span style={{
        position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
        borderRadius: 28, background: checked ? `${color}30` : "#21262d",
        border: `1px solid ${checked ? color : "#30363d"}`, transition: "all .3s",
      }}>
        <span style={{
          position: "absolute", width: 20, height: 20, top: 3,
          left: checked ? 25 : 3, borderRadius: "50%",
          background: checked ? color : "#484f58", transition: "all .3s",
        }} />
      </span>
    </label>
  );
}

function ControlPanel({ db }) {
  const [acOn,      setAcOn]      = useState(true);
  const [fanOn,     setFanOn]     = useState(false);
  const [acTemp,    setAcTemp]    = useState(25);
  const [fanSpeed,  setFanSpeed]  = useState("Medium");
  const [logs,      setLogs]      = useState([
    { msg: "[AUTO] System started", type: "info", time: new Date().toLocaleTimeString("th-TH") },
  ]);

  const addLog = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString("th-TH");
    setLogs((prev) => [{ msg, type, time }, ...prev].slice(0, 20));
  }, []);

  const writeControl = useCallback(async (path, value) => {
    try { await set(ref(db, path), value); }
    catch (e) { console.error("Firebase write error:", e); }
  }, [db]);

  const handleACToggle = (on) => {
    setAcOn(on);
    writeControl("/control/room1/ac_on", on);
    writeControl("/control/room1/ac_mode", on ? "manual_on" : "manual_off");
    addLog(`[MANUAL] AC ${on ? "ON" : "OFF"} — ${on ? `setpoint ${acTemp}°C` : "Energy Saving"}`, on ? "on" : "off");
  };

  const handleFanToggle = (on) => {
    setFanOn(on);
    writeControl("/control/room1/fan_on", on);
    writeControl("/control/room1/fan_mode", on ? "manual_on" : "manual_off");
    writeControl("/control/room1/fan_speed", on ? fanSpeed : "off");
    addLog(`[MANUAL] Fan ${on ? "ON — Speed: " + fanSpeed : "OFF"}`, on ? "on" : "off");
  };

  const handleTempChange = (delta) => {
    if (!acOn) return;
    const t = Math.max(18, Math.min(30, acTemp + delta));
    setAcTemp(t);
    writeControl("/control/room1/ac_setpoint", t);
    addLog(`[MANUAL] AC setpoint → ${t}°C`, "on");
  };

  const handleSpeedChange = (speed) => {
    if (!fanOn) return;
    setFanSpeed(speed);
    writeControl("/control/room1/fan_speed", speed);
    addLog(`[MANUAL] Fan speed → ${speed}`, "on");
  };

  const logColor = { on: "#3fb950", off: "#f85149", warn: "#d29922", info: "#8b949e" };
  const speeds = ["Low", "Medium", "High"];

  const ctrlCardStyle = (on, color) => ({
    background: on ? `${color}08` : "#161b22",
    border: `1px solid ${on ? color + "40" : "#30363d"}`,
    borderRadius: 12, padding: "18px 20px",
    display: "flex", alignItems: "flex-start", gap: 14,
    transition: "all .3s", position: "relative",
  });

  return (
    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 12, padding: "20px", marginBottom: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, paddingBottom: 14, borderBottom: "1px solid #21262d" }}>
        <Activity size={14} color="#a371f7" />
        <span style={{ color: "#8b949e", fontWeight: 600, fontSize: 13 }}>Manual Device Control</span>
        <span style={{ marginLeft: 8, padding: "2px 9px", borderRadius: 20, fontSize: 11, background: "rgba(240,136,62,.15)", color: "#f0883e", fontWeight: 700 }}>
          Override Active
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#484f58" }}>
          Manual mode จะ override AI command ชั่วคราว
        </span>
      </div>

      {/* Controls */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>

        {/* AC */}
        <div style={ctrlCardStyle(acOn, "#3fb950")}>
          <span style={{ position: "absolute", top: 10, right: 12, padding: "2px 7px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: "rgba(240,136,62,.15)", color: "#f0883e" }}>MANUAL</span>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: acOn ? "rgba(63,185,80,.15)" : "#21262d", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all .3s" }}>
            <Thermometer size={22} color={acOn ? "#3fb950" : "#484f58"} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e6edf3" }}>Air Conditioner</div>
            <div style={{ fontSize: 12, color: acOn ? "#3fb950" : "#484f58", marginTop: 2, transition: "color .3s" }}>
              {acOn ? "Comfort Mode · กำลังทำงาน" : "ปิดอยู่ · Energy Saving"}
            </div>
            {/* Temp Control */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, opacity: acOn ? 1 : 0.35 }}>
              {[-1, 1].map((d, i) => (
                <button key={d} onClick={() => handleTempChange(d)} disabled={!acOn} style={{
                  width: 26, height: 26, borderRadius: 8, border: "1px solid #30363d",
                  background: "#0d1117", color: "#8b949e", fontSize: 16, cursor: acOn ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
                }}>{i === 0 ? "−" : "+"}</button>
              ))}
              <span style={{ fontSize: 20, fontWeight: 700, color: "#3fb950", minWidth: 48, textAlign: "center" }}>{acTemp}°C</span>
              <span style={{ fontSize: 11, color: "#484f58" }}>setpoint</span>
            </div>
          </div>
          <ToggleSwitch checked={acOn} onChange={handleACToggle} color="#3fb950" />
        </div>

        {/* Fan */}
        <div style={ctrlCardStyle(fanOn, "#58a6ff")}>
          <span style={{ position: "absolute", top: 10, right: 12, padding: "2px 7px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: "rgba(240,136,62,.15)", color: "#f0883e" }}>MANUAL</span>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: fanOn ? "rgba(88,166,255,.15)" : "#21262d", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all .3s" }}>
            <Wind size={22} color={fanOn ? "#58a6ff" : "#484f58"} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e6edf3" }}>Ventilation Fan</div>
            <div style={{ fontSize: 12, color: fanOn ? "#58a6ff" : "#484f58", marginTop: 2, transition: "color .3s" }}>
              {fanOn ? "กำลังระบายอากาศ" : "ปิดอยู่"}
            </div>
            {/* Speed Buttons */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, opacity: fanOn ? 1 : 0.35 }}>
              <span style={{ fontSize: 11, color: "#484f58" }}>Speed:</span>
              {speeds.map((s) => (
                <button key={s} onClick={() => handleSpeedChange(s)} disabled={!fanOn} style={{
                  padding: "3px 10px", borderRadius: 6, fontSize: 11, cursor: fanOn ? "pointer" : "not-allowed",
                  border: `1px solid ${fanOn && fanSpeed === s ? "rgba(88,166,255,.5)" : "#30363d"}`,
                  background: fanOn && fanSpeed === s ? "rgba(88,166,255,.15)" : "#0d1117",
                  color: fanOn && fanSpeed === s ? "#58a6ff" : "#484f58",
                  fontWeight: fanOn && fanSpeed === s ? 600 : 400,
                  transition: "all .2s",
                }}>{s}</button>
              ))}
            </div>
          </div>
          <ToggleSwitch checked={fanOn} onChange={handleFanToggle} color="#58a6ff" />
        </div>
      </div>

      {/* Activity Log */}
      <div style={{ borderTop: "1px solid #21262d", paddingTop: 12 }}>
        <div style={{ fontSize: 11, color: "#484f58", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <Activity size={11} /> Activity Log
        </div>
        <div style={{ background: "#0d1117", borderRadius: 8, padding: "10px 12px", maxHeight: 80, overflowY: "auto", fontFamily: "monospace", fontSize: 11 }}>
          {logs.map((l, i) => (
            <div key={i} style={{ color: logColor[l.type] ?? "#8b949e", lineHeight: 1.8 }}>
              {l.time} · {l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [sensors,    setSensors]    = useState(null);
  const [command,    setCommand]    = useState("NORMAL_GREEN");
  const [insight,    setInsight]    = useState(null);
  const [modelStats, setModelStats] = useState(null);
  const [history,    setHistory]    = useState([]);
  const [connected,  setConnected]  = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const historyRef = useRef([]);

  // ── Firebase Subscriptions ──────────────────────────────────────────────
  useEffect(() => {
    const refs = {
      sensors:    ref(database, "/sensors/room1"),
      command:    ref(database, "/command/room1"),
      insights:   ref(database, "/insights/room1"),
      modelStats: ref(database, "/model_stats/room1"),
    };

    // Sensor data
    onValue(refs.sensors, (snap) => {
      const data = snap.val();
      if (!data) return;
      setSensors(data);
      setConnected(true);
      setLastUpdate(new Date().toLocaleTimeString("th-TH"));

      // Append to chart history (keep last 60 points)
      const point = {
        time: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        co2:  Math.round(data.co2_ppm ?? 0),
        temp: parseFloat((data.temperature ?? 0).toFixed(1)),
        hum:  Math.round(data.humidity ?? 0),
      };
      historyRef.current = [...historyRef.current.slice(-59), point];
      setHistory([...historyRef.current]);
    });

    // AI Command
    onValue(refs.command, (snap) => {
      if (snap.val()) setCommand(snap.val());
    });

    // Gemini Insight
    onValue(refs.insights, (snap) => {
      if (snap.val()) setInsight(snap.val());
    });

    // Model Stats
    onValue(refs.modelStats, (snap) => {
      if (snap.val()) setModelStats(snap.val());
    });

    return () => Object.values(refs).forEach((r) => off(r));
  }, []);

  const co2 = sensors?.co2_ppm ?? 0;
  const status = getStatusConfig(command, co2);
  const StatusIcon = status.icon;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh", background: "#0d0f16", color: "#f1f5f9",
      fontFamily: "'Inter', system-ui, sans-serif",
      padding: "24px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; }
        body { background: #0d0f16; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.7; }
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0d0f16; }
        ::-webkit-scrollbar-thumb { background: #1e2030; border-radius: 3px; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.5 }}>
            Smart Room IAQ
          </h1>
          <div style={{ color: "#475569", fontSize: 13, marginTop: 2 }}>
            Room 1 · Real-time Monitoring
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: connected ? "#22c55e" : "#6b7280",
            boxShadow: connected ? "0 0 10px #22c55e" : "none",
          }} />
          <span style={{ color: "#64748b", fontSize: 13 }}>
            {connected ? `Live · ${lastUpdate}` : "Connecting…"}
          </span>
        </div>
      </div>

      {/* ── Alert Banner ── */}
      <div style={{ marginBottom: 20 }}>
        <AlertBanner config={status} />
      </div>

      {/* ── Main Grid ── */}
      <div style={{ display: "flex", gap: 20, marginBottom: 20 }}>

        {/* Traffic Light */}
        <TrafficLight command={command} co2={co2} />

        {/* Sensor Cards */}
        <div style={{
          flex: 1, display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 16,
        }}>
          <StatCard
            icon={Wind} label="CO₂" color="#818cf8"
            value={co2 > 0 ? Math.round(co2) : "—"}
            unit="ppm"
            sub={co2 > CO2_CRITICAL ? "⚠ Critical" : co2 > 600 ? "Elevated" : "Good"}
          />
          <StatCard
            icon={Thermometer} label="Temperature" color="#f97316"
            value={sensors?.temperature?.toFixed(1) ?? "—"}
            unit="°C"
            sub={sensors?.room_occupied ? "Room Occupied" : "Vacant"}
          />
          <StatCard
            icon={Droplets} label="Humidity" color="#38bdf8"
            value={sensors?.humidity ? Math.round(sensors.humidity) : "—"}
            unit="%"
            sub="Relative Humidity"
          />
          <StatCard
            icon={Activity} label="Motion (PIR)" color="#a78bfa"
            value={sensors?.pir !== undefined ? (sensors.pir ? "YES" : "NO") : "—"}
            sub={sensors?.room_occupied ? "AC Comfort Mode" : "AC Energy Save"}
          />
          <StatCard
            icon={Zap} label="AC Status" color="#34d399"
            value={sensors?.room_occupied ? "ON" : "OFF"}
            sub={sensors?.room_occupied ? "Comfort Mode" : "Energy Saving"}
          />
          <StatCard
            icon={StatusIcon} label="AI Command" color={status.color}
            value={command?.replace("_", " ") ?? "—"}
            sub="Isolation Forest"
          />
        </div>
      </div>

      {/* ── Manual Control Panel ── */}
      <ControlPanel db={database} />

      {/* ── Charts ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>

        {/* CO2 Chart */}
        <div style={{ background: "#1e2030", borderRadius: 16, padding: 24, border: "1px solid #818cf820" }}>
          <div style={{ color: "#94a3b8", fontWeight: 600, fontSize: 14, marginBottom: 16 }}>
            CO₂ History (ppm)
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={history}>
              <defs>
                <linearGradient id="co2Grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#818cf8" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#818cf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a2035" />
              <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#475569", fontSize: 11 }} domain={["auto", "auto"]}
                     label={{ value: "ppm", angle: -90, position: "insideLeft", fill: "#475569", fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={CO2_CRITICAL} stroke="#ef4444" strokeDasharray="4 4" />
              <Area type="monotone" dataKey="co2" stroke="#818cf8" fill="url(#co2Grad)"
                    strokeWidth={2} dot={false} name="CO₂ (ppm)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Temp & Humidity Chart */}
        <div style={{ background: "#1e2030", borderRadius: 16, padding: 24, border: "1px solid #38bdf820" }}>
          <div style={{ color: "#94a3b8", fontWeight: 600, fontSize: 14, marginBottom: 16 }}>
            Temperature & Humidity
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={history}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a2035" />
              <XAxis dataKey="time" tick={{ fill: "#475569", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#475569", fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ color: "#64748b", fontSize: 12 }} />
              <Line type="monotone" dataKey="temp" stroke="#f97316" strokeWidth={2}
                    dot={false} name="Temp (°C)" />
              <Line type="monotone" dataKey="hum"  stroke="#38bdf8" strokeWidth={2}
                    dot={false} name="Hum (%)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Bottom Grid: AI Insight + Model Stats ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <InsightCard insight={insight} />
        <ModelStatsCard stats={modelStats} />
      </div>

      {/* ── Footer ── */}
      <div style={{ textAlign: "center", color: "#2d3748", fontSize: 12, marginTop: 32 }}>
        Smart Room IAQ System · ESP32 + Firebase + Isolation Forest + Gemini
      </div>
    </div>
  );
}

// ─── ReferenceLine import shim ───────────────────────────────────────────────
// (recharts exports ReferenceLine separately)
import { ReferenceLine } from "recharts";
