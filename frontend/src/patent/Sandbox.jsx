// frontend/src/patent/Sandbox.jsx
// Patent Sandbox — Three.js free-roam CAD-style schematic viewer.
// ⚠ Schematic only — NOT real engineering CAD. Parts are representative
//   3D primitives derived from the patent's described design components.
//
// Controls: left-drag orbit · right-drag pan · scroll zoom
// Toolbar:  Select · Move (G) · Rotate (R) · Scale (S) · Wireframe · Explode · Reset
// Boss William: AI assistant docked in the side panel, explains clicked parts.
//
// TODO: ontology ingestion hook — a loaded PatentEvent can later be pushed
// into the digital-twin graph when the ingestion layer is built.

import { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ─── Geometry heuristic from cadHint / component name ────────────
// Representative primitive only — NOT a real CAD reconstruction.
function pickGeometry(component, cadHint) {
  const s = `${component} ${cadHint || ""}`.toLowerCase();
  // cylindrical
  if (/shaft|rod|tube|pipe|cylinder|column|barrel|axle|spindle|pin|pole|stem|duct|channel|bore/.test(s))
    return new THREE.CylinderGeometry(0.1, 0.1, 0.9, 24);
  // capsule-like (battery, cell, actuator, piston)
  if (/battery|cell|capacitor|actuator|piston|cartridge|capsule|valve/.test(s))
    return new THREE.CapsuleGeometry(0.16, 0.5, 8, 16);
  // spherical
  if (/dome|lens|ball|sphere|globe|bubble|node|bearing|optic/.test(s))
    return new THREE.SphereGeometry(0.3, 24, 16);
  // toroidal (rings, coils, gears, seals)
  if (/ring|coil|torus|loop|gasket|seal|o-ring|winding|gear|rotor|stator/.test(s))
    return new THREE.TorusGeometry(0.24, 0.07, 12, 28);
  // flat plate / pcb / wafer / membrane
  if (/plate|board|sheet|panel|layer|wafer|substrate|membrane|film|fin|pcb|chip|die|electrode|anode|cathode/.test(s))
    return new THREE.BoxGeometry(0.95, 0.06, 0.7);
  // cone / nozzle
  if (/cone|nozzle|tip|funnel|horn|taper|antenna/.test(s))
    return new THREE.ConeGeometry(0.22, 0.6, 20);
  // housing / enclosure / frame → larger box
  if (/hous|enclos|case|cabinet|frame|chassis|body|shell|block|module|unit/.test(s))
    return new THREE.BoxGeometry(0.72, 0.6, 0.72);
  // default: medium box
  return new THREE.BoxGeometry(0.5, 0.5, 0.5);
}

// ─── Floating name label (canvas sprite) so each part is identifiable ──
function makeLabel(text) {
  const label = (text || "part").length > 22 ? text.slice(0, 21) + "…" : (text || "part");
  const fontSize = 44, pad = 10;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");
  ctx.font = `bold ${fontSize}px sans-serif`;
  const textW = Math.ceil(ctx.measureText(label).width);
  canvas.width = textW + pad * 2;
  canvas.height = fontSize + pad * 2;
  ctx = canvas.getContext("2d");
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = "rgba(10,10,15,0.85)";
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(0, 0, canvas.width, canvas.height, 14); ctx.fill(); }
  else ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e2e8f0";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pad, canvas.height / 2 + 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.004;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  sprite.position.set(0, 0.7, 0);
  sprite.renderOrder = 999;
  sprite.userData.isLabel = true;
  return sprite;
}

// Palette — one colour per part index, vivid but themeable
const PART_COLORS = [
  0x7c3aed, 0x0891b2, 0x059669, 0xd97706, 0xdc2626,
  0x7c3aed, 0x0ea5e9, 0x10b981, 0xf59e0b, 0xef4444,
];
const SELECTED_COLOR    = 0x00d4ff;
const WIREFRAME_COLOR   = 0x334155;
const GRID_COLOR_CENTER = 0x7c3aed;
const GRID_COLOR_GRID   = 0x1e293b;

