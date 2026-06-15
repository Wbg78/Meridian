// ───────────────────────────────────────────────────────────────
// frontend/src/TheEye.jsx
// THE EYE — Full-screen intelligence war room
//
// Design: dark space aesthetic, electric cyan/blue accents,
// cinematic typography, CesiumJS globe as centerpiece.
// Inspired by freedom.gov: bold, futuristic, minimal chrome.
//
// CesiumJS loaded via CDN in index.html (see CLAUDE_CODE_PROMPT.md
// for the script tag to add). Ion token optional for high-res imagery.
//
// Wiring in App.jsx:
//   import TheEye from "./TheEye.jsx";
//   VIEWS: { ..., eye: TheEye }
// Also add to TABS array:
//   { id: "eye", label: "The Eye", icon: "◉" }
// ───────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ─── Design tokens ───────────────────────────────────────────────
const T = {
  bg:       "#03050a",
  surface:  "#080d17",
  border:   "#0f2040",
  cyan:     "#00d4ff",
  cyanDim:  "#00d4ff33",
  cyanGlow: "0 0 20px #00d4ff44",
  blue:     "#0066ff",
  red:      "#ff3355",
  green:    "#00ff88",
  amber:    "#ffaa00",
  text:     "#e8f4ff",
  muted:    "#4a7090",
  font:     "'Space Grotesk', 'DM Sans', system-ui, sans-serif",
  mono:     "'Space Mono', 'DM Mono', monospace",
};

// ─── Tiny primitives ─────────────────────────────────────────────
const css = (obj) => Object.entries(obj).map(([k, v]) =>
  `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}:${v}`).join(";");

