// ───────────────────────────────────────────────────────────────
// frontend/src/ResearchConsole.jsx
// The Research tab: paste a ticker, type a crisis, watch the agent walk.
// Includes the saved-shocks drawer, a force-rebuild toggle, and recent
// run history. Matches Meridian's tokens (--bg/--card/--border/--text/
// --muted + violet accent) so it drops into the app unchanged.
//
// Wiring in App.jsx:
//   import ResearchConsole from "./ResearchConsole.jsx";
//   VIEWS: { ..., research: ResearchConsole }   // replaces ResearchView
// It receives `token` from the existing <View isOwner={isOwner} token={token} />.
// ───────────────────────────────────────────────────────────────
import { useState, useEffect, useRef } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// Self-contained primitives → zero coupling to App.jsx internals.
const Card = ({ children, className = "", accent }) => (
  <div className={`rounded-2xl p-4 border transition-all ${accent ? "border-violet-500/30 bg-violet-500/5" : "border-[var(--border)] bg-[var(--card)]"} ${className}`}>{children}</div>
);
const Pill = ({ color = "violet", children }) => {
  const c = {
    green: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    red: "bg-red-500/15 text-red-400 border-red-500/25",
    amber: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    violet: "bg-violet-500/15 text-violet-400 border-violet-500/25",
    gray: "bg-zinc-700/40 text-zinc-400 border-zinc-700/40",
  }[color];
  return <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-widest ${c}`}>{children}</span>;
};
const Label = ({ children }) => <p className="text-[11px] font-bold tracking-[0.12em] uppercase text-[var(--muted)] mb-2">{children}</p>;

const STAGE_ORDER = ["resolve", "edgar", "ontology", "crisis", "done"];
const STAGE_NAME = { resolve: "Resolve ticker", edgar: "SEC EDGAR pull", ontology: "Entity graph", crisis: "Shock propagation", done: "Dossier" };

const dirColor = (d) => (d === "bullish" || d === "positive" ? "green" : d === "bearish" || d === "negative" ? "red" : "amber");
const auth = (token) => ({ Authorization: `Bearer ${token}` });

export default function ResearchConsole({ token }) {
  const [ticker, setTicker] = useState("");
  const [scenario, setScenario] = useState("");
  const [force, setForce] = useState(false);
  const [events, setEvents] = useState([]);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const [shocks, setShocks] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runs, setRuns] = useState([]);
  const abortRef = useRef(null);

  // Load the scenario library + recent history once.
  useEffect(() => {
    if (!token) return;
    let c = false;
    fetch(`${BACKEND_URL}/api/research/shocks`, { headers: auth(token) })
      .then((r) => (r.ok ? r.json() : [])).then((d) => { if (!c) setShocks(Array.isArray(d) ? d : []); }).catch(() => {});
    fetch(`${BACKEND_URL}/api/research/runs`, { headers: auth(token) })
      .then((r) => (r.ok ? r.json() : [])).then((d) => { if (!c) setRuns(Array.isArray(d) ? d : []); }).catch(() => {});
    return () => { c = true; };
  }, [token]);

  const stageStatus = (s) => {
    const evs = events.filter((e) => e.stage === s);
    return evs.length ? evs[evs.length - 1].status : "idle";
  };

  async function run() {
    if (!ticker.trim() || !scenario.trim() || running) return;
    setRunning(true); setError(""); setEvents([]); setResult(null);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const res = await fetch(`${BACKEND_URL}/api/research/deep`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(token) },
        body: JSON.stringify({ ticker: ticker.trim(), scenario: scenario.trim(), force }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("Couldn't reach the research engine. Is the backend running?");
      // Parse the SSE stream off the fetch reader (keeps auth in the header,
      // which native EventSource can't do).
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n"); buf = chunks.pop();
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (!ev.stage) continue;
          if (ev.stage === "error") { setError(ev.label); continue; }
          setEvents((prev) => [...prev, ev]);
          if (ev.stage === "done" && ev.data) {
            setResult(ev.data);
            // refresh history with the new run
            fetch(`${BACKEND_URL}/api/research/runs`, { headers: auth(token) })
              .then((r) => (r.ok ? r.json() : [])).then((d) => setRuns(Array.isArray(d) ? d : [])).catch(() => {});
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") setError(String(e.message || e));
    }
    setRunning(false); setForce(false);
  }

  async function saveCurrentShock() {
    const s = scenario.trim();
    if (!s) return;
    const label = window.prompt("Name this scenario:", s.slice(0, 48));
    if (!label) return;
    try {
      const r = await fetch(`${BACKEND_URL}/api/research/shocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(token) },
        body: JSON.stringify({ label, scenario: s }),
      });
      if (r.ok) { r.json().then(saved => setShocks((prev) => [saved, ...prev])); }
    } catch { /* non-fatal */ }
  }

  async function removeShock(id) {
    setShocks((prev) => prev.filter((s) => s.id !== id));
    fetch(`${BACKEND_URL}/api/research/shocks/${id}`, { method: "DELETE", headers: auth(token) }).catch(() => {});
  }

  async function openRun(id) {
    try {
      const r = await fetch(`${BACKEND_URL}/api/research/runs/${id}`, { headers: auth(token) });
      if (!r.ok) return;
      const run = await r.json();
      setTicker(run.ticker); setScenario(run.scenario);
      setEvents([]); setError("");
      setResult({ ticker: run.ticker, scenario: run.scenario, ontology: null, impact: run.impact, runId: run.id });
    } catch { /* non-fatal */ }
  }

  return (
    <div className="space-y-5">
      {/* ── Input console ── */}
      <Card accent>
        <Label>Deep research · ticker + crisis</Label>
        <div className="flex gap-2 mb-3">
          <input
            value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="TICKER"
            className="w-28 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-2.5 text-[var(--text)] text-sm font-black tracking-wider outline-none focus:border-violet-500/50"
          />
          <textarea
            rows={2} value={scenario} onChange={(e) => setScenario(e.target.value)}
            placeholder="Describe the crisis to model — a supply shock, a regulatory ruling, a rate path…"
            className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-2.5 text-[var(--text)] text-sm outline-none focus:border-violet-500/50 resize-none"
          />
        </div>

        {/* drawer toggle + save + force-rebuild */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button onClick={() => setDrawerOpen((o) => !o)}
            className="text-[10px] px-2 py-1 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:border-violet-500/40 hover:text-violet-400 transition-colors font-bold">
            {drawerOpen ? "▲ Saved scenarios" : `▼ Saved scenarios (${shocks.length})`}
          </button>
          <button onClick={saveCurrentShock} disabled={!scenario.trim()}
            className="text-[10px] px-2 py-1 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:border-violet-500/40 hover:text-violet-400 disabled:opacity-40 transition-colors font-bold">
            ＋ Save current
          </button>
          <label className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--muted)] cursor-pointer select-none">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="accent-violet-500" />
            Rebuild entity graph
          </label>
        </div>

        {drawerOpen && (
          <div className="mb-3 space-y-1.5 max-h-44 overflow-y-auto pr-1">
            {shocks.length === 0 && <p className="text-[var(--muted)] text-xs">Nothing saved yet — write a scenario and press "＋ Save current".</p>}
            {shocks.map((s) => (
              <div key={s.id} className="flex items-center gap-2 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-2">
                <button onClick={() => setScenario(s.scenario)} className="flex-1 text-left min-w-0">
                  <p className="text-[var(--text)] text-xs font-bold truncate">{s.label}</p>
                  <p className="text-[var(--muted)] text-[10px] truncate">{s.scenario}</p>
                </button>
                <button onClick={() => removeShock(s.id)} className="text-[var(--muted)] hover:text-red-400 text-xs flex-shrink-0" title="Delete">✕</button>
              </div>
            ))}
          </div>
        )}

        <button onClick={run} disabled={running || !ticker.trim() || !scenario.trim()}
          className="w-full bg-violet-500 hover:bg-violet-600 disabled:opacity-40 text-white font-bold rounded-xl py-2.5 text-sm transition-colors">
          {running ? "Walking the graph…" : "Run analysis"}
        </button>
      </Card>

      {error && <Card><p className="text-red-400 text-sm">{error}</p></Card>}

      {/* ── Agent trace ── */}
      {(running || events.length > 0) && (
        <Card>
          <Label>Agent trace</Label>
          <div className="space-y-1.5">
            {STAGE_ORDER.map((s) => {
              const st = stageStatus(s);
              const ev = [...events].reverse().find((e) => e.stage === s);
              const dot = st === "done" || st === "cached" ? "bg-emerald-500"
                : st === "running" ? "bg-violet-500 animate-pulse"
                : "bg-zinc-700";
              return (
                <div key={s} className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <span className={`text-xs font-bold w-32 flex-shrink-0 ${st === "idle" ? "text-[var(--muted)]" : "text-[var(--text)]"}`}>{STAGE_NAME[s]}</span>
                  <span className="text-[var(--muted)] text-xs truncate">{ev?.label || ""}</span>
                  {st === "cached" && <Pill color="amber">cached</Pill>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── Impact dossier ── */}
      {result?.impact && <ImpactDossier impact={result.impact} />}

      {/* ── Entity graph ── */}
      {result?.ontology && <OntologyView onto={result.ontology} />}

      {/* ── History ── */}
      {runs.length > 0 && !running && (
        <div>
          <Label>Recent analyses</Label>
          <div className="space-y-1.5">
            {runs.map((r) => (
              <button key={r.id} onClick={() => openRun(r.id)}
                className="w-full flex items-center gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 hover:border-violet-500/40 transition-colors text-left">
                <span className="text-[var(--text)] text-xs font-black w-14 flex-shrink-0">{r.ticker}</span>
                <span className="text-[var(--muted)] text-xs truncate flex-1">{r.scenario}</span>
                {r.net_direction && <Pill color={dirColor(r.net_direction)}>{r.net_direction}</Pill>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ImpactDossier({ impact }) {
  const t = impact.transmission || [];
  return (
    <div className="space-y-3">
      <Card accent>
        <div className="flex items-center justify-between mb-2">
          <Label>Verdict</Label>
          <div className="flex items-center gap-2">
            <Pill color={dirColor(impact.netDirection)}>{impact.netDirection}</Pill>
            {impact.confidence != null && <span className="text-[var(--muted)] text-[10px]">conf {Math.round(impact.confidence * 100)}%</span>}
          </div>
        </div>
        <p className="text-[var(--text)] text-sm font-semibold leading-snug">{impact.headline}</p>
        {impact.estimatedImpact && (
          <div className="grid grid-cols-3 gap-2 mt-3">
            {[["Revenue", impact.estimatedImpact.revenue], ["Margin", impact.estimatedImpact.margin], ["Multiple", impact.estimatedImpact.multiple]].map(([k, v]) => (
              <div key={k} className="bg-[var(--bg)] border border-[var(--border)] rounded-xl p-2">
                <p className="text-[var(--muted)] text-[9px] uppercase">{k}</p>
                <p className="text-[var(--text)] text-xs font-bold">{v || "—"}</p>
              </div>
            ))}
          </div>
        )}
        {impact.estimatedImpact?.caveat && <p className="text-[var(--muted)] text-[10px] mt-2 italic">{impact.estimatedImpact.caveat}</p>}
      </Card>

      <div>
        <Label>Transmission — how the shock travels</Label>
        <div className="space-y-2">
          {t.map((n, i) => (
            <Card key={i}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-5 h-5 rounded-md bg-violet-500/15 text-violet-400 text-[10px] font-black flex items-center justify-center flex-shrink-0">{n.order}</span>
                  <span className="text-[var(--text)] text-sm font-bold truncate">{n.node}</span>
                </div>
                <Pill color={dirColor(n.direction)}>{n.direction}</Pill>
              </div>
              <p className="text-[var(--muted)] text-xs leading-relaxed">{n.mechanism}</p>
              {n.path?.length > 0 && <p className="text-violet-400/80 text-[10px] mt-1.5 font-mono">{n.path.join(" → ")}</p>}
              {n.magnitude && (
                <p className="text-[var(--text)] text-[11px] mt-1.5">
                  <span className="text-[var(--muted)]">{n.magnitude.metric}:</span> {n.magnitude.estimate} <span className="text-[var(--muted)]">· {n.magnitude.horizon}</span>
                </p>
              )}
              {n.evidence?.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-1">
                  {n.evidence.map((e, j) => (
                    <a key={j} href={e.url} target="_blank" rel="noreferrer" className="block text-[var(--muted)] text-[10px] hover:text-violet-400 truncate">↗ {e.claim}</a>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Card><Label>Bull case</Label><p className="text-[var(--text)] text-xs leading-relaxed">{impact.bullCase}</p></Card>
        <Card><Label>Bear case</Label><p className="text-[var(--text)] text-xs leading-relaxed">{impact.bearCase}</p></Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {impact.watchItems?.length > 0 && (
          <Card><Label>Watch for</Label>
            <ul className="space-y-1">{impact.watchItems.map((w, i) => <li key={i} className="text-[var(--text)] text-xs flex gap-2"><span className="text-violet-400">•</span>{w}</li>)}</ul>
          </Card>
        )}
        {impact.falsifiers?.length > 0 && (
          <Card><Label>Falsifiers</Label>
            <ul className="space-y-1">{impact.falsifiers.map((f, i) => <li key={i} className="text-[var(--text)] text-xs flex gap-2"><span className="text-red-400">✕</span>{f}</li>)}</ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function OntologyView({ onto }) {
  const groups = [
    ["Segments", onto.segments, (x) => x.name, (x) => (x.revenuePct != null ? x.revenuePct + "%" : null)],
    ["Geographies", onto.geographies, (x) => x.region, (x) => (x.revenuePct != null ? x.revenuePct + "%" : null)],
    ["Customers", onto.customers, (x) => x.name, (x) => x.materiality],
    ["Suppliers", onto.suppliers, (x) => `${x.name}${x.input ? " · " + x.input : ""}`, (x) => x.criticality],
    ["Competitors", onto.competitors, (x) => x.name, (x) => x.threat],
    ["Dependencies", onto.dependencies, (x) => x.name, (x) => x.type],
  ];
  return (
    <div className="space-y-3">
      <Label>Entity graph</Label>
      {onto.company && (
        <Card>
          <p className="text-[var(--text)] text-sm font-bold">{onto.company.name}</p>
          <p className="text-[var(--muted)] text-xs mt-1 leading-relaxed">{onto.company.businessModel}</p>
          {onto.company.moat && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-[var(--muted)] text-[10px] uppercase tracking-wide">Moat</span>
              <span className="text-[var(--text)] text-xs">{onto.company.moat}</span>
              {onto.company.moatTrend && <Pill color={onto.company.moatTrend === "widening" ? "green" : onto.company.moatTrend === "eroding" ? "red" : "gray"}>{onto.company.moatTrend}</Pill>}
            </div>
          )}
        </Card>
      )}
      {groups.map(([title, arr, name, tag]) => (arr?.length > 0) && (
        <div key={title}>
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-1.5">{title}</p>
          <div className="space-y-1.5">
            {arr.map((x, i) => (
              <div key={i} className="flex items-center justify-between gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
                <span className="text-[var(--text)] text-xs truncate flex-1">{name(x)}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {tag(x) && <Pill color={/single-source|high/.test(String(tag(x))) ? "red" : "gray"}>{tag(x)}</Pill>}
                  {x.confidence != null && <span className="text-[var(--muted)] text-[9px]">{Math.round(x.confidence * 100)}%</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
