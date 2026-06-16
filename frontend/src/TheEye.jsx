// ───────────────────────────────────────────────────────────────
// frontend/src/TheEye.jsx  — THE EYE  v2
//
// Fixes vs v1:
//  1. Orbital Status — fetched separately (never blank, static fallback)
//  2. Satellite icons — viewer-ready gate prevents race condition
//  3. Operations panel — Haiku + Google News (not hardcoded satellite imagery)
//  4. War zones — colored ellipses only, click→news + stability 0-100%
//  5. New "SATS" tab — satellite data panel + GPSJAM interference overlay
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
  purple:   "#aa44ff",
  text:     "#e8f4ff",
  muted:    "#4a7090",
  font:     "'Space Grotesk', 'DM Sans', system-ui, sans-serif",
  mono:     "'Space Mono', 'DM Mono', monospace",
};

// ─── Tiny primitives ─────────────────────────────────────────────
function EyeCard({ children, style, glow }) {
  return (
    <div style={{
      background: T.surface, border: `1px solid ${glow ? T.cyan : T.border}`,
      borderRadius: 4, padding: "12px 16px",
      boxShadow: glow ? T.cyanGlow : "none", ...style,
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
  const c = color === "green" ? T.green : color === "red" ? T.red : color === "amber" ? T.amber : color === "purple" ? T.purple : T.cyan;
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: c, border: `1px solid ${c}33`, borderRadius: 2, padding: "2px 6px" }}>
      {children}
    </span>
  );
}