// ─── Build scene meshes from designComponents ────────────────────
function buildAssembly(components) {
  const meshes = [];
  const total  = components.length;
  const cols   = Math.ceil(Math.sqrt(total));
  const spacing = 1.4;

  components.forEach((comp, i) => {
    const col   = i % cols;
    const row   = Math.floor(i / cols);
    const x     = (col - (cols - 1) / 2) * spacing;
    const z     = (row - Math.floor(total / cols) / 2) * spacing;

    const geo  = pickGeometry(comp.component, comp.cadHint);
    const mat  = new THREE.MeshStandardMaterial({
      color: PART_COLORS[i % PART_COLORS.length],
      roughness: 0.45, metalness: 0.35,
      transparent: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0, z);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;

    // Floating label so every part is identifiable at a glance
    mesh.add(makeLabel(comp.component));

    // Store component metadata on the mesh for picking + Boss William
    mesh.userData = {
      componentIndex: i,
      component:  comp.component,
      function:   comp.function,
      cadHint:    comp.cadHint,
      baseColor:  PART_COLORS[i % PART_COLORS.length],
      basePosition: new THREE.Vector3(x, 0, z),
    };

    meshes.push(mesh);
  });
  return meshes;
}

// ─── Boss William avatar (image with graceful fallback) ─────────
// Drop an image at frontend/public/boss-william.png to use a custom portrait.
function BossAvatar({ size = 36 }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div style={{
        width: size, height: size, borderRadius: "50%",
        background: "linear-gradient(135deg, #7c3aed, #0891b2)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 900, color: "#fff", fontSize: size * 0.4, flexShrink: 0,
      }}>W</div>
    );
  }
  return (
    <img
      src="/boss-william.png"
      alt="Boss William"
      onError={() => setFailed(true)}
      style={{
        width: size, height: size, borderRadius: "50%", objectFit: "cover",
        flexShrink: 0, border: "2px solid rgba(124,58,237,0.4)",
        background: "#0a0a0f",
      }}
    />
  );
}

// ─── Boss William panel ──────────────────────────────────────────
function BossWilliam({ part, patentEvent, token, loading, explanation, onAsk }) {
  const isNoKey = explanation?.includes("ANTHROPIC_API_KEY not set");

  return (
    <div style={{
      width: 260, flexShrink: 0, borderLeft: "1px solid var(--border)",
      background: "var(--card)", display: "flex", flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        <BossAvatar size={36} />
        <div>
          <p style={{ fontWeight: 800, fontSize: 12, color: "var(--text)", lineHeight: 1.2 }}>Boss William</p>
          <p style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1 }}>Engineering mentor</p>
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Intro */}
        {patentEvent && !part && (
          <div style={{ background: "rgba(124,58,237,0.08)", border: "1px solid rgba(124,58,237,0.2)", borderRadius: 10, padding: "12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
            <BossAvatar size={64} />
            <p style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.6 }}>
              Alright, here's <strong>{patentEvent.title}</strong>. Click any part and I'll walk you through what it does and why it matters!
            </p>
          </div>
        )}

        {!patentEvent && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center", paddingTop: 8 }}>
            <BossAvatar size={64} />
            <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
              Load a patent from the Feed (or enter a number below) and I'll guide you through the 3D schematic — click any part to learn about it.
            </p>
          </div>
        )}

        {/* Selected part display */}
        {part && (
          <div style={{ background: "rgba(124,58,237,0.1)", border: "1px solid rgba(124,58,237,0.3)", borderRadius: 10, padding: "8px 12px" }}>
            <p style={{ fontSize: 9, color: "#7c3aed", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>Selected Part</p>
            <p style={{ fontSize: 12, color: "var(--text)", fontWeight: 700 }}>{part.component}</p>
          </div>
        )}

        {/* Explanation */}
        {loading && part && (
          <p style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>Boss William is thinking…</p>
        )}

        {explanation && !loading && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" }}>
            {isNoKey ? (
              <>
                <p style={{ fontSize: 10, color: "#f59e0b", fontWeight: 600, marginBottom: 4 }}>⚠ AI explanations unavailable</p>
                <p style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.5 }}>Set ANTHROPIC_API_KEY in the backend environment to enable Boss William's part explanations.</p>
                <p style={{ fontSize: 10, color: "var(--text)", lineHeight: 1.5, marginTop: 6 }}>
                  <strong>{part?.component}:</strong> {part?.function || "part of the assembly."}
                </p>
              </>
            ) : (
              <p style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.7 }}>{explanation}</p>
            )}
          </div>
        )}
      </div>

      {/* Schematic disclaimer */}
      <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", background: "rgba(124,58,237,0.04)" }}>
        <p style={{ fontSize: 9, color: "var(--muted)", lineHeight: 1.4 }}>
          ⊞ Schematic / representational model built from the patent's described components — not real engineering CAD.
        </p>
      </div>
    </div>
  );
}