function EyeCard({ children, style, glow }) {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${glow ? T.cyan : T.border}`,
      borderRadius: 4,
      padding: "12px 16px",
      boxShadow: glow ? T.cyanGlow : "none",
      ...style,
    }}>{children}</div>
  );
}

function StatBox({ label, value, sub, color }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color: color || T.cyan, lineHeight: 1, letterSpacing: -1 }}>
        {value ?? "—"}
      </div>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: T.muted, marginTop: 4 }}>
        {label}
      </div>
      {sub && <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Dot({ color }) {
  return <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: color, marginRight: 6, boxShadow: `0 0 6px ${color}` }} />;
}

function Tag({ children, color }) {
  const c = color === "green" ? T.green : color === "red" ? T.red : color === "amber" ? T.amber : T.cyan;
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: c, border: `1px solid ${c}33`, borderRadius: 2, padding: "2px 6px" }}>
      {children}
    </span>
  );
}

// ─── SGP4 propagation (satellite.js, loaded via CDN as window.satellite) ──
function propagateSat(satrec, date) {
  try {
    const pv = window.satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = window.satellite.gstime(date);
    const geo = window.satellite.eciToGeodetic(pv.position, gmst);
    const lat = window.satellite.degreesLat(geo.latitude);
    const lon = window.satellite.degreesLong(geo.longitude);
    const alt = geo.height * 1000;  // km → m
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) return null;
    return { lat, lon, alt };
  } catch { return null; }
}

// ─── CesiumJS Globe ─────────────────────────────────────────────
function Globe({ data, satellites, onFacilityClick, onSatClick }) {
  const ref = useRef(null);
  const viewerRef = useRef(null);
  const dataEntsRef = useRef([]);    // ISS / conflicts / launch-pad entities
  const satEntsRef = useRef([]);     // [{ satrec, ent }]
  const onSatClickRef = useRef(onSatClick);
  onSatClickRef.current = onSatClick;  // keep click handler fresh w/o re-init

  // ── Init the viewer exactly once ──
  useEffect(() => {
    if (!ref.current || !window.Cesium || viewerRef.current) return;

    if (import.meta.env.VITE_CESIUM_ION_TOKEN) {
      window.Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
    }

    const viewer = new window.Cesium.Viewer(ref.current, {
      animation: false, baseLayerPicker: false, fullscreenButton: false,
      geocoder: false, homeButton: false, infoBox: false, sceneModePicker: false,
      selectionIndicator: false, timeline: false, navigationHelpButton: false,
      // Cesium 1.118 removed the `imageryProvider` constructor option; set below.
    });

    // Base imagery: bundled Natural Earth II (no token, can't fail) first, then
    // overlay Ion high-res world imagery if a token is present. Guarantees the
    // globe always has a texture (so zoom always shows real terrain).
    (async () => {
      const layers = viewer.imageryLayers;
      try {
        layers.removeAll();
        layers.addImageryProvider(
          await window.Cesium.TileMapServiceImageryProvider.fromUrl(
            window.Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
          )
        );
      } catch { /* keep globe base color */ }
      if (import.meta.env.VITE_CESIUM_ION_TOKEN) {
        try { layers.addImageryProvider(await window.Cesium.createWorldImageryAsync()); }
        catch { /* Ion overlay optional */ }
      }
    })();

    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyBox.show = true;
    viewer.scene.backgroundColor = new window.Cesium.Color(0.01, 0.02, 0.05, 1.0);
    viewer.scene.globe.baseColor = new window.Cesium.Color(0.02, 0.05, 0.12, 1.0);
    viewer.camera.setView({
      destination: window.Cesium.Cartesian3.fromDegrees(20, 20, 20000000),
    });

    // Click a satellite → bubble its info up to the panel
    const handler = new window.Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      const sat = picked?.id?.properties?.sat?.getValue?.(window.Cesium.JulianDate.now());
      if (sat && onSatClickRef.current) onSatClickRef.current(sat);
    }, window.Cesium.ScreenSpaceEventType.LEFT_CLICK);

    viewerRef.current = viewer;
    return () => {
      handler.destroy();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) viewerRef.current.destroy();
      viewerRef.current = null;
    };
  }, []);

  // ── Data markers (ISS / conflicts / launch pads) — rebuild when data loads ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !window.Cesium || !data) return;
    dataEntsRef.current.forEach(e => viewer.entities.remove(e));
    dataEntsRef.current = [];
    const add = (opts) => { const e = viewer.entities.add(opts); dataEntsRef.current.push(e); return e; };

    if (data?.iss?.position) {
      const { lat, lon } = data.iss.position;
      if (isFinite(+lat) && isFinite(+lon)) add({
        position: window.Cesium.Cartesian3.fromDegrees(+lon, +lat, 420000),
        point: { pixelSize: 11, color: window.Cesium.Color.fromCssColorString(T.green), outlineColor: window.Cesium.Color.WHITE, outlineWidth: 1 },
        label: { text: "ISS", font: "10px monospace", fillColor: window.Cesium.Color.fromCssColorString(T.green), pixelOffset: new window.Cesium.Cartesian2(0, -18) },
      });
    }
    (data?.conflicts || []).forEach(c => {
      if (!isFinite(+c.lat) || !isFinite(+c.lon)) return;
      const color = c.intensity === "high" ? T.red : c.intensity === "medium" ? T.amber : "#ff6666";
      add({
        position: window.Cesium.Cartesian3.fromDegrees(+c.lon, +c.lat),
        ellipse: {
          semiMinorAxis: c.intensity === "high" ? 300000 : 150000,
          semiMajorAxis: c.intensity === "high" ? 300000 : 150000,
          material: window.Cesium.Color.fromCssColorString(color).withAlpha(0.25),
          outline: true, outlineColor: window.Cesium.Color.fromCssColorString(color),
        },
        label: { text: c.name, font: "9px monospace", fillColor: window.Cesium.Color.fromCssColorString(color), pixelOffset: new window.Cesium.Cartesian2(0, -20) },
      });
    });
    (data?.launches || []).forEach(l => {
      if (!isFinite(+l.padLat) || !isFinite(+l.padLon)) return;
      add({
        position: window.Cesium.Cartesian3.fromDegrees(+l.padLon, +l.padLat),
        point: { pixelSize: 6, color: window.Cesium.Color.fromCssColorString(T.blue), outlineColor: window.Cesium.Color.WHITE, outlineWidth: 1 },
      });
    });
  }, [data]);

  // ── Live satellites (SGP4) — render points + tick positions every 3s ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !window.Cesium || !window.satellite || !satellites?.length) return;
    satEntsRef.current.forEach(({ ent }) => viewer.entities.remove(ent));
    satEntsRef.current = [];

    const recs = [];
    const now = new Date();
    satellites.forEach(s => {
      let satrec;
      try { satrec = window.satellite.twoline2satrec(s.tle1, s.tle2); } catch { return; }
      const p = propagateSat(satrec, now);
      if (!p) return;
      const ent = viewer.entities.add({
        position: window.Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
        point: {
          pixelSize: s.group === "stations" ? 8 : 4,
          color: window.Cesium.Color.fromCssColorString(s.color || "#00d4ff"),
          outlineColor: window.Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1,
        },
        properties: { sat: { name: s.name, operator: s.operator, country: s.country, group: s.group, color: s.color } },
      });
      recs.push({ satrec, ent });
    });
    satEntsRef.current = recs;

    const timer = setInterval(() => {
      const v = viewerRef.current;
      if (!v || v.isDestroyed()) return;
      const t = new Date();
      recs.forEach(({ satrec, ent }) => {
        const p = propagateSat(satrec, t);
        if (p) ent.position = window.Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt);
      });
    }, 3000);

    return () => {
      clearInterval(timer);
      const v = viewerRef.current;
      if (v && !v.isDestroyed()) recs.forEach(({ ent }) => v.entities.remove(ent));
      satEntsRef.current = [];
    };
  }, [satellites]);

  // Add facility markers when requested (from globe search / operator click)
  const searchEntsRef = useRef([]);
  const addFacilityMarkers = useCallback((locations) => {
    if (!viewerRef.current || viewerRef.current.isDestroyed() || !window.Cesium) return;
    searchEntsRef.current.forEach(e => viewerRef.current.entities.remove(e));
    searchEntsRef.current = [];
    locations.forEach(loc => {
      const ent = viewerRef.current.entities.add({
        position: window.Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat),
        point: { pixelSize: 12, color: window.Cesium.Color.fromCssColorString(T.cyan), outlineColor: window.Cesium.Color.WHITE, outlineWidth: 2 },
        label: { text: loc.name, font: "10px monospace", fillColor: window.Cesium.Color.fromCssColorString(T.cyan), pixelOffset: new window.Cesium.Cartesian2(0, -22) },
      });
      searchEntsRef.current.push(ent);
    });
  }, []);

  const flyTo = useCallback((lat, lon, alt = 2000000) => {
    if (!viewerRef.current || viewerRef.current.isDestroyed() || !window.Cesium) return;
    viewerRef.current.camera.flyTo({
      destination: window.Cesium.Cartesian3.fromDegrees(lon, lat, alt),
      duration: 2.5,
    });
  }, []);

  useEffect(() => {
    if (onFacilityClick) onFacilityClick({ addFacilityMarkers, flyTo });
  }, [addFacilityMarkers, flyTo, onFacilityClick]);

  return (
    <div ref={ref} style={{ width: "100%", height: "100%", background: T.bg }} />
  );
}

// ─── SEARCH BAR ─────────────────────────────────────────────────
function GlobeSearch({ token, onResult }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);

  async function search() {
    if (!q.trim()) return;
    const r = await fetch(`${BACKEND}/api/space/search?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(() => []);
    setResults(Array.isArray(r) ? r : []);
    if (r.length > 0) onResult(r[0]);
  }

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === "Enter" && search()}
          placeholder="Search TSMC, SpaceX, Taiwan, Intel…"
          style={{
            flex: 1, background: T.surface, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.mono, fontSize: 12,
            borderRadius: 2, padding: "8px 12px", outline: "none",
          }}
        />
        <button onClick={search} style={{
          background: T.cyanDim, border: `1px solid ${T.cyan}`, color: T.cyan,
          fontFamily: T.mono, fontSize: 11, fontWeight: 700, padding: "8px 16px",
          borderRadius: 2, cursor: "pointer", letterSpacing: "0.1em",
        }}>SCAN</button>
      </div>
      {results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100, marginTop: 4 }}>
          {results.map((r, i) => (
            <div key={i} onClick={() => { onResult(r); setResults([]); }} style={{
              background: T.surface, border: `1px solid ${T.border}`, padding: "10px 14px",
              cursor: "pointer", marginBottom: 2, borderRadius: 2,
            }}>
              <div style={{ color: T.cyan, fontFamily: T.mono, fontSize: 12, fontWeight: 700 }}>{r.name}</div>
              <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>{r.intel}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── UPCOMING LAUNCHES PANEL ─────────────────────────────────────
function UpcomingLaunches({ launches }) {
  if (!launches?.length) return <div style={{ color: T.muted, fontSize: 11 }}>Loading upcoming launches…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {launches.slice(0, 6).map((l, i) => {
        const tMinus = l.tMinus;
        const days = tMinus ? Math.floor(tMinus / 86400000) : null;
        const hours = tMinus ? Math.floor((tMinus % 86400000) / 3600000) : null;
        return (
          <div key={i} style={{ borderLeft: `2px solid ${T.cyan}33`, paddingLeft: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ color: T.text, fontSize: 11, fontWeight: 600, flex: 1, paddingRight: 8 }}>{l.name}</div>
              {days !== null && (
                <div style={{ fontFamily: T.mono, fontSize: 10, color: days < 3 ? T.cyan : T.muted, whiteSpace: "nowrap" }}>
                  {days === 0 ? `T-${hours}h` : `T-${days}d`}
                </div>
              )}
            </div>
            <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>
              {l.agency} · {l.rocket} · {l.missionOrbit || "TBD"}
            </div>
            {l.padLocation && <div style={{ color: T.muted, fontSize: 9, marginTop: 1 }}>📍 {l.padLocation}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── RECENT LAUNCHES CHART ───────────────────────────────────────
function LaunchChart({ chart }) {
  if (!chart?.length) return <div style={{ color: T.muted, fontSize: 11 }}>No launch data</div>;
  const max = Math.max(...chart.map(c => c.launches), 1);
  const AGENCY_COLORS = {
    "SpaceX": T.cyan, "China Aerospace Science and Technology Corporation": T.red,
    "Rocket Lab": T.green, "United Launch Alliance": T.blue,
    "European Space Agency": "#aa44ff", "Indian Space Research Organisation": T.amber,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {chart.slice(0, 8).map((c, i) => {
        const color = AGENCY_COLORS[c.agency] || T.muted;
        const pct = (c.launches / max) * 100;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 90, fontSize: 9, color: T.muted, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {c.agency.split(" ")[0]}
            </div>
            <div style={{ flex: 1, height: 6, background: `${color}22`, borderRadius: 1, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 1 }} />
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color, width: 20, textAlign: "right" }}>{c.launches}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── INTELLIGENCE FEED ───────────────────────────────────────────
function IntelFeed({ launches }) {
  if (!launches?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {launches.slice(0, 8).map((l, i) => {
        const age = l.net ? Math.floor((Date.now() - new Date(l.net)) / 3600000) : null;
        const isRecent = age !== null && age < 48;
        return (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
            <Dot color={isRecent ? T.green : T.muted} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: T.text, fontSize: 10, fontWeight: 600 }}>{l.name}</div>
              <div style={{ color: T.muted, fontSize: 9 }}>{l.agency}{age !== null ? ` · ${age < 24 ? age + "h ago" : Math.floor(age / 24) + "d ago"}` : ""}</div>
            </div>
            <Tag color={l.status === "Success" ? "green" : l.status === "Failure" ? "red" : "amber"}>
              {l.status?.split(" ")[0] || "TBD"}
            </Tag>
          </div>
        );
      })}
    </div>
  );
}

// ─── SATELLITE FACILITIES PANEL ──────────────────────────────────
function FacilitiesPanel({ token, globeControlsRef }) {
  const [facilities, setFacilities] = useState([]);
  const [selected, setSelected] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${BACKEND}/api/satellite/facilities`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setFacilities(Array.isArray(d) ? d : [])).catch(() => {});
  }, [token]);

  async function analyze(f) {
    setSelected(f.key); setLoading(true); setAnalysis(null);
    if (globeControlsRef.current) {
      const { addFacilityMarkers, flyTo } = globeControlsRef.current;
      addFacilityMarkers([{ name: f.name, lat: f.lat, lon: f.lon }]);
      flyTo(f.lat, f.lon, 600000);
    }
    const r = await fetch(`${BACKEND}/api/satellite/analyze/${f.key}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(e => ({ error: e.message }));
    setAnalysis(r); setLoading(false);
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
        {facilities.map(f => (
          <button key={f.key} onClick={() => analyze(f)} style={{
            background: selected === f.key ? T.cyanDim : "transparent",
            border: `1px solid ${selected === f.key ? T.cyan : T.border}`,
            color: selected === f.key ? T.cyan : T.muted,
            fontFamily: T.mono, fontSize: 9, fontWeight: 700,
            padding: "6px 8px", borderRadius: 2, cursor: "pointer",
            textAlign: "left", letterSpacing: "0.05em",
          }}>
            {f.company}<br />
            <span style={{ color: T.muted, fontWeight: 400 }}>{f.region}</span>
          </button>
        ))}
      </div>
      {loading && <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono }}>Fetching imagery…</div>}
      {analysis && !loading && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
          <div style={{ color: T.cyan, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>{analysis.facility}</div>
          {analysis.imagery?.available === false && (
            <div style={{ color: T.amber, fontSize: 10 }}>⚠ {analysis.imagery.reason}</div>
          )}
          {analysis.analysis && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: T.muted, fontSize: 10 }}>Utilization</span>
                <span style={{ color: T.text, fontSize: 10, fontFamily: T.mono }}>{analysis.analysis.utilizationEstimate}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: T.muted, fontSize: 10 }}>Status</span>
                <Tag color={analysis.analysis.operationalStatus === "fully operational" ? "green" : "amber"}>
                  {analysis.analysis.operationalStatus}
                </Tag>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: T.muted, fontSize: 10 }}>Signal</span>
                <Tag color={analysis.analysis.investmentSignal === "bullish" ? "green" : analysis.analysis.investmentSignal === "bearish" ? "red" : "amber"}>
                  {analysis.analysis.investmentSignal}
                </Tag>
              </div>
              <div style={{ color: T.muted, fontSize: 9, marginTop: 4, lineHeight: 1.5 }}>{analysis.analysis.investmentRationale}</div>
              {analysis.analysis.constructionActivity && (
                <div style={{ color: T.amber, fontSize: 9 }}>🏗 {analysis.analysis.constructionDescription}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PATENTS PANEL ───────────────────────────────────────────────
function PatentsPanel({ token }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [landscape, setLandscape] = useState(null);
  const [loading, setLoading] = useState(false);

  async function search() {
    if (!q.trim()) return;
    setLoading(true);
    const [patents, land] = await Promise.allSettled([
      fetch(`${BACKEND}/api/patents/search?q=${encodeURIComponent(q)}&limit=5`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json()),
      fetch(`${BACKEND}/api/patents/landscape?tech=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json()),
    ]);
    setResults(patents.status === "fulfilled" ? patents.value : []);
    setLandscape(land.status === "fulfilled" ? land.value : null);
    setLoading(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === "Enter" && search()}
          placeholder="Search patents: 'semiconductor lithography'"
          style={{
            flex: 1, background: T.surface, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.mono, fontSize: 11,
            borderRadius: 2, padding: "7px 10px", outline: "none",
          }}
        />
        <button onClick={search} style={{
          background: T.cyanDim, border: `1px solid ${T.cyan}`, color: T.cyan,
          fontFamily: T.mono, fontSize: 10, fontWeight: 700, padding: "7px 12px",
          borderRadius: 2, cursor: "pointer",
        }}>SCAN</button>
      </div>

      {loading && <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono }}>Scanning USPTO…</div>}

      {landscape && !loading && (
        <div>
          <div style={{ color: T.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
            Patent landscape · {landscape.totalPatents?.toLocaleString()} total
          </div>
          {(landscape.landscape || []).slice(0, 5).map((c, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 9, color: T.muted, width: 80, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.company.split(" ")[0]}
              </div>
              <div style={{ flex: 1, height: 5, background: `${T.cyan}22`, borderRadius: 1 }}>
                <div style={{ width: `${c.share}%`, height: "100%", background: i === 0 ? T.cyan : T.blue, borderRadius: 1 }} />
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.text, width: 30, textAlign: "right" }}>{c.patents}</div>
            </div>
          ))}
        </div>
      )}

      {results.length > 0 && !loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {results.map((p, i) => (
            <div key={i} style={{ borderLeft: `2px solid ${T.blue}`, paddingLeft: 10 }}>
              <div style={{ color: T.text, fontSize: 10, fontWeight: 600 }}>{p.title}</div>
              <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>{p.assignee} · {p.date}</div>
              <div style={{ color: T.muted, fontSize: 9, marginTop: 4, lineHeight: 1.4 }}>{p.abstract}</div>
              <a href={p.url} target="_blank" rel="noreferrer" style={{ color: T.cyan, fontSize: 9 }}>View patent ↗</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────
export default function TheEye({ token }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [activePanel, setActivePanel] = useState("space");
  const [data, setData] = useState(null);
  const [satellites, setSatellites] = useState([]);
  const [selectedSat, setSelectedSat] = useState(null);
  const [loading, setLoading] = useState(true);
  const globeControlsRef = useRef(null);

  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/space/overview`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  // Live satellites for the globe (fetched once; SGP4-propagated client-side)
  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/space/satellites`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setSatellites(Array.isArray(d) ? d : [])).catch(() => {});
  }, [token]);

  function handleSearchResult(result) {
    if (!globeControlsRef.current) return;
    const { addFacilityMarkers, flyTo } = globeControlsRef.current;
    if (result.locations?.length > 0) {
      addFacilityMarkers(result.locations);
      flyTo(result.locations[0].lat, result.locations[0].lon, 1500000);
    }
  }

  const catalog = data?.catalog || {};
  const stats = data?.stats || {};

  // ── The trigger button that lives in the regular Meridian tab bar ──
  if (!fullscreen) {
    return (
      <div style={{ fontFamily: T.font }}>
        <div style={{
          background: `linear-gradient(135deg, ${T.bg} 0%, #030b1a 100%)`,
          border: `1px solid ${T.border}`, borderRadius: 8, padding: 32,
          textAlign: "center", position: "relative", overflow: "hidden",
        }}>
          {/* Background grid lines for atmosphere */}
          <div style={{ position: "absolute", inset: 0, backgroundImage: `linear-gradient(${T.border} 1px, transparent 1px), linear-gradient(90deg, ${T.border} 1px, transparent 1px)`, backgroundSize: "40px 40px", opacity: 0.3 }} />
          <div style={{ position: "relative" }}>
            <div style={{ fontSize: 11, fontFamily: T.mono, letterSpacing: "0.3em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>
              Meridian Intelligence Platform
            </div>
            <div style={{ fontSize: 52, fontWeight: 900, color: T.text, letterSpacing: -2, lineHeight: 1, marginBottom: 4 }}>
              THE EYE
            </div>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 32, lineHeight: 1.6 }}>
              Global space intelligence · Operational satellite imagery<br />
              Patent landscape · Conflict monitoring
            </div>
            <button onClick={() => setFullscreen(true)} style={{
              background: "transparent", border: `1px solid ${T.cyan}`,
              color: T.cyan, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              letterSpacing: "0.2em", textTransform: "uppercase",
              padding: "14px 40px", borderRadius: 2, cursor: "pointer",
              boxShadow: T.cyanGlow, transition: "all 0.2s",
            }}>
              ENTER THE EYE →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── FULL-SCREEN WAR ROOM ──
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: T.bg, fontFamily: T.font, color: T.text,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* ── Top bar ── */}
      <div style={{
        height: 44, borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", padding: "0 16px",
        background: T.surface, flexShrink: 0, gap: 16,
      }}>
        <button onClick={() => setFullscreen(false)} style={{
          background: "transparent", border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
          letterSpacing: "0.15em", padding: "4px 12px", borderRadius: 2,
          cursor: "pointer", flexShrink: 0,
        }}>← LEAVE</button>

        <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: "0.2em", color: T.cyan }}>THE EYE</div>

        {/* Sub-section tabs */}
        <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {[["space", "SPACE INTEL"], ["ops", "OPERATIONS"], ["patents", "PATENTS"]].map(([id, label]) => (
            <button key={id} onClick={() => setActivePanel(id)} style={{
              background: activePanel === id ? T.cyanDim : "transparent",
              border: `1px solid ${activePanel === id ? T.cyan : T.border}`,
              color: activePanel === id ? T.cyan : T.muted,
              fontFamily: T.mono, fontSize: 9, fontWeight: 700,
              letterSpacing: "0.12em", padding: "4px 12px", borderRadius: 2,
              cursor: "pointer",
            }}>{label}</button>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center" }}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>
            <Dot color={loading ? T.amber : T.green} />
            {loading ? "SYNCING" : "LIVE"}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>
            {new Date().toUTCString().slice(0, 25)} UTC
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Left sidebar ── */}
        <div style={{
          width: 260, flexShrink: 0, borderRight: `1px solid ${T.border}`,
          background: T.surface, overflowY: "auto", padding: 12,
          display: "flex", flexDirection: "column", gap: 16,
        }}>
          {/* Stats */}
          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>Orbital Status</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <StatBox label="Objects" value={catalog.total?.toLocaleString()} />
              <StatBox label="Active Sats" value={catalog.active?.toLocaleString()} color={T.green} />
              <StatBox label="Debris" value={catalog.debris?.toLocaleString()} color={T.red} />
              <StatBox label="Countries" value={catalog.countriesWithAssets} color={T.amber} />
            </div>
          </EyeCard>

          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>Launch Activity</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <StatBox label="This Year" value={stats.totalThisYear} />
              <StatBox label="Upcoming" value={data?.upcoming?.length} color={T.cyan} />
            </div>
          </EyeCard>

          {/* Search */}
          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 8 }}>Globe Search</div>
            <GlobeSearch token={token} onResult={handleSearchResult} />
          </EyeCard>

          {/* ISS */}
          {data?.iss && (
            <EyeCard glow>
              <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.cyan, textTransform: "uppercase", marginBottom: 8 }}>ISS Live</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <div><div style={{ color: T.muted, fontSize: 9 }}>Latitude</div><div style={{ fontFamily: T.mono, color: T.text, fontSize: 12 }}>{parseFloat(data.iss.position?.lat).toFixed(2)}°</div></div>
                <div><div style={{ color: T.muted, fontSize: 9 }}>Longitude</div><div style={{ fontFamily: T.mono, color: T.text, fontSize: 12 }}>{parseFloat(data.iss.position?.lon).toFixed(2)}°</div></div>
              </div>
              <div style={{ color: T.muted, fontSize: 9 }}>Crew aboard: <span style={{ color: T.green }}>{data.iss.crew?.length || "—"}</span></div>
            </EyeCard>
          )}
        </div>

        {/* ── Globe (center) ── */}
        <div style={{ flex: 1, position: "relative" }}>
          <Globe
            data={data}
            satellites={satellites}
            onFacilityClick={controls => { globeControlsRef.current = controls; }}
            onSatClick={setSelectedSat}
          />

          {/* Satellite count badge */}
          {satellites.length > 0 && (
            <div style={{
              position: "absolute", bottom: 12, left: 12,
              fontFamily: T.mono, fontSize: 10, color: T.muted,
              background: `${T.bg}cc`, border: `1px solid ${T.border}`,
              borderRadius: 2, padding: "4px 10px",
            }}>
              <Dot color={T.cyan} />{satellites.length} satellites tracked · click one
            </div>
          )}

          {/* Clicked-satellite info card */}
          {selectedSat && (
            <div style={{
              position: "absolute", bottom: 12, right: 12, width: 240,
              background: `${T.bg}f2`, border: `1px solid ${selectedSat.color || T.cyan}`,
              borderRadius: 4, padding: "12px 14px", boxShadow: `0 0 20px ${selectedSat.color || T.cyan}33`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: selectedSat.color || T.cyan, textTransform: "uppercase" }}>Satellite</div>
                <span onClick={() => setSelectedSat(null)} style={{ cursor: "pointer", color: T.muted, fontSize: 12, lineHeight: 1 }}>✕</span>
              </div>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{selectedSat.name}</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: T.muted, fontSize: 10 }}>Operator</span>
                <span style={{ color: T.text, fontSize: 10, fontFamily: T.mono, textAlign: "right" }}>{selectedSat.operator}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: T.muted, fontSize: 10 }}>Country</span>
                <span style={{ color: T.text, fontSize: 10, fontFamily: T.mono }}>{selectedSat.country}</span>
              </div>
            </div>
          )}

          {/* Overlay: active panel on top of globe if not space */}
          {activePanel === "ops" && (
            <div style={{
              position: "absolute", top: 12, right: 12, width: 280,
              background: `${T.bg}ee`, border: `1px solid ${T.border}`,
              borderRadius: 4, padding: 14, maxHeight: "calc(100% - 24px)", overflowY: "auto",
            }}>
              <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.cyan, textTransform: "uppercase", marginBottom: 12 }}>Operational Intelligence</div>
              <FacilitiesPanel token={token} globeControlsRef={globeControlsRef} />
            </div>
          )}
          {activePanel === "patents" && (
            <div style={{
              position: "absolute", top: 12, right: 12, width: 300,
              background: `${T.bg}ee`, border: `1px solid ${T.border}`,
              borderRadius: 4, padding: 14, maxHeight: "calc(100% - 24px)", overflowY: "auto",
            }}>
              <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.blue, textTransform: "uppercase", marginBottom: 12 }}>Patent Intelligence</div>
              <PatentsPanel token={token} />
            </div>
          )}
        </div>

        {/* ── Right sidebar ── */}
        <div style={{
          width: 260, flexShrink: 0, borderLeft: `1px solid ${T.border}`,
          background: T.surface, overflowY: "auto", padding: 12,
          display: "flex", flexDirection: "column", gap: 16,
        }}>
          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>Upcoming Launches</div>
            <UpcomingLaunches launches={data?.upcoming} />
          </EyeCard>

          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>Launches (30d) by Agency</div>
            <LaunchChart chart={data?.chartData} />
          </EyeCard>

          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 8 }}>Intelligence Feed</div>
            <IntelFeed launches={data?.launches} />
          </EyeCard>
        </div>
      </div>
    </div>
  );
}