// Stability bar: 100=green (stable), 0=red (war zone)
function StabilityBar({ value }) {
  const pct = Math.max(0, Math.min(100, value ?? 50));
  const color = pct >= 60 ? T.green : pct >= 30 ? T.amber : T.red;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Stability</span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color, fontWeight: 700 }}>{pct}%</span>
      </div>
      <div style={{ height: 5, background: `${color}22`, borderRadius: 3 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

// ─── SGP4 propagation (satellite.js CDN → window.satellite) ──────
function propagateSat(satrec, date) {
  try {
    const pv = window.satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = window.satellite.gstime(date);
    const geo   = window.satellite.eciToGeodetic(pv.position, gmst);
    const lat   = window.satellite.degreesLat(geo.latitude);
    const lon   = window.satellite.degreesLong(geo.longitude);
    const alt   = geo.height * 1000; // km → m
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) return null;
    return { lat, lon, alt };
  } catch { return null; }
}

// ─── CesiumJS Globe ──────────────────────────────────────────────
function Globe({ data, satellites, gpsjamZones, showGpsjam, onFacilityClick, onSatClick, onZoneClick, onReady }) {
  const ref           = useRef(null);
  const viewerRef     = useRef(null);
  const dataEntsRef   = useRef([]);
  const satEntsRef    = useRef([]);
  const gpsjamEntsRef = useRef([]);
  const onSatClickRef  = useRef(onSatClick);
  const onZoneClickRef = useRef(onZoneClick);
  onSatClickRef.current  = onSatClick;
  onZoneClickRef.current = onZoneClick;

  // ── Init viewer once ──
  useEffect(() => {
    if (!ref.current || !window.Cesium || viewerRef.current) return;
    if (import.meta.env.VITE_CESIUM_ION_TOKEN) {
      window.Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
    }
    const viewer = new window.Cesium.Viewer(ref.current, {
      animation: false, baseLayerPicker: false, fullscreenButton: false,
      geocoder: false, homeButton: false, infoBox: false, sceneModePicker: false,
      selectionIndicator: false, timeline: false, navigationHelpButton: false,
    });
    (async () => {
      const layers = viewer.imageryLayers;
      try {
        layers.removeAll();
        layers.addImageryProvider(
          await window.Cesium.TileMapServiceImageryProvider.fromUrl(
            window.Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
          )
        );
      } catch { /* keep globe base */ }
      if (import.meta.env.VITE_CESIUM_ION_TOKEN) {
        try { layers.addImageryProvider(await window.Cesium.createWorldImageryAsync()); } catch { }
      }
    })();

    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyBox.show = true;
    viewer.scene.backgroundColor = new window.Cesium.Color(0.01, 0.02, 0.05, 1.0);
    viewer.scene.globe.baseColor  = new window.Cesium.Color(0.02, 0.05, 0.12, 1.0);
    viewer.camera.setView({ destination: window.Cesium.Cartesian3.fromDegrees(20, 20, 20000000) });

    // Unified click handler — sat takes priority, then conflict zone
    const handler = new window.Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      const now = window.Cesium.JulianDate.now();
      const sat  = picked?.id?.properties?.sat?.getValue?.(now);
      const zone = picked?.id?.properties?.zone?.getValue?.(now);
      if (sat  && onSatClickRef.current)  onSatClickRef.current(sat);
      if (zone && onZoneClickRef.current) onZoneClickRef.current(zone);
    }, window.Cesium.ScreenSpaceEventType.LEFT_CLICK);

    viewerRef.current = viewer;
    // Signal viewer is ready so satellite useEffect can (re-)run
    if (onReady) onReady();

    return () => {
      handler.destroy();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) viewerRef.current.destroy();
      viewerRef.current = null;
    };
  }, []); // eslint-disable-line

  // ── Static data markers (ISS / conflict zones / launch pads) ──
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

    // Fix #4 — conflict zones: colored ellipses, NO text labels, click-to-reveal
    (data?.conflicts || []).forEach(c => {
      if (!isFinite(+c.lat) || !isFinite(+c.lon)) return;
      const color  = c.intensity === "high" ? T.red : c.intensity === "medium" ? T.amber : "#ff6666";
      const radius = c.intensity === "high" ? 300000 : 150000;
      add({
        position: window.Cesium.Cartesian3.fromDegrees(+c.lon, +c.lat),
        ellipse: {
          semiMinorAxis: radius, semiMajorAxis: radius,
          material: window.Cesium.Color.fromCssColorString(color).withAlpha(0.22),
          outline: true, outlineColor: window.Cesium.Color.fromCssColorString(color).withAlpha(0.8),
          outlineWidth: 2,
        },
        // properties enable click detection in the handler above
        properties: {
          zone: {
            name: c.name, lat: c.lat, lon: c.lon,
            intensity: c.intensity, events: c.events,
            fatalities: c.fatalities, stability: c.stability,
          },
        },
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

  // ── GPSJAM interference overlay (only when Sats tab active) ──
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !window.Cesium) return;
    gpsjamEntsRef.current.forEach(e => viewer.entities.remove(e));
    gpsjamEntsRef.current = [];
    if (!showGpsjam || !gpsjamZones?.length) return;
    gpsjamZones.forEach(z => {
      if (!isFinite(z.lat) || !isFinite(z.lon)) return;
      const color = z.severity === "high" ? T.purple : "#7733cc";
      const e = viewer.entities.add({
        position: window.Cesium.Cartesian3.fromDegrees(z.lon, z.lat),
        ellipse: {
          semiMinorAxis: z.radius || 250000,
          semiMajorAxis: z.radius || 250000,
          material: window.Cesium.Color.fromCssColorString(color).withAlpha(0.18),
          outline: true, outlineColor: window.Cesium.Color.fromCssColorString(color).withAlpha(0.7),
          outlineWidth: 1,
        },
        label: {
          text: "⚡ " + z.name.split(" ").slice(0, 3).join(" "),
          font: "9px monospace",
          fillColor: window.Cesium.Color.fromCssColorString(color),
          pixelOffset: new window.Cesium.Cartesian2(0, -20),
          showBackground: false,
        },
      });
      gpsjamEntsRef.current.push(e);
    });
  }, [gpsjamZones, showGpsjam]);

  // ── Live satellites (SGP4) ─────────────────────────────────────
  // NOTE: this effect runs when `satellites` changes AND when the viewer
  // becomes ready (parent bumps `satKey` via `viewerReady`). The key is
  // passed as the `key` prop on Globe to force remount if needed, but
  // we handle it here directly by watching the satellites array.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !window.satellite || !satellites?.length) return;
    satEntsRef.current.forEach(({ ent }) => viewer.entities.remove(ent));
    satEntsRef.current = [];
    const recs = [];
    const now  = new Date();
    satellites.forEach(s => {
      let satrec;
      try { satrec = window.satellite.twoline2satrec(s.tle1, s.tle2); } catch { return; }
      const p = propagateSat(satrec, now);
      if (!p) return;
      const ent = viewer.entities.add({
        position: window.Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
        point: {
          pixelSize: s.group === "stations" ? 8 : 4,
          color: window.Cesium.Color.fromCssColorString(s.color || T.cyan),
          outlineColor: window.Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1,
        },
        properties: {
          sat: {
            name: s.name, operator: s.operator, country: s.country,
            group: s.group, color: s.color, noradId: s.noradId, launchDate: s.launchDate,
          },
        },
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

  // Facility markers + flyTo
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
      destination: window.Cesium.Cartesian3.fromDegrees(lon, lat, alt), duration: 2.5,
    });
  }, []);

  useEffect(() => {
    if (onFacilityClick) onFacilityClick({ addFacilityMarkers, flyTo });
  }, [addFacilityMarkers, flyTo, onFacilityClick]);

  return <div ref={ref} style={{ width: "100%", height: "100%", background: T.bg }} />;
}