// ─── Toolbar ────────────────────────────────────────────────────
function Toolbar({ mode, setMode, wireframe, setWireframe, exploded, setExploded, onReset, hasAssembly }) {
  const tools = [
    { id: "select",    label: "Select",    key: "Q" },
    { id: "translate", label: "Move",      key: "G" },
    { id: "rotate",    label: "Rotate",    key: "R" },
    { id: "scale",     label: "Scale",     key: "S" },
  ];
  return (
    <div style={{
      display: "flex", gap: 4, padding: "6px 10px",
      background: "var(--card)", borderBottom: "1px solid var(--border)", flexWrap: "wrap",
      alignItems: "center",
    }}>
      {tools.map(t => (
        <button
          key={t.id}
          onClick={() => setMode(t.id)}
          title={`${t.label} (${t.key})`}
          disabled={t.id !== "select" && !hasAssembly}
          style={{
            background: mode === t.id ? "rgba(124,58,237,0.15)" : "transparent",
            border: `1px solid ${mode === t.id ? "rgba(124,58,237,0.5)" : "var(--border)"}`,
            color: mode === t.id ? "#a78bfa" : "var(--muted)",
            borderRadius: 8, padding: "4px 10px", cursor: "pointer",
            fontSize: 11, fontWeight: 600,
          }}
        >
          {t.label} <span style={{ opacity: 0.5, fontSize: 9 }}>{t.key}</span>
        </button>
      ))}
      <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 2px" }} />
      <button
        onClick={() => setWireframe(w => !w)}
        disabled={!hasAssembly}
        style={{
          background: wireframe ? "rgba(14,165,233,0.15)" : "transparent",
          border: `1px solid ${wireframe ? "rgba(14,165,233,0.5)" : "var(--border)"}`,
          color: wireframe ? "#38bdf8" : "var(--muted)",
          borderRadius: 8, padding: "4px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600,
        }}
      >Wireframe</button>
      <button
        onClick={() => setExploded(e => !e)}
        disabled={!hasAssembly}
        style={{
          background: exploded ? "rgba(5,150,105,0.15)" : "transparent",
          border: `1px solid ${exploded ? "rgba(5,150,105,0.5)" : "var(--border)"}`,
          color: exploded ? "#34d399" : "var(--muted)",
          borderRadius: 8, padding: "4px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600,
        }}
      >Explode</button>
      <button
        onClick={onReset}
        style={{
          background: "transparent",
          border: "1px solid var(--border)",
          color: "var(--muted)",
          borderRadius: 8, padding: "4px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600,
          marginLeft: "auto",
        }}
      >⟲ Reset View</button>
    </div>
  );
}

// ─── Main Sandbox ────────────────────────────────────────────────
export default function Sandbox({ token, initialPatent, recentlyViewed = [] }) {
  const containerRef      = useRef(null);
  const canvasRef         = useRef(null);
  const rendererRef       = useRef(null);
  const sceneRef          = useRef(null);
  const cameraRef         = useRef(null);
  const orbitRef          = useRef(null);
  const transformRef      = useRef(null);
  const meshesRef         = useRef([]);
  const rafRef            = useRef(null);
  const animExplodeRef    = useRef(null);

  const [mode, setMode]           = useState("select");
  const [wireframe, setWireframe] = useState(false);
  const [exploded, setExploded]   = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [patentEvent, setPatentEvent] = useState(initialPatent || null);
  const [loadInput, setLoadInput] = useState("");
  const [loadLoading, setLoadLoading] = useState(false);
  const [loadErr, setLoadErr]     = useState(null);

  // Boss William state
  const [bwPart, setBwPart]           = useState(null);
  const [bwLoading, setBwLoading]     = useState(false);
  const [bwExplanation, setBwExplanation] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── Fullscreen toggle ────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  }, []);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // ── Init Three.js scene ──────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x0a0a0f);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0f, 18, 35);
    sceneRef.current = scene;

    // Camera
    const w = canvas.clientWidth, h = canvas.clientHeight || 500;
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.set(0, 4, 7);
    cameraRef.current = camera;

    // Grid floor (infinite-feel)
    const grid = new THREE.GridHelper(40, 40, GRID_COLOR_CENTER, GRID_COLOR_GRID);
    grid.position.y = -0.5;
    scene.add(grid);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(5, 10, 6);
    key.castShadow = true;
    key.shadow.mapSize.width  = 1024;
    key.shadow.mapSize.height = 1024;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8080ff, 0.35);
    fill.position.set(-5, 3, -5);
    scene.add(fill);

    // OrbitControls
    const orbit = new OrbitControls(camera, canvas);
    orbit.enableDamping   = true;
    orbit.dampingFactor   = 0.08;
    orbit.screenSpacePanning = false;
    orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    orbitRef.current = orbit;

    // TransformControls
    const transform = new TransformControls(camera, canvas);
    transform.addEventListener("dragging-changed", e => {
      orbit.enabled = !e.value;
    });
    scene.add(transform);
    transformRef.current = transform;

    // Resize
    function onResize() {
      const w = canvas.clientWidth, h = canvas.clientHeight || 500;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    window.addEventListener("resize", onResize);
    // ResizeObserver keeps the canvas correct on fullscreen / layout changes
    const ro = new ResizeObserver(() => onResize());
    ro.observe(canvas);
    onResize();

    // Animation loop
    function animate() {
      rafRef.current = requestAnimationFrame(animate);
      orbit.update();
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      orbit.dispose();
      transform.dispose();
      renderer.dispose();
    };
  }, []); // eslint-disable-line

  // ── Mode → TransformControls ─────────────────────────────────
  useEffect(() => {
    const tc = transformRef.current;
    if (!tc) return;
    if (mode === "select") { tc.detach(); }
    else {
      tc.setMode(mode);  // "translate" | "rotate" | "scale"
      const mesh = meshesRef.current[selectedIdx];
      if (mesh) tc.attach(mesh);
    }
  }, [mode, selectedIdx]);

  // ── Keyboard shortcuts ────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "g" || e.key === "G") setMode("translate");
      if (e.key === "r" || e.key === "R") setMode("rotate");
      if (e.key === "s" || e.key === "S") setMode("scale");
      if (e.key === "Escape")             setMode("select");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Wireframe toggle ─────────────────────────────────────────
  useEffect(() => {
    meshesRef.current.forEach(m => {
      m.material.wireframe = wireframe;
      if (wireframe) m.material.color.setHex(WIREFRAME_COLOR);
      else           m.material.color.setHex(
        selectedIdx === m.userData.componentIndex ? SELECTED_COLOR : m.userData.baseColor
      );
    });
  }, [wireframe, selectedIdx]);

  // ── Explode / collapse ────────────────────────────────────────
  useEffect(() => {
    if (animExplodeRef.current) cancelAnimationFrame(animExplodeRef.current);
    const meshes = meshesRef.current;
    if (!meshes.length) return;
    const SPREAD = 1.6;
    const targets = meshes.map(m => {
      const bp = m.userData.basePosition;
      const dir = bp.clone().normalize();
      return exploded
        ? bp.clone().addScaledVector(dir, SPREAD)
        : bp.clone();
    });
    let t = 0;
    function step() {
      t += 0.04;
      if (t >= 1) t = 1;
      meshes.forEach((m, i) => m.position.lerpVectors(m.position, targets[i], 0.12));
      if (t < 1) animExplodeRef.current = requestAnimationFrame(step);
    }
    step();
  }, [exploded]);

  // ── Raycaster click (select part) ────────────────────────────
  const onCanvasClick = useCallback(e => {
    if (mode !== "select") return;
    const canvas  = canvasRef.current;
    const camera  = cameraRef.current;
    const meshes  = meshesRef.current;
    if (!canvas || !camera || !meshes.length) return;

    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left)  / rect.width)  * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(meshes, false);

    // Deselect previous
    if (meshes[selectedIdx]) {
      meshes[selectedIdx].material.color.setHex(
        wireframe ? WIREFRAME_COLOR : meshes[selectedIdx].userData.baseColor
      );
    }

    if (hits.length === 0) {
      setSelectedIdx(null);
      transformRef.current?.detach();
      setBwPart(null);
      return;
    }

    const mesh = hits[0].object;
    const idx  = mesh.userData.componentIndex;
    mesh.material.color.setHex(SELECTED_COLOR);
    setSelectedIdx(idx);
    setMode("select");

    const part = {
      component: mesh.userData.component,
      function:  mesh.userData.function,
      cadHint:   mesh.userData.cadHint,
    };
    setBwPart(part);
    setBwExplanation(null);
    setBwLoading(true);

    // Ask Boss William
    const body = {
      patentNumber:    patentEvent?.id,
      component:       part.component,
      function:        part.function,
      cadHint:         part.cadHint,
      coreInnovation:  patentEvent?.analysis?.coreInnovation,
      title:           patentEvent?.title,
    };
    fetch(`${BACKEND}/api/patents/explain-part`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(d => { setBwExplanation(d.explanation || d.error || "No explanation returned."); setBwLoading(false); })
      .catch(err => { setBwExplanation(err.message); setBwLoading(false); });
  }, [mode, selectedIdx, wireframe, patentEvent, token]);

  // ── Load patent into scene ────────────────────────────────────
  const loadPatent = useCallback(async (numOrEvent) => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Clear existing assembly (incl. label sprite textures)
    meshesRef.current.forEach(m => {
      scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      m.children.forEach(c => { c.material?.map?.dispose?.(); c.material?.dispose?.(); });
    });
    meshesRef.current = [];
    transformRef.current?.detach();
    setSelectedIdx(null); setBwPart(null); setBwExplanation(null);

    // If already have a PatentEvent (from Feed)
    if (numOrEvent && typeof numOrEvent === "object" && numOrEvent.analysis) {
      setPatentEvent(numOrEvent);
      const comps = numOrEvent.analysis.designComponents || [];
      if (!comps.length) return;
      const meshes = buildAssembly(comps);
      meshes.forEach(m => scene.add(m));
      meshesRef.current = meshes;
      return;
    }

    // Otherwise fetch by number
    const num = typeof numOrEvent === "string" ? numOrEvent.trim() : (loadInput || "").trim();
    if (!num) return;
    setLoadLoading(true); setLoadErr(null);
    try {
      const d = await fetch(`${BACKEND}/api/patents/analyze/${encodeURIComponent(num)}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json());

      if (d.error) { setLoadErr(d.error); setLoadLoading(false); return; }

      // Build PatentEvent
      const pe = {
        id: d.patent?.number || num,
        title: d.patent?.title || num,
        assignee: d.patent?.assignee || "",
        date: d.patent?.date || "",
        industry: "",
        abstract: d.patent?.abstract || "",
        analysis: d.analysis,
      };
      setPatentEvent(pe);
      const comps = d.analysis?.designComponents || [];
      const meshes = buildAssembly(comps);
      meshes.forEach(m => scene.add(m));
      meshesRef.current = meshes;
    } catch (e) { setLoadErr(e.message); }
    setLoadLoading(false);
  }, [loadInput, token]);

  // Load initial patent from Feed if provided
  useEffect(() => {
    if (initialPatent?.analysis?.designComponents?.length) {
      loadPatent(initialPatent);
    }
  }, []); // eslint-disable-line

  // ── Reset camera ─────────────────────────────────────────────
  const resetView = useCallback(() => {
    const camera = cameraRef.current;
    const orbit  = orbitRef.current;
    if (!camera || !orbit) return;
    camera.position.set(0, 4, 7);
    orbit.target.set(0, 0, 0);
    orbit.update();
  }, []);

  const hasAssembly = meshesRef.current.length > 0;

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex", flexDirection: "column",
        height: isFullscreen ? "100vh" : "calc(100vh - 200px)",
        minHeight: 480, borderRadius: isFullscreen ? 0 : 16,
        overflow: "hidden", border: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      {/* Patent Loader */}
      <div style={{ padding: "10px 14px", background: "var(--card)", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, flexShrink: 0 }}>Load patent:</span>
        <input
          value={loadInput}
          onChange={e => setLoadInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && loadPatent()}
          placeholder="Patent number (e.g. US10123456B2) or pick from recently viewed"
          style={{
            flex: 1, minWidth: 160, background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 10, padding: "5px 10px", fontSize: 11, color: "var(--text)", outline: "none",
          }}
        />
        <button
          onClick={() => loadPatent()}
          disabled={loadLoading || !loadInput.trim()}
          style={{
            background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.35)",
            color: "#a78bfa", borderRadius: 10, padding: "5px 14px", fontSize: 11,
            fontWeight: 700, cursor: "pointer",
          }}
        >{loadLoading ? "Loading…" : "Load"}</button>

        {/* Recently viewed quick-picks */}
        {recentlyViewed.length > 0 && (
          <div style={{ display: "flex", gap: 4, overflowX: "auto", flexShrink: 0, maxWidth: 260 }}>
            {recentlyViewed.slice(0, 4).map((p, i) => (
              <button
                key={i}
                onClick={() => loadPatent(p)}
                title={p.title}
                style={{
                  flexShrink: 0, background: "transparent", border: "1px solid var(--border)",
                  color: "var(--muted)", borderRadius: 8, padding: "4px 8px",
                  fontSize: 10, cursor: "pointer", maxWidth: 80, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >{p.assignee || p.number}</button>
            ))}
          </div>
        )}

        {loadErr && <span style={{ fontSize: 10, color: "#f87171" }}>⚠ {loadErr.includes("OPS") ? "EPO OPS not configured." : loadErr}</span>}
      </div>

      {/* Toolbar */}
      <Toolbar
        mode={mode} setMode={setMode}
        wireframe={wireframe} setWireframe={setWireframe}
        exploded={exploded} setExploded={setExploded}
        onReset={resetView}
        hasAssembly={hasAssembly}
      />

      {/* Scene + Boss William */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Canvas */}
        <div style={{ flex: 1, position: "relative" }}>
          <canvas
            ref={canvasRef}
            onClick={onCanvasClick}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
          {/* Fullscreen toggle */}
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
            style={{
              position: "absolute", top: 10, right: 10,
              background: "rgba(10,10,15,0.8)", border: "1px solid rgba(124,58,237,0.35)",
              color: "#a78bfa", borderRadius: 8, padding: "6px 10px",
              fontSize: 12, fontWeight: 700, cursor: "pointer", lineHeight: 1,
            }}
          >{isFullscreen ? "⤢ Exit" : "⤢ Fullscreen"}</button>
          {/* Hint overlay */}
          {hasAssembly && (
            <div style={{
              position: "absolute", bottom: 10, left: 10,
              background: "rgba(10,10,15,0.7)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8, padding: "6px 10px", fontSize: 10, color: "#64748b",
            }}>
              Left-drag: orbit · Right-drag: pan · Scroll: zoom · Click part: select · G/R/S: transform
            </div>
          )}
          {!hasAssembly && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
              flexDirection: "column", gap: 8,
            }}>
              <p style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600 }}>No patent loaded</p>
              <p style={{ fontSize: 11, color: "var(--muted)" }}>Enter a patent number above or open a patent from the Feed</p>
            </div>
          )}
          {patentEvent && hasAssembly && (
            <div style={{
              position: "absolute", top: 10, left: 10,
              background: "rgba(10,10,15,0.8)", border: "1px solid rgba(124,58,237,0.3)",
              borderRadius: 8, padding: "6px 10px", maxWidth: 240,
            }}>
              <p style={{ fontSize: 10, color: "#a78bfa", fontWeight: 700, lineHeight: 1.3 }}>{patentEvent.title}</p>
              <p style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>{patentEvent.assignee} · {meshesRef.current.length} parts</p>
            </div>
          )}
        </div>

        {/* Boss William */}
        <BossWilliam
          part={bwPart}
          patentEvent={patentEvent}
          token={token}
          loading={bwLoading}
          explanation={bwExplanation}
        />
      </div>
    </div>
  );
}