// ─── GLOBE SEARCH ────────────────────────────────────────────────
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
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
          placeholder="Search TSMC, SpaceX, Taiwan…"
          style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 12, borderRadius: 2, padding: "8px 12px", outline: "none" }} />
        <button onClick={search} style={{ background: T.cyanDim, border: `1px solid ${T.cyan}`, color: T.cyan, fontFamily: T.mono, fontSize: 11, fontWeight: 700, padding: "8px 16px", borderRadius: 2, cursor: "pointer" }}>SCAN</button>
      </div>
      {results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100, marginTop: 4 }}>
          {results.map((r, i) => (
            <div key={i} onClick={() => { onResult(r); setResults([]); }} style={{ background: T.surface, border: `1px solid ${T.border}`, padding: "10px 14px", cursor: "pointer", marginBottom: 2, borderRadius: 2 }}>
              <div style={{ color: T.cyan, fontFamily: T.mono, fontSize: 12, fontWeight: 700 }}>{r.name}</div>
              <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>{r.intel}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── UPCOMING LAUNCHES ────────────────────────────────────────────
function UpcomingLaunches({ launches }) {
  if (!launches?.length) return <div style={{ color: T.muted, fontSize: 11 }}>Loading upcoming launches…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {launches.slice(0, 6).map((l, i) => {
        const days  = l.tMinus ? Math.floor(l.tMinus / 86400000) : null;
        const hours = l.tMinus ? Math.floor((l.tMinus % 86400000) / 3600000) : null;
        return (
          <div key={i} style={{ borderLeft: `2px solid ${T.cyan}33`, paddingLeft: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ color: T.text, fontSize: 11, fontWeight: 600, flex: 1, paddingRight: 8 }}>{l.name}</div>
              {days !== null && <div style={{ fontFamily: T.mono, fontSize: 10, color: days < 3 ? T.cyan : T.muted, whiteSpace: "nowrap" }}>{days === 0 ? `T-${hours}h` : `T-${days}d`}</div>}
            </div>
            <div style={{ color: T.muted, fontSize: 10, marginTop: 2 }}>{l.agency} · {l.rocket} · {l.missionOrbit || "TBD"}</div>
            {l.padLocation && <div style={{ color: T.muted, fontSize: 9, marginTop: 1 }}>📍 {l.padLocation}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── LAUNCH CHART ────────────────────────────────────────────────
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
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 90, fontSize: 9, color: T.muted, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.agency.split(" ")[0]}</div>
            <div style={{ flex: 1, height: 6, background: `${color}22`, borderRadius: 1, overflow: "hidden" }}>
              <div style={{ width: `${(c.launches / max) * 100}%`, height: "100%", background: color, borderRadius: 1 }} />
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
            <Tag color={l.status === "Success" ? "green" : l.status === "Failure" ? "red" : "amber"}>{l.status?.split(" ")[0] || "TBD"}</Tag>
          </div>
        );
      })}
    </div>
  );
}

// ─── OPERATIONS (FACILITIES) PANEL — Haiku + News ────────────────
function FacilitiesPanel({ token, globeControlsRef }) {
  const [facilities, setFacilities] = useState([]);
  const [selected, setSelected]     = useState(null);
  const [analysis, setAnalysis]     = useState(null);
  const [loading, setLoading]       = useState(false);

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
    // Fix #3 — use Haiku + Google News endpoint instead of satellite imagery
    const r = await fetch(`${BACKEND}/api/satellite/ops-news/${f.key}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).catch(e => ({ error: e.message }));
    setAnalysis(r); setLoading(false);
  }

  const signalColor = (s) => s === "bullish" ? "green" : s === "bearish" ? "red" : "amber";

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
        {facilities.map(f => (
          <button key={f.key} onClick={() => analyze(f)} style={{
            background: selected === f.key ? T.cyanDim : "transparent",
            border: `1px solid ${selected === f.key ? T.cyan : T.border}`,
            color: selected === f.key ? T.cyan : T.muted,
            fontFamily: T.mono, fontSize: 9, fontWeight: 700,
            padding: "6px 8px", borderRadius: 2, cursor: "pointer", textAlign: "left",
          }}>
            {f.company}<br /><span style={{ color: T.muted, fontWeight: 400 }}>{f.region}</span>
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono, display: "flex", alignItems: "center", gap: 8 }}>
          <Dot color={T.amber} /> Fetching news · running Haiku analysis…
        </div>
      )}

      {analysis && !loading && !analysis.error && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
          <div style={{ color: T.cyan, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{analysis.facility}</div>
          <div style={{ color: T.muted, fontSize: 9, marginBottom: 10 }}>{analysis.region} · {analysis.headlines?.length || 0} articles analyzed</div>

          {analysis.source === "no_news" ? (
            <div style={{ color: T.amber, fontSize: 10 }}>⚠ No recent news found for this facility.</div>
          ) : analysis.analysis ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ color: T.text, fontSize: 10, lineHeight: 1.6 }}>{analysis.analysis.summary}</div>

              {analysis.analysis.keyDevelopments?.length > 0 && (
                <div>
                  <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Key Developments</div>
                  {analysis.analysis.keyDevelopments.map((d, i) => (
                    <div key={i} style={{ fontSize: 10, color: T.text, paddingLeft: 8, borderLeft: `2px solid ${T.cyan}44`, marginBottom: 4, lineHeight: 1.4 }}>→ {d}</div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", justifyContent: "space-between", flex: 1, minWidth: 120 }}>
                  <span style={{ color: T.muted, fontSize: 10 }}>Status</span>
                  <Tag color="cyan">{analysis.analysis.operationalStatus || "unknown"}</Tag>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", flex: 1, minWidth: 120 }}>
                  <span style={{ color: T.muted, fontSize: 10 }}>Signal</span>
                  <Tag color={signalColor(analysis.analysis.investmentSignal)}>{analysis.analysis.investmentSignal || "neutral"}</Tag>
                </div>
              </div>

              {analysis.analysis.rationale && (
                <div style={{ color: T.muted, fontSize: 9, lineHeight: 1.5, borderLeft: `2px solid ${T.cyan}22`, paddingLeft: 8 }}>
                  {analysis.analysis.rationale}
                </div>
              )}

              {analysis.analysis.riskFactors?.length > 0 && (
                <div>
                  <div style={{ fontSize: 9, color: T.red, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Risk Factors</div>
                  {analysis.analysis.riskFactors.map((r, i) => (
                    <div key={i} style={{ fontSize: 9, color: T.muted, marginBottom: 2 }}>⚠ {r}</div>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 9, color: T.muted }}>
                Confidence: <span style={{ color: T.text }}>{Math.round((analysis.analysis.confidence || 0.6) * 100)}%</span>
                {" · "}Haiku (news-based · ~$0.002)
              </div>

              {analysis.headlines?.slice(0, 4).map((h, i) => (
                <div key={i} style={{ fontSize: 9, color: T.muted, borderLeft: `2px solid ${T.border}`, paddingLeft: 8, lineHeight: 1.4 }}>
                  [{h.daysAgo}d] {h.title}
                </div>
              ))}
            </div>
          ) : null}

          {analysis.error && (
            <div style={{ color: T.red, fontSize: 10 }}>Error: {analysis.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CONFLICT ZONE PANEL — Fix #4: click→news + stability ────────
function ConflictZonePanel({ zone, token, onClose }) {
  const [news, setNews]   = useState([]);
  const [loading, setLd]  = useState(true);

  useEffect(() => {
    if (!zone) return;
    setLd(true); setNews([]);
    fetch(`${BACKEND}/api/space/zone-news?q=${encodeURIComponent(zone.name)}&days=14`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => { setNews(Array.isArray(d) ? d : []); setLd(false); })
      .catch(() => setLd(false));
  }, [zone, token]);

  if (!zone) return null;
  const borderColor = zone.intensity === "high" ? T.red : T.amber;

  return (
    <div style={{
      position: "absolute", top: 12, left: 12, width: 280, zIndex: 10,
      background: `${T.bg}f0`, border: `1px solid ${borderColor}`,
      borderRadius: 4, padding: 14, maxHeight: "calc(100% - 24px)", overflowY: "auto",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: borderColor, textTransform: "uppercase", marginBottom: 4 }}>
            {zone.intensity === "high" ? "⚠ HIGH INTENSITY" : "⚠ MEDIUM INTENSITY"}
          </div>
          <div style={{ color: T.text, fontSize: 14, fontWeight: 700 }}>{zone.name}</div>
        </div>
        <span onClick={onClose} style={{ cursor: "pointer", color: T.muted, fontSize: 14, lineHeight: 1 }}>✕</span>
      </div>

      <StabilityBar value={zone.stability} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12, marginBottom: 12 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.red }}>{zone.events ?? "—"}</div>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Events (30d)</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.red }}>{zone.fatalities ?? "—"}</div>
          <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Fatalities</div>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
        <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Recent Intelligence</div>
        {loading && <div style={{ color: T.muted, fontSize: 10 }}>Fetching news…</div>}
        {!loading && news.length === 0 && <div style={{ color: T.muted, fontSize: 10 }}>No recent headlines found.</div>}
        {news.map((item, i) => (
          <div key={i} style={{ marginBottom: 8, paddingLeft: 8, borderLeft: `2px solid ${borderColor}44` }}>
            <div style={{ fontSize: 10, color: T.text, lineHeight: 1.4 }}>{item.title}</div>
            <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>{item.daysAgo}d ago</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 8, fontSize: 9, color: T.muted }}>
        Source: ACLED · Google News · Stability: Beta-Bernoulli (30d rolling)
      </div>
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
      fetch(`${BACKEND}/api/patents/search?q=${encodeURIComponent(q)}&limit=5`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`${BACKEND}/api/patents/landscape?tech=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]);
    setResults(patents.status === "fulfilled" ? patents.value : []);
    setLandscape(land.status === "fulfilled" ? land.value : null);
    setLoading(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
          placeholder="Search patents: 'semiconductor lithography'"
          style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono, fontSize: 11, borderRadius: 2, padding: "7px 10px", outline: "none" }} />
        <button onClick={search} style={{ background: T.cyanDim, border: `1px solid ${T.cyan}`, color: T.cyan, fontFamily: T.mono, fontSize: 10, fontWeight: 700, padding: "7px 12px", borderRadius: 2, cursor: "pointer" }}>SCAN</button>
      </div>
      {loading && <div style={{ color: T.muted, fontSize: 11, fontFamily: T.mono }}>Scanning USPTO…</div>}
      {landscape && !loading && (
        <div>
          <div style={{ color: T.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Patent landscape · {landscape.totalPatents?.toLocaleString()} total</div>
          {(landscape.landscape || []).slice(0, 5).map((c, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 9, color: T.muted, width: 80, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.company.split(" ")[0]}</div>
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

// ─── SATS PANEL — Fix #5: right sidebar when "SATS" tab active ───
function SatsPanel({ satellites, gpsjamZones }) {
  const [sortKey, setSortKey] = useState("country");

  const byCountry = {};
  satellites.forEach(s => { byCountry[s.country] = (byCountry[s.country] || 0) + 1; });
  const countrySummary = Object.entries(byCountry).sort((a, b) => b[1] - a[1]);

  const sorted = [...satellites].sort((a, b) => {
    if (sortKey === "country") return (a.country || "").localeCompare(b.country || "");
    if (sortKey === "name")    return (a.name || "").localeCompare(b.name || "");
    if (sortKey === "days")    return (b.launchDate ? new Date(b.launchDate) : 0) - (a.launchDate ? new Date(a.launchDate) : 0);
    return 0;
  });

  function formatAge(launchDate) {
    if (!launchDate) return null;
    const days = Math.floor((Date.now() - new Date(launchDate)) / 86400000);
    if (days <= 0) return "new";
    if (days < 365) return `${days}d`;
    return `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}m`;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Country breakdown */}
      <EyeCard>
        <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 10 }}>By Country</div>
        {countrySummary.slice(0, 8).map(([country, count], i) => {
          const max = countrySummary[0][1];
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ width: 70, fontSize: 9, color: T.muted, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{country}</div>
              <div style={{ flex: 1, height: 5, background: `${T.cyan}22`, borderRadius: 1 }}>
                <div style={{ width: `${(count / max) * 100}%`, height: "100%", background: T.cyan, borderRadius: 1 }} />
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.cyan, width: 24, textAlign: "right" }}>{count}</div>
            </div>
          );
        })}
      </EyeCard>

      {/* Satellite data table */}
      <EyeCard>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase" }}>
            {satellites.length} Tracked Objects
          </div>
          <select value={sortKey} onChange={e => setSortKey(e.target.value)} style={{
            background: T.surface, border: `1px solid ${T.border}`, color: T.muted,
            fontFamily: T.mono, fontSize: 9, borderRadius: 2, padding: "2px 4px", cursor: "pointer",
          }}>
            <option value="country">By Country</option>
            <option value="name">By Name</option>
            <option value="days">By Age</option>
          </select>
        </div>
        <div style={{ overflowY: "auto", maxHeight: 280 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: T.mono }}>
            <thead>
              <tr style={{ color: T.muted, textTransform: "uppercase", fontSize: 8 }}>
                <th style={{ textAlign: "left", padding: "2px 4px", fontWeight: 700 }}>Name</th>
                <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 700 }}>NORAD</th>
                <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 700 }}>Age</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${T.border}` }}>
                  <td style={{ padding: "4px 4px", color: T.text }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{s.name}</div>
                    <div style={{ color: T.muted, fontSize: 8 }}>{s.country}</div>
                  </td>
                  <td style={{ padding: "4px 4px", color: T.muted, textAlign: "right" }}>{s.noradId || "—"}</td>
                  <td style={{ padding: "4px 4px", color: s.launchDate ? T.cyan : T.muted, textAlign: "right" }}>
                    {formatAge(s.launchDate) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </EyeCard>

      {/* GPSJAM interference zones */}
      {gpsjamZones?.length > 0 && (
        <EyeCard>
          <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.purple, textTransform: "uppercase", marginBottom: 10 }}>
            ⚡ GPS/GNSS Interference
          </div>
          <div style={{ fontSize: 9, color: T.muted, marginBottom: 8, lineHeight: 1.4 }}>
            Purple overlay on globe · kinetic warfare / electronic warfare zones
          </div>
          {gpsjamZones.map((z, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 10, color: T.text }}>{z.name}</div>
                <div style={{ fontSize: 9, color: T.muted }}>{(z.type || "gnss_jam").replace("gnss_", "").toUpperCase()}</div>
              </div>
              <Tag color={z.severity === "high" ? "red" : "amber"}>{z.severity}</Tag>
            </div>
          ))}
        </EyeCard>
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────
export default function TheEye({ token }) {
  const [fullscreen, setFullscreen]     = useState(false);
  const [activePanel, setActivePanel]   = useState("space");
  const [data, setData]                 = useState(null);
  const [catalogStats, setCatalogStats] = useState(null);  // Fix #1: independent fetch
  const [satellites, setSatellites]     = useState([]);
  const [gpsjamZones, setGpsjamZones]   = useState([]);    // Fix #5: GPSJAM data
  const [selectedSat, setSelectedSat]   = useState(null);
  const [activeZone, setActiveZone]     = useState(null);  // Fix #4: clicked conflict zone
  const [loading, setLoading]           = useState(true);
  const [viewerReady, setViewerReady]   = useState(false); // Fix #2: viewer race gate
  const globeControlsRef                = useRef(null);

  // Overview (launches, ISS, conflicts, basic catalog fallback)
  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/space/overview`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  // Fix #1 — separate, independent catalog fetch (never blocked by slow SATCAT)
  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/space/catalog`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { if (d && !d.error) setCatalogStats(d); })
      .catch(() => {});
  }, [token]);

  // Live satellites (SGP4 propagated in Globe)
  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/space/satellites`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setSatellites(Array.isArray(d) ? d : [])).catch(() => {});
  }, [token]);

  // GPSJAM interference zones
  useEffect(() => {
    if (!token) return;
    fetch(`${BACKEND}/api/space/gpsjam`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setGpsjamZones(Array.isArray(d) ? d : [])).catch(() => {});
  }, [token]);

  // Fix #2 — after viewer signals ready, bump satellite key so the Globe
  // satellite effect re-runs even if satellites were already loaded
  const [satKey, setSatKey] = useState(0);
  const handleViewerReady = useCallback(() => {
    setViewerReady(true);
    setSatKey(k => k + 1);
  }, []);

  function handleSearchResult(result) {
    if (!globeControlsRef.current) return;
    const { addFacilityMarkers, flyTo } = globeControlsRef.current;
    if (result.locations?.length > 0) {
      addFacilityMarkers(result.locations);
      flyTo(result.locations[0].lat, result.locations[0].lon, 1500000);
    }
  }

  // Merge catalog stats: prefer the separately-fetched ones; fall back to overview
  const catalog = catalogStats || data?.catalog || {};
  const stats   = data?.stats  || {};

  // ── Splash screen ──
  if (!fullscreen) {
    return (
      <div style={{ fontFamily: T.font }}>
        <div style={{
          background: `linear-gradient(135deg, ${T.bg} 0%, #030b1a 100%)`,
          border: `1px solid ${T.border}`, borderRadius: 8, padding: 32,
          textAlign: "center", position: "relative", overflow: "hidden",
        }}>
          <div style={{ position: "absolute", inset: 0, backgroundImage: `linear-gradient(${T.border} 1px, transparent 1px), linear-gradient(90deg, ${T.border} 1px, transparent 1px)`, backgroundSize: "40px 40px", opacity: 0.3 }} />
          <div style={{ position: "relative" }}>
            <div style={{ fontSize: 11, fontFamily: T.mono, letterSpacing: "0.3em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>Meridian Intelligence Platform</div>
            <div style={{ fontSize: 52, fontWeight: 900, color: T.text, letterSpacing: -2, lineHeight: 1, marginBottom: 4 }}>THE EYE</div>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 32, lineHeight: 1.6 }}>
              Global space intelligence · Operational satellite imagery<br />
              Patent landscape · Conflict monitoring · GNSS interference
            </div>
            <button onClick={() => setFullscreen(true)} style={{
              background: "transparent", border: `1px solid ${T.cyan}`, color: T.cyan,
              fontFamily: T.mono, fontSize: 12, fontWeight: 700, letterSpacing: "0.2em",
              textTransform: "uppercase", padding: "14px 40px", borderRadius: 2,
              cursor: "pointer", boxShadow: T.cyanGlow,
            }}>ENTER THE EYE →</button>
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
          background: "transparent", border: `1px solid ${T.border}`, color: T.muted,
          fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: "0.15em",
          padding: "4px 12px", borderRadius: 2, cursor: "pointer", flexShrink: 0,
        }}>← LEAVE</button>

        <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: "0.2em", color: T.cyan }}>THE EYE</div>

        {/* Fix #5: added SATS tab */}
        <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {[
            ["space",   "SPACE INTEL", T.cyan],
            ["ops",     "OPERATIONS",  T.cyan],
            ["patents", "PATENTS",     T.cyan],
            ["sats",    "SATS",        T.purple],
          ].map(([id, label, accent]) => (
            <button key={id} onClick={() => { setActivePanel(id); setActiveZone(null); }} style={{
              background: activePanel === id ? `${accent}22` : "transparent",
              border: `1px solid ${activePanel === id ? accent : T.border}`,
              color: activePanel === id ? accent : T.muted,
              fontFamily: T.mono, fontSize: 9, fontWeight: 700,
              letterSpacing: "0.12em", padding: "4px 12px", borderRadius: 2, cursor: "pointer",
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
          {/* Fix #1: orbital status uses catalogStats (independent fetch, with static fallback) */}
          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>Orbital Status</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <StatBox label="Objects"     value={catalog.total?.toLocaleString()} />
              <StatBox label="Active Sats" value={catalog.active?.toLocaleString()} color={T.green} />
              <StatBox label="Debris"      value={catalog.debris?.toLocaleString()} color={T.red} />
              <StatBox label="Countries"   value={catalog.countriesWithAssets}     color={T.amber} />
            </div>
          </EyeCard>

          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 12 }}>Launch Activity</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <StatBox label="This Year" value={stats.totalThisYear} />
              <StatBox label="Upcoming"  value={data?.upcoming?.length} color={T.cyan} />
            </div>
          </EyeCard>

          <EyeCard>
            <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.muted, textTransform: "uppercase", marginBottom: 8 }}>Globe Search</div>
            <GlobeSearch token={token} onResult={handleSearchResult} />
          </EyeCard>

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

          {/* SATS tab quick stats in left sidebar */}
          {activePanel === "sats" && (
            <EyeCard>
              <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.purple, textTransform: "uppercase", marginBottom: 8 }}>GNSS Status</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <StatBox label="Tracked" value={satellites.length}  color={T.purple} />
                <StatBox label="Jam Zones" value={gpsjamZones.length} color={T.red} />
              </div>
            </EyeCard>
          )}
        </div>

        {/* ── Globe (center) ── */}
        <div style={{ flex: 1, position: "relative" }}>
          {/* Fix #2: key=satKey forces Globe to re-mount satellites after viewerReady */}
          <Globe
            key={`globe-${satKey}`}
            data={data}
            satellites={satellites}
            gpsjamZones={gpsjamZones}
            showGpsjam={activePanel === "sats"}
            onFacilityClick={controls => { globeControlsRef.current = controls; }}
            onSatClick={setSelectedSat}
            onZoneClick={setActiveZone}   // Fix #4
            onReady={handleViewerReady}   // Fix #2
          />

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

          {/* Fix #4: Conflict zone detail panel (replaces text labels on map) */}
          {activeZone && (
            <ConflictZonePanel zone={activeZone} token={token} onClose={() => setActiveZone(null)} />
          )}

          {/* Clicked-satellite info card */}
          {selectedSat && !activeZone && (
            <div style={{
              position: "absolute", bottom: 12, right: 12, width: 240,
              background: `${T.bg}f2`, border: `1px solid ${selectedSat.color || T.cyan}`,
              borderRadius: 4, padding: "12px 14px",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: selectedSat.color || T.cyan, textTransform: "uppercase" }}>Satellite</div>
                <span onClick={() => setSelectedSat(null)} style={{ cursor: "pointer", color: T.muted, fontSize: 12 }}>✕</span>
              </div>
              <div style={{ color: T.text, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{selectedSat.name}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: T.muted, fontSize: 10 }}>Operator</span>
                  <span style={{ color: T.text, fontSize: 10, fontFamily: T.mono }}>{selectedSat.operator}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: T.muted, fontSize: 10 }}>Country</span>
                  <span style={{ color: T.text, fontSize: 10, fontFamily: T.mono }}>{selectedSat.country}</span>
                </div>
                {selectedSat.noradId && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: T.muted, fontSize: 10 }}>NORAD ID</span>
                    <span style={{ color: T.text, fontSize: 10, fontFamily: T.mono }}>{selectedSat.noradId}</span>
                  </div>
                )}
                {selectedSat.launchDate && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: T.muted, fontSize: 10 }}>Launch</span>
                    <span style={{ color: T.text, fontSize: 10, fontFamily: T.mono }}>{selectedSat.launchDate}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Ops overlay */}
          {activePanel === "ops" && (
            <div style={{
              position: "absolute", top: 12, right: 12, width: 280,
              background: `${T.bg}ee`, border: `1px solid ${T.border}`,
              borderRadius: 4, padding: 14, maxHeight: "calc(100% - 24px)", overflowY: "auto",
            }}>
              <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.cyan, textTransform: "uppercase", marginBottom: 12 }}>
                Operational Intelligence
              </div>
              <FacilitiesPanel token={token} globeControlsRef={globeControlsRef} />
            </div>
          )}

          {/* Patents overlay */}
          {activePanel === "patents" && (
            <div style={{
              position: "absolute", top: 12, right: 12, width: 300,
              background: `${T.bg}ee`, border: `1px solid ${T.border}`,
              borderRadius: 4, padding: 14, maxHeight: "calc(100% - 24px)", overflowY: "auto",
            }}>
              <div style={{ fontSize: 9, fontFamily: T.mono, letterSpacing: "0.15em", color: T.blue, textTransform: "uppercase", marginBottom: 12 }}>
                Patent Intelligence
              </div>
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
          {/* Fix #5: SATS tab swaps in SatsPanel; other tabs show launches */}
          {activePanel === "sats" ? (
            <SatsPanel satellites={satellites} gpsjamZones={gpsjamZones} />
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
