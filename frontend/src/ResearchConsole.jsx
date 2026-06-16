// ───────────────────────────────────────────────────────────────
// frontend/src/ResearchConsole.jsx
// Research tab: ticker + crisis → agent trace → structured dossier.
//
// Visual overhaul:
//   • Transmission chain → indented CSS tree (no SVG)
//   • Cluster breakdown  → mini spreadsheet table
//   • Sentiment section  → gauge bar + source horizontal bars
//   • Signal intelligence → Beta posteriors displayed (α, β, conf tier)
//   • Watchlist widget   → small subheader under signals
//   • Quant metrics panel → FCF, EV/EBITDA, leverage, earnings surprise
// ───────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ─── PRIMITIVES ───────────────────────────────────────────────
const Card = ({ children, className = "", accent }) => (
  <div className={`rounded-2xl p-4 border transition-all ${accent ? "border-violet-500/30 bg-violet-500/5" : "border-[var(--border)] bg-[var(--card)]"} ${className}`}>
    {children}
  </div>
);

const Pill = ({ color = "violet", children }) => {
  const c = {
    green:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    red:    "bg-red-500/15 text-red-400 border-red-500/25",
    amber:  "bg-amber-500/15 text-amber-400 border-amber-500/25",
    violet: "bg-violet-500/15 text-violet-400 border-violet-500/25",
    gray:   "bg-zinc-700/40 text-zinc-400 border-zinc-700/40",
    blue:   "bg-blue-500/15 text-blue-400 border-blue-500/25",
  }[color] || "bg-zinc-700/40 text-zinc-400 border-zinc-700/40";
  return (
    <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-widest ${c}`}>
      {children}
    </span>
  );
};

const Label = ({ children }) => (
  <p className="text-[11px] font-bold tracking-[0.12em] uppercase text-[var(--muted)] mb-2">
    {children}
  </p>
);

// ─── STAGE CONFIG ─────────────────────────────────────────────
const STAGE_ORDER = ["resolve", "signals", "edgar", "ontology", "crisis", "done"];
const STAGE_NAME  = {
  resolve:  "Resolve ticker",
  signals:  "Positioning signals",
  edgar:    "SEC EDGAR pull",
  ontology: "Entity graph",
  crisis:   "Shock propagation",
  done:     "Dossier",
};

const dirColor = (d) =>
  d === "bullish" || d === "positive" ? "green"
  : d === "bearish" || d === "negative" ? "red"
  : "amber";

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const fmtB = (v) =>
  v == null ? "—"
  : Math.abs(v) >= 1e12 ? "$" + (v / 1e12).toFixed(2) + "T"
  : Math.abs(v) >= 1e9  ? "$" + (v / 1e9).toFixed(2) + "B"
  : Math.abs(v) >= 1e6  ? "$" + (v / 1e6).toFixed(1) + "M"
  : "$" + v;

// ─── MAIN COMPONENT ───────────────────────────────────────────
export default function ResearchConsole({ token }) {
  const [ticker,   setTicker]   = useState("");
  const [scenario, setScenario] = useState("");
  const [force,    setForce]    = useState(false);
  const [events,   setEvents]   = useState([]);
  const [result,   setResult]   = useState(null);
  const [running,  setRunning]  = useState(false);
  const [error,    setError]    = useState("");

  const [shocks,     setShocks]     = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runs,       setRuns]       = useState([]);
  const [twBudget,   setTwBudget]   = useState(null);
  const [accuracy,   setAccuracy]   = useState([]);
  const [sigHistory, setSigHistory] = useState([]);
  const [intelTab,   setIntelTab]   = useState("accuracy");

  const [watchlist,    setWatchlist]    = useState([]);
  const [wlInput,      setWlInput]      = useState("");
  const [quant,        setQuant]        = useState(null);
  const [quantLoading, setQuantLoading] = useState(false);

  const abortRef = useRef(null);

  const get = useCallback(
    (path) =>
      fetch(`${BACKEND_URL}/api/research/${path}`, { headers: auth(token) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    [token]
  );

  // Load static data once
  useEffect(() => {
    if (!token) return;
    let c = false;
    get("shocks").then((d) => { if (!c && Array.isArray(d)) setShocks(d); });
    get("runs").then((d) => { if (!c && Array.isArray(d)) setRuns(d); });
    get("accuracy").then((d) => { if (!c && Array.isArray(d)) setAccuracy(d); });
    get("twitter-budget").then((d) => { if (!c && d && !d.error) setTwBudget(d); });
    // Watchlist
    fetch(`${BACKEND_URL}/api/watchlist`, { headers: auth(token) })
      .then((r) => r.ok ? r.json() : [])
      .then((d) => { if (!c) setWatchlist(Array.isArray(d) ? d : []); })
      .catch(() => {});
    return () => { c = true; };
  }, [token, get]);

  // Refresh signal history + quant when a result loads
  useEffect(() => {
    if (!token || !result?.ticker) return;
    let c = false;
    fetch(`${BACKEND_URL}/api/research/signals/${result.ticker}`, { headers: auth(token) })
      .then((r) => r.ok ? r.json() : [])
      .then((d) => { if (!c) setSigHistory(Array.isArray(d) ? d : []); })
      .catch(() => {});
    // Load quant data for this ticker
    setQuantLoading(true);
    fetch(`${BACKEND_URL}/api/research/quant/${result.ticker}`, { headers: auth(token) })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!c) { setQuant(d); setQuantLoading(false); } })
      .catch(() => { if (!c) setQuantLoading(false); });
    return () => { c = true; };
  }, [token, result?.ticker]);

  const stageStatus = (s) => {
    const evs = events.filter((e) => e.stage === s);
    return evs.length ? evs[evs.length - 1].status : "idle";
  };

  async function run() {
    if (!ticker.trim() || !scenario.trim() || running) return;
    setRunning(true); setError(""); setEvents([]); setResult(null); setQuant(null);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const res = await fetch(`${BACKEND_URL}/api/research/deep`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(token) },
        body: JSON.stringify({ ticker: ticker.trim(), scenario: scenario.trim(), force }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("Can't reach the research engine.");
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
            fetch(`${BACKEND_URL}/api/research/runs`, { headers: auth(token) })
              .then((r) => r.ok ? r.json() : [])
              .then((d) => setRuns(Array.isArray(d) ? d : []))
              .catch(() => {});
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
    const r = await fetch(`${BACKEND_URL}/api/research/shocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({ label, scenario: s }),
    }).catch(() => null);
    if (r?.ok) { r.json().then((saved) => setShocks((prev) => [saved, ...prev])); }
  }

  async function removeShock(id) {
    setShocks((prev) => prev.filter((s) => s.id !== id));
    fetch(`${BACKEND_URL}/api/research/shocks/${id}`, { method: "DELETE", headers: auth(token) }).catch(() => {});
  }

  async function openRun(id) {
    const r = await fetch(`${BACKEND_URL}/api/research/runs/${id}`, { headers: auth(token) }).catch(() => null);
    if (!r?.ok) return;
    const run = await r.json();
    setTicker(run.ticker); setScenario(run.scenario);
    setEvents([]); setError("");
    setResult({ ticker: run.ticker, scenario: run.scenario, ontology: null, impact: run.impact, runId: run.id });
  }

  // Watchlist helpers
  async function addToWatchlist() {
    const t = wlInput.trim().toUpperCase();
    if (!t) return;
    await fetch(`${BACKEND_URL}/api/watchlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({ ticker: t }),
    }).catch(() => {});
    setWatchlist((prev) => prev.find(x => x.ticker === t) ? prev : [...prev, { ticker: t }]);
    setWlInput("");
  }

  async function removeFromWatchlist(t) {
    setWatchlist((prev) => prev.filter((x) => x.ticker !== t));
    fetch(`${BACKEND_URL}/api/watchlist/${t}`, { method: "DELETE", headers: auth(token) }).catch(() => {});
  }

  return (
    <div className="space-y-5">
      {/* ── Input console ── */}
      <Card accent>
        <div className="flex items-center justify-between gap-2 mb-2">
          <Label>Deep research · ticker + crisis</Label>
          {twBudget && (
            <span title={`X/Twitter: ${(twBudget.monthlyUsed ?? 0).toLocaleString()} / ${(twBudget.monthlyBudget ?? 0).toLocaleString()} tweet reads`}>
              <Pill color={twBudget.monthlyPct > 90 ? "red" : twBudget.monthlyPct > 70 ? "amber" : "gray"}>
                𝕏 {twBudget.monthlyPct ?? 0}% used
              </Pill>
            </span>
          )}
        </div>
        <div className="flex gap-2 mb-3">
          <input
            value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="TICKER"
            className="w-28 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-2.5 text-[var(--text)] text-sm font-black tracking-wider outline-none focus:border-violet-500/50"
          />
          <textarea
            rows={2} value={scenario} onChange={(e) => setScenario(e.target.value)}
            placeholder="Describe the crisis — a supply shock, regulatory ruling, rate path…"
            className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-2.5 text-[var(--text)] text-sm outline-none focus:border-violet-500/50 resize-none"
          />
        </div>
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
            {shocks.length === 0 && (
              <p className="text-[var(--muted)] text-xs">Nothing saved yet — write a scenario and press "＋ Save current".</p>
            )}
            {shocks.map((s) => (
              <div key={s.id} className="flex items-center gap-2 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-2">
                <button onClick={() => setScenario(s.scenario)} className="flex-1 text-left min-w-0">
                  <p className="text-[var(--text)] text-xs font-bold truncate">{s.label}</p>
                  <p className="text-[var(--muted)] text-[10px] truncate">{s.scenario}</p>
                </button>
                <button onClick={() => removeShock(s.id)} className="text-[var(--muted)] hover:text-red-400 text-xs flex-shrink-0">✕</button>
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
                : st === "warn" ? "bg-amber-500"
                : "bg-zinc-700";
              return (
                <div key={s} className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <span className={`text-xs font-bold w-32 flex-shrink-0 ${st === "idle" ? "text-[var(--muted)]" : "text-[var(--text)]"}`}>
                    {STAGE_NAME[s]}
                  </span>
                  <span className="text-[var(--muted)] text-xs truncate">{ev?.label || ""}</span>
                  {st === "cached" && <Pill color="amber">cached</Pill>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── Positioning signals ── */}
      {result?.positioningSignal && (
        <SignalPanel signal={result.positioningSignal} anomalies={result.anomalies} />
      )}

      {/* ── Watchlist widget (under signals) ── */}
      <WatchlistWidget
        watchlist={watchlist}
        wlInput={wlInput}
        setWlInput={setWlInput}
        onAdd={addToWatchlist}
        onRemove={removeFromWatchlist}
        currentTicker={ticker}
      />

      {/* ── Institutional positioning ── */}
      {result?.positioningSignal?.institutionalPositioning && (
        <InstitutionalPanel ip={result.positioningSignal.institutionalPositioning} />
      )}

      {/* ── Quant metrics ── */}
      {(quant || quantLoading) && (
        <QuantPanel data={quant} loading={quantLoading} ticker={result?.ticker} />
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

      {/* ── Signal intelligence ── */}
      {(accuracy.length > 0 || sigHistory.length > 0) && !running && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Label>Signal intelligence</Label>
            <div className="flex gap-1 ml-auto">
              {[["accuracy", "Accuracy"], ["history", `History${result?.ticker ? " · " + result.ticker : ""}`]].map(([id, name]) => (
                <button key={id} onClick={() => setIntelTab(id)}
                  className={`text-[10px] px-2 py-1 rounded-lg border font-bold transition-colors ${intelTab === id ? "border-violet-500/40 text-violet-400 bg-violet-500/10" : "border-[var(--border)] text-[var(--muted)]"}`}>
                  {name}
                </button>
              ))}
            </div>
          </div>
          {intelTab === "accuracy"
            ? <AccuracyBoard rows={accuracy} />
            : <SignalHistory rows={sigHistory} ticker={result?.ticker} />}
        </div>
      )}
    </div>
  );
}

// ─── WATCHLIST WIDGET ─────────────────────────────────────────
function WatchlistWidget({ watchlist, wlInput, setWlInput, onAdd, onRemove, currentTicker }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Label>Watchlist · nightly motor</Label>
          <span className="text-[var(--muted)] text-[9px]">{watchlist.length} tickers</span>
        </div>
        <button onClick={() => setOpen(o => !o)}
          className="text-[10px] text-[var(--muted)] hover:text-violet-400 font-bold transition-colors">
          {open ? "▲" : "▼"}
        </button>
      </div>

      {/* Compact ticker chips */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {watchlist.length === 0 && (
          <span className="text-[var(--muted)] text-[10px]">Empty — add tickers to scan nightly with Haiku</span>
        )}
        {watchlist.map((w) => (
          <span key={w.ticker}
            className="flex items-center gap-1 bg-[var(--bg)] border border-[var(--border)] rounded-lg px-2 py-0.5">
            <span className="text-[var(--text)] text-[10px] font-bold">{w.ticker}</span>
            <button onClick={() => onRemove(w.ticker)}
              className="text-[var(--muted)] hover:text-red-400 text-[9px] leading-none ml-0.5">✕</button>
          </span>
        ))}
      </div>

      {open && (
        <div className="flex gap-2 mt-2">
          <input
            value={wlInput}
            onChange={(e) => setWlInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && onAdd()}
            placeholder="ADD TICKER"
            className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-1.5 text-[var(--text)] text-xs font-bold tracking-wider outline-none focus:border-violet-500/50"
          />
          <button onClick={onAdd}
            className="bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/30 text-violet-400 text-xs font-bold px-3 rounded-xl transition-colors">
            ＋
          </button>
          {currentTicker && !watchlist.find(w => w.ticker === currentTicker) && (
            <button
              onClick={() => { setWlInput(currentTicker); setTimeout(onAdd, 0); }}
              className="text-[10px] text-violet-400 hover:text-violet-300 font-bold transition-colors whitespace-nowrap">
              + {currentTicker}
            </button>
          )}
        </div>
      )}
      {!open && (
        <p className="text-[var(--muted)] text-[9px] mt-1">
          Haiku scans these every night at 2am UTC · ▼ to add tickers
        </p>
      )}
    </Card>
  );
}

// ─── SIGNAL PANEL ────────────────────────────────────────────
function SignalPanel({ signal, anomalies = [] }) {
  const sb = signal.sourceBreakdown || {};
  const empty = !signal.totalSignals;
  const cb = signal.clusterBreakdown || {};

  // Gauge bar percentages
  const total = (signal.bullSignals || 0) + (signal.bearSignals || 0) + (signal.neutralSignals || 0);
  const bullPct  = total ? Math.round((signal.bullSignals  || 0) / total * 100) : 0;
  const bearPct  = total ? Math.round((signal.bearSignals  || 0) / total * 100) : 0;
  const neutPct  = Math.max(0, 100 - bullPct - bearPct);

  // Source bars — sources with signal counts
  const sourceBars = [
    { label: "SEC",      count: sb.sec      || 0, color: "bg-violet-400" },
    { label: "News",     count: sb.news     || 0, color: "bg-blue-400" },
    { label: "Analyst",  count: sb.analyst  || 0, color: "bg-amber-400" },
    { label: "Reddit",   count: sb.reddit   || 0, color: "bg-orange-400" },
    { label: "X",        count: sb.twitter  || 0, color: "bg-zinc-400" },
    { label: "Substack", count: sb.substack || 0, color: "bg-emerald-400" },
  ].filter(s => s.count > 0);
  const maxCount = Math.max(...sourceBars.map(s => s.count), 1);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Market positioning · before fundamentals</Label>
        <div className="flex items-center gap-2">
          <Pill color={dirColor(signal.direction)}>{signal.direction}</Pill>
          {signal.confidence != null && (
            <span className="text-[var(--muted)] text-[10px]">conf {Math.round(signal.confidence * 100)}%</span>
          )}
        </div>
      </div>

      {/* Anomaly warnings */}
      {anomalies.length > 0 && anomalies.map((a, i) => (
        <Card key={i} className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2 mb-1">
            <Pill color="amber">⚠ {String(a.type || a.anomaly_type || "anomaly").replace(/_/g, " ")}</Pill>
          </div>
          <p className="text-amber-200/90 text-xs leading-relaxed">{a.description}</p>
        </Card>
      ))}

      {empty ? (
        <Card>
          <p className="text-[var(--muted)] text-xs">{signal.conflictNote || "No signals found — add API keys for wider coverage."}</p>
        </Card>
      ) : (
        <>
          {/* Sentiment gauge bar */}
          <Card accent>
            <p className="text-[var(--muted)] text-[9px] uppercase tracking-widest mb-1.5">Sentiment distribution · {signal.totalSignals} signals</p>
            <div className="flex rounded-lg overflow-hidden h-4 mb-1.5">
              {bullPct > 0 && (
                <div className="bg-emerald-500/70 flex items-center justify-center text-[8px] font-bold text-white"
                  style={{ width: bullPct + "%" }}>
                  {bullPct >= 10 ? bullPct + "%" : ""}
                </div>
              )}
              {neutPct > 0 && (
                <div className="bg-zinc-600/60 flex items-center justify-center text-[8px] text-zinc-400"
                  style={{ width: neutPct + "%" }}>
                  {neutPct >= 10 ? neutPct + "%" : ""}
                </div>
              )}
              {bearPct > 0 && (
                <div className="bg-red-500/70 flex items-center justify-center text-[8px] font-bold text-white"
                  style={{ width: bearPct + "%" }}>
                  {bearPct >= 10 ? bearPct + "%" : ""}
                </div>
              )}
            </div>
            <div className="flex gap-3 text-[10px]">
              <span className="text-emerald-400">↑ {signal.bullSignals} bull</span>
              <span className="text-zinc-500">{signal.neutralSignals} neutral</span>
              <span className="text-red-400">↓ {signal.bearSignals} bear</span>
              {signal.corroborationMultiplier != null && (
                <span className="text-[var(--muted)] ml-auto">corroboration ×{signal.corroborationMultiplier}</span>
              )}
            </div>
          </Card>

          {/* Source breakdown horizontal bars */}
          {sourceBars.length > 0 && (
            <Card>
              <p className="text-[var(--muted)] text-[9px] uppercase tracking-widest mb-2">Source breakdown</p>
              <div className="space-y-1.5">
                {sourceBars.map((s) => (
                  <div key={s.label} className="flex items-center gap-2">
                    <span className="text-[var(--muted)] text-[9px] w-14 flex-shrink-0 text-right">{s.label}</span>
                    <div className="flex-1 bg-[var(--bg)] rounded-full h-2 overflow-hidden">
                      <div className={`h-full ${s.color} rounded-full transition-all`}
                        style={{ width: Math.max(4, (s.count / maxCount) * 100) + "%" }} />
                    </div>
                    <span className="text-[var(--text)] text-[9px] w-6 text-right font-bold">{s.count}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Cluster breakdown spreadsheet */}
          {Object.keys(cb).length > 0 && (
            <Card>
              <p className="text-[var(--muted)] text-[9px] uppercase tracking-widest mb-2">Signal cluster breakdown</p>
              <table className="w-full text-[10px] border-collapse">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="text-left text-[var(--muted)] font-bold py-1 pr-2">Cluster</th>
                    <th className="text-right text-[var(--muted)] font-bold py-1 px-1">Signals</th>
                    <th className="text-right text-[var(--muted)] font-bold py-1 px-1">Avg score</th>
                    <th className="text-right text-[var(--muted)] font-bold py-1 pl-1">Direction</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(cb).map(([cluster, data]) => (
                    <tr key={cluster} className="border-b border-[var(--border)]/40 hover:bg-[var(--bg)] transition-colors">
                      <td className="py-1 pr-2 text-[var(--text)] font-medium">
                        {cluster.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase())}
                      </td>
                      <td className="py-1 px-1 text-right text-[var(--muted)]">{data.count}</td>
                      <td className="py-1 px-1 text-right font-mono">
                        <span className={data.avgScore > 0.05 ? "text-emerald-400" : data.avgScore < -0.05 ? "text-red-400" : "text-zinc-500"}>
                          {(data.avgScore >= 0 ? "+" : "") + data.avgScore.toFixed(3)}
                        </span>
                      </td>
                      <td className="py-1 pl-1 text-right">
                        <Pill color={dirColor(data.direction)}>{data.direction}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* Key driver */}
          {signal.keyDriver && (
            <Card>
              <p className="text-[var(--muted)] text-[9px] uppercase tracking-widest mb-1">Key driver</p>
              <a href={signal.keyDriver.url || undefined} target="_blank" rel="noreferrer"
                className="text-[var(--text)] text-xs hover:text-violet-400 leading-snug block">
                {signal.keyDriver.headline}
                <span className="text-[var(--muted)]"> · {signal.keyDriver.source}</span>
              </a>
            </Card>
          )}

          {/* Conflict / bias notes */}
          {signal.hasConflict && signal.conflictNote && (
            <p className="text-amber-400 text-[11px]">⚠ {signal.conflictNote}</p>
          )}
          {(signal.politicalBiasNote || signal.ownershipBiasNote) && (
            <div className="flex flex-col gap-0.5">
              {signal.politicalBiasNote && <p className="text-[var(--muted)] text-[10px] italic">{signal.politicalBiasNote}</p>}
              {signal.ownershipBiasNote  && <p className="text-[var(--muted)] text-[10px] italic">{signal.ownershipBiasNote}</p>}
            </div>
          )}
          {signal.learningNote && <p className="text-violet-400/80 text-[10px]">{signal.learningNote}</p>}
        </>
      )}

      {/* Top signals */}
      {(signal.topBullishSignals?.length > 0 || signal.topBearishSignals?.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {signal.topBullishSignals?.length > 0 && (
            <Card>
              <Label>Top bullish</Label>
              <div className="space-y-1.5">
                {signal.topBullishSignals.map((s, i) => (
                  <a key={i} href={s.url || undefined} target="_blank" rel="noreferrer"
                    className="block text-[var(--text)] text-[11px] hover:text-emerald-400 leading-snug truncate">
                    ↗ {s.headline} <span className="text-[var(--muted)]">· {s.source}</span>
                  </a>
                ))}
              </div>
            </Card>
          )}
          {signal.topBearishSignals?.length > 0 && (
            <Card>
              <Label>Top bearish</Label>
              <div className="space-y-1.5">
                {signal.topBearishSignals.map((s, i) => (
                  <a key={i} href={s.url || undefined} target="_blank" rel="noreferrer"
                    className="block text-[var(--text)] text-[11px] hover:text-red-400 leading-snug truncate">
                    ↗ {s.headline} <span className="text-[var(--muted)]">· {s.source}</span>
                  </a>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ─── QUANT PANEL ─────────────────────────────────────────────
function QuantPanel({ data, loading, ticker }) {
  const [tab, setTab] = useState("overview");
  if (loading) return (
    <Card>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
        <p className="text-[var(--muted)] text-xs">Loading quant metrics for {ticker}…</p>
      </div>
    </Card>
  );
  if (!data) return null;

  const f = data.finnhub || {};
  const d = data.derived || {};
  const fcf = data.fcfSeries || [];

  const TABS = [["overview", "Overview"], ["fcf", "FCF"], ["earnings", "Earnings"]];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Quant metrics · {ticker}</Label>
        <div className="flex gap-1">
          {TABS.map(([id, name]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`text-[10px] px-2 py-1 rounded-lg border font-bold transition-colors ${tab === id ? "border-violet-500/40 text-violet-400 bg-violet-500/10" : "border-[var(--border)] text-[var(--muted)]"}`}>
              {name}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            ["EV/EBITDA",      f.evToEbitda != null ? f.evToEbitda.toFixed(1) + "×" : "—"],
            ["P/FCF",          f.pFcf != null ? f.pFcf.toFixed(1) + "×" : "—"],
            ["Net Debt/EBITDA",f.netDebtToEbitda != null ? f.netDebtToEbitda.toFixed(1) + "×" : (d.netDebtLabel || "—")],
            ["ROIC",           f.roic != null ? f.roic + "%" : "—"],
            ["Gross Margin",   f.grossMargin != null ? f.grossMargin + "%" : "—"],
            ["Op. Margin",     f.operatingMargin != null ? f.operatingMargin + "%" : "—"],
            ["Rev CAGR 3y",    f.revenueGrowth3Y != null ? f.revenueGrowth3Y + "%" : "—"],
            ["FCF CAGR 3y",    d.fcfCagr3y != null ? d.fcfCagr3y + "%" : "—"],
            ["Beta",           f.beta != null ? f.beta.toFixed(2) : "—"],
            ["CapEx intensity",d.capexIntensity != null ? d.capexIntensity + "% OCF" : "—"],
            ["CapEx trend",    d.capexTrend || "—"],
            ["Gross M tier",   d.grossMarginTier || "—"],
          ].map(([label, value]) => (
            <div key={label} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-2.5">
              <p className="text-[var(--muted)] text-[9px] uppercase tracking-wide">{label}</p>
              <p className="text-[var(--text)] text-sm font-bold mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      )}

      {tab === "fcf" && (
        <Card>
          <p className="text-[var(--muted)] text-[9px] uppercase tracking-widest mb-2">Free Cash Flow · annual ($M)</p>
          {fcf.length === 0 ? (
            <p className="text-[var(--muted)] text-xs">FCF data not available for {ticker} (non-US filer or EDGAR lookup failed)</p>
          ) : (
            <table className="w-full text-[10px] border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {["FY", "OCF", "CapEx", "FCF"].map(h => (
                    <th key={h} className="text-right text-[var(--muted)] font-bold py-1 px-2 first:text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fcf.map((row) => (
                  <tr key={row.fy} className="border-b border-[var(--border)]/40 hover:bg-[var(--bg)] transition-colors">
                    <td className="py-1.5 px-2 text-[var(--text)] font-bold">{row.fy}</td>
                    <td className="py-1.5 px-2 text-right text-[var(--muted)]">{fmtB(row.ocf)}</td>
                    <td className="py-1.5 px-2 text-right text-[var(--muted)]">({fmtB(row.capex)})</td>
                    <td className="py-1.5 px-2 text-right font-bold font-mono">
                      <span className={row.fcf >= 0 ? "text-emerald-400" : "text-red-400"}>
                        {fmtB(row.fcf)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* Visual FCF bar chart */}
          {fcf.length > 0 && (
            <div className="mt-3">
              <div className="flex items-end gap-2 h-16">
                {fcf.slice().reverse().map((row) => {
                  const maxAbs = Math.max(...fcf.map(r => Math.abs(r.fcf)), 1);
                  const pct = Math.abs(row.fcf) / maxAbs;
                  const positive = row.fcf >= 0;
                  return (
                    <div key={row.fy} className="flex-1 flex flex-col items-center gap-0.5" title={`${row.fy}: ${fmtB(row.fcf)}`}>
                      {positive && (
                        <div className="w-full bg-emerald-500/50 rounded-t-sm transition-all"
                          style={{ height: (pct * 56) + "px" }} />
                      )}
                      {!positive && (
                        <div className="w-full bg-red-500/50 rounded-t-sm mt-auto transition-all"
                          style={{ height: (pct * 56) + "px" }} />
                      )}
                      <span className="text-[8px] text-[var(--muted)]">{row.fy}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      )}

      {tab === "earnings" && (
        <Card>
          <p className="text-[var(--muted)] text-[9px] uppercase tracking-widest mb-2">Earnings surprise history</p>
          {!data.earningsSurprise?.length ? (
            <p className="text-[var(--muted)] text-xs">Earnings data not available (check FINNHUB_KEY)</p>
          ) : (
            <table className="w-full text-[10px] border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {["Period", "Estimate", "Actual", "Surprise %"].map(h => (
                    <th key={h} className="text-right text-[var(--muted)] font-bold py-1 px-2 first:text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.earningsSurprise.map((e, i) => (
                  <tr key={i} className="border-b border-[var(--border)]/40 hover:bg-[var(--bg)] transition-colors">
                    <td className="py-1.5 px-2 text-[var(--text)] font-medium">{e.period}</td>
                    <td className="py-1.5 px-2 text-right text-[var(--muted)]">
                      {e.estimate != null ? "$" + e.estimate.toFixed(2) : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right text-[var(--text)] font-bold">
                      {e.actual != null ? "$" + e.actual.toFixed(2) : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right font-bold font-mono">
                      {e.surprisePct != null ? (
                        <span className={e.surprisePct >= 0 ? "text-emerald-400" : "text-red-400"}>
                          {e.surprisePct >= 0 ? "+" : ""}{e.surprisePct}%
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

// ─── INSTITUTIONAL PANEL ──────────────────────────────────────
function InstitutionalPanel({ ip }) {
  const moveColor = (d) => (d === "accumulating" ? "green" : d === "trimming" ? "red" : "gray");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Institutional positioning · 13F holders + insiders</Label>
        <Pill color={dirColor(ip.netInstitutionalDirection)}>net {ip.netInstitutionalDirection}</Pill>
      </div>
      <Card accent>
        <div className="grid grid-cols-3 gap-2">
          {[
            ["Inst. owned",  ip.institutionsPercentHeld != null ? ip.institutionsPercentHeld + "%" : "—"],
            ["Filers",       ip.institutionsCount != null ? ip.institutionsCount.toLocaleString() : "—"],
            ["Insiders own", ip.insidersPercentHeld != null ? ip.insidersPercentHeld + "%" : "—"],
          ].map(([k, v]) => (
            <div key={k} className="bg-[var(--bg)] border border-[var(--border)] rounded-xl p-2">
              <p className="text-[var(--muted)] text-[9px] uppercase">{k}</p>
              <p className="text-[var(--text)] text-sm font-bold">{v}</p>
            </div>
          ))}
        </div>
        {ip.summary && <p className="text-[var(--muted)] text-[11px] mt-2 leading-relaxed">{ip.summary}</p>}
        {ip.insiderNetPercent != null && (
          <p className="text-[11px] mt-1.5">
            <span className="text-[var(--muted)]">Insider net: </span>
            <span className={ip.insiderDirection === "bullish" ? "text-emerald-400 font-bold" : ip.insiderDirection === "bearish" ? "text-red-400 font-bold" : "text-[var(--muted)]"}>
              {ip.insiderNetPercent >= 0 ? "+" : ""}{ip.insiderNetPercent}% ({ip.insiderDirection})
            </span>
          </p>
        )}
      </Card>

      {ip.topHolders?.length > 0 && (
        <div>
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-1.5">Top holders</p>
          <div className="space-y-1.5">
            {ip.topHolders.map((h, i) => (
              <div key={i} className="flex items-center gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
                <span className="text-[var(--text)] text-xs font-semibold truncate flex-1">{h.name}</span>
                <span className="text-[var(--muted)] text-[10px] w-12 text-right">{h.pctHeld != null ? h.pctHeld + "%" : "—"}</span>
                <span className="text-[var(--muted)] text-[10px] w-14 text-right">{fmtB(h.value)}</span>
                {h.pctChange != null && (
                  <span className={`text-[10px] w-12 text-right font-bold ${h.pctChange > 0 ? "text-emerald-400" : h.pctChange < 0 ? "text-red-400" : "text-[var(--muted)]"}`}>
                    {h.pctChange > 0 ? "+" : ""}{h.pctChange}%
                  </span>
                )}
                <Pill color={moveColor(h.direction)}>{h.direction}</Pill>
              </div>
            ))}
          </div>
        </div>
      )}

      {ip.recentInsiderTx?.length > 0 && (
        <div>
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-1.5">Insider transactions</p>
          <div className="space-y-1.5">
            {ip.recentInsiderTx.map((t, i) => (
              <div key={i} className="flex items-center gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
                <Pill color={t.action === "BUY" ? "green" : t.action === "SELL" ? "red" : "gray"}>{t.action}</Pill>
                <span className="text-[var(--text)] text-xs truncate flex-1">
                  {t.filer}<span className="text-[var(--muted)]">{t.relation ? " · " + t.relation : ""}</span>
                </span>
                {t.value != null && <span className="text-[var(--muted)] text-[10px]">{fmtB(t.value)}</span>}
                {t.date && <span className="text-[var(--muted)] text-[10px]">{t.date}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TRANSMISSION TREE ────────────────────────────────────────
// Indented CSS tree. Depth = path.length - 1 so the root shock
// sits at indent 0, first-order effects at 1, second-order at 2.
function TransmissionTree({ nodes }) {
  if (!nodes?.length) return null;
  const sorted = [...nodes].sort((a, b) => (a.order || 0) - (b.order || 0));

  // Track which depths are "still open" for drawing vertical guides
  const depthActive = {};

  return (
    <div className="font-mono text-xs space-y-0">
      {sorted.map((n, idx) => {
        const depth   = Math.max(0, (n.path?.length ?? 1) - 1);
        const isLast  = idx === sorted.length - 1 ||
          (sorted[idx + 1] && Math.max(0, (sorted[idx + 1].path?.length ?? 1) - 1) < depth);
        const color   = n.direction === "negative" || n.direction === "bearish" ? "text-red-400"
          : n.direction === "positive" || n.direction === "bullish" ? "text-emerald-400"
          : "text-amber-400";

        // Track last node at each depth so we know where to draw └ vs ├
        depthActive[depth] = idx;

        return (
          <div key={idx} className="flex flex-col">
            <div className="flex items-start">
              {/* Indent + connector */}
              <span className="flex-shrink-0 select-none" style={{ minWidth: `${depth * 16 + 4}px` }}>
                {depth === 0
                  ? <span className="text-violet-400 mr-1">●</span>
                  : <span className="text-[var(--muted)]" style={{ paddingLeft: `${(depth - 1) * 16}px` }}>
                      {isLast ? "└─" : "├─"}
                    </span>
                }
              </span>

              {/* Node content */}
              <div className="flex-1 min-w-0 pb-2 ml-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[var(--text)] font-bold">{n.node}</span>
                  <span className={`text-[9px] uppercase font-bold ${color}`}>{n.direction}</span>
                  {n.magnitude?.estimate && (
                    <span className="text-[var(--muted)] text-[9px]">
                      {n.magnitude.metric}: {n.magnitude.estimate}
                      {n.magnitude.horizon && ` · ${n.magnitude.horizon}`}
                    </span>
                  )}
                  {n.confidence != null && (
                    <span className="text-[var(--muted)] text-[9px]">
                      conf {Math.round(n.confidence * 100)}%
                    </span>
                  )}
                </div>
                <p className="text-[var(--muted)] text-[10px] leading-relaxed mt-0.5">{n.mechanism}</p>
                {n.evidence?.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {n.evidence.slice(0, 2).map((e, j) => (
                      <a key={j} href={e.url} target="_blank" rel="noreferrer"
                        className="block text-[9px] text-violet-400/60 hover:text-violet-400 truncate">
                        ↗ {e.claim}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── IMPACT DOSSIER ──────────────────────────────────────────
function ImpactDossier({ impact }) {
  return (
    <div className="space-y-3">
      {/* Verdict */}
      <Card accent>
        <div className="flex items-center justify-between mb-2">
          <Label>Verdict</Label>
          <div className="flex items-center gap-2">
            <Pill color={dirColor(impact.netDirection)}>{impact.netDirection}</Pill>
            {impact.confidence != null && (
              <span className="text-[var(--muted)] text-[10px]">conf {Math.round(impact.confidence * 100)}%</span>
            )}
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
        {impact.estimatedImpact?.caveat && (
          <p className="text-[var(--muted)] text-[10px] mt-2 italic">{impact.estimatedImpact.caveat}</p>
        )}
      </Card>

      {/* Transmission tree */}
      {impact.transmission?.length > 0 && (
        <Card>
          <Label>Transmission — how the shock travels</Label>
          <TransmissionTree nodes={impact.transmission} />
        </Card>
      )}

      {/* Bull / Bear */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Card>
          <Label>Bull case</Label>
          <p className="text-[var(--text)] text-xs leading-relaxed">{impact.bullCase}</p>
        </Card>
        <Card>
          <Label>Bear case</Label>
          <p className="text-[var(--text)] text-xs leading-relaxed">{impact.bearCase}</p>
        </Card>
      </div>

      {/* Watch / Falsifiers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {impact.watchItems?.length > 0 && (
          <Card>
            <Label>Watch for</Label>
            <ul className="space-y-1">
              {impact.watchItems.map((w, i) => (
                <li key={i} className="text-[var(--text)] text-xs flex gap-2">
                  <span className="text-violet-400 flex-shrink-0">•</span>{w}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {impact.falsifiers?.length > 0 && (
          <Card>
            <Label>Falsifiers</Label>
            <ul className="space-y-1">
              {impact.falsifiers.map((f, i) => (
                <li key={i} className="text-[var(--text)] text-xs flex gap-2">
                  <span className="text-red-400 flex-shrink-0">✕</span>{f}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── ONTOLOGY VIEW ────────────────────────────────────────────
function OntologyView({ onto }) {
  const groups = [
    ["Segments",     onto.segments,     (x) => x.name,                                (x) => x.revenuePct != null ? x.revenuePct + "%" : null],
    ["Geographies",  onto.geographies,  (x) => x.region,                              (x) => x.revenuePct != null ? x.revenuePct + "%" : null],
    ["Customers",    onto.customers,    (x) => x.name,                                (x) => x.materiality],
    ["Suppliers",    onto.suppliers,    (x) => `${x.name}${x.input ? " · " + x.input : ""}`, (x) => x.criticality],
    ["Competitors",  onto.competitors,  (x) => x.name,                                (x) => x.threat],
    ["Dependencies", onto.dependencies, (x) => x.name,                                (x) => x.type],
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
              {onto.company.moatTrend && (
                <Pill color={onto.company.moatTrend === "widening" ? "green" : onto.company.moatTrend === "eroding" ? "red" : "gray"}>
                  {onto.company.moatTrend}
                </Pill>
              )}
            </div>
          )}
        </Card>
      )}
      {groups.map(([title, arr, name, tag]) => arr?.length > 0 && (
        <div key={title}>
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-1.5">{title}</p>
          <div className="space-y-1.5">
            {arr.map((x, i) => (
              <div key={i} className="flex items-center justify-between gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
                <span className="text-[var(--text)] text-xs truncate flex-1">{name(x)}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {tag(x) && (
                    <Pill color={/single-source|high/.test(String(tag(x))) ? "red" : "gray"}>{tag(x)}</Pill>
                  )}
                  {x.confidence != null && (
                    <span className="text-[var(--muted)] text-[9px]">{Math.round(x.confidence * 100)}%</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── ACCURACY BOARD ──────────────────────────────────────────
// Enhanced: shows α, β, posterior mean, confidence tier
function AccuracyBoard({ rows }) {
  if (!rows.length) return (
    <Card>
      <p className="text-[var(--muted)] text-xs">
        No accuracy data yet — a source needs 10+ resolved signals (scored 7 days after firing).
      </p>
    </Card>
  );

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="grid grid-cols-[1fr_60px_60px_60px_80px] gap-1 px-3 pb-1 border-b border-[var(--border)]">
        {["Source", "Signals", "α", "β", "Post. mean"].map(h => (
          <span key={h} className="text-[9px] font-bold uppercase text-[var(--muted)] text-right first:text-left">{h}</span>
        ))}
      </div>
      {rows.map((r, i) => {
        const acc = r.accuracy_rate ?? r.accuracy ?? 0;
        const total = r.total_signals ?? r.total ?? 0;
        const adj = r.credibility_adj ?? r.credibilityAdj ?? 0;
        const alpha = r.alpha ?? null;
        const beta  = r.beta  ?? null;
        const postMean = r.posterior_mean ?? (alpha != null && beta != null ? alpha / (alpha + beta) : acc);
        const postStd  = r.posterior_std ?? null;
        const conf     = r.confidence ?? (postStd != null ? (postStd < 0.10 ? "high" : postStd < 0.15 ? "medium" : "low") : null);
        const confColor = conf === "high" ? "green" : conf === "medium" ? "amber" : "gray";

        return (
          <div key={i} className="bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
            <div className="grid grid-cols-[1fr_60px_60px_60px_80px] gap-1 items-center mb-1">
              <span className="text-[var(--text)] text-xs font-bold truncate">{r.source_key}</span>
              <span className="text-[var(--muted)] text-[10px] text-right">{total}</span>
              <span className="text-[var(--muted)] text-[10px] font-mono text-right">{alpha != null ? alpha.toFixed(1) : "—"}</span>
              <span className="text-[var(--muted)] text-[10px] font-mono text-right">{beta  != null ? beta.toFixed(1)  : "—"}</span>
              <div className="flex items-center gap-1 justify-end">
                <span className={`text-[10px] font-bold font-mono ${postMean >= 0.55 ? "text-emerald-400" : postMean <= 0.45 ? "text-red-400" : "text-[var(--muted)]"}`}>
                  {Math.round(postMean * 100)}%
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Accuracy bar */}
              <div className="flex-1 bg-[var(--bg)] rounded-full h-1.5 overflow-hidden">
                <div className={`h-full rounded-full ${postMean >= 0.55 ? "bg-emerald-500/60" : postMean <= 0.45 ? "bg-red-500/60" : "bg-zinc-600"}`}
                  style={{ width: (postMean * 100) + "%" }} />
              </div>
              {adj !== 0 && (
                <span className={`text-[9px] font-bold ${adj > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {adj > 0 ? "+" : ""}{adj.toFixed(2)}
                </span>
              )}
              {conf && <Pill color={confColor}>{conf}</Pill>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── SIGNAL HISTORY ──────────────────────────────────────────
function SignalHistory({ rows, ticker }) {
  if (!rows.length) return (
    <Card>
      <p className="text-[var(--muted)] text-xs">
        No signals{ticker ? ` for ${ticker}` : ""} yet — run an analysis to populate history.
        Outcomes resolve 7 days after a signal fires.
      </p>
    </Card>
  );
  return (
    <div className="space-y-1.5">
      {rows.map((s, i) => (
        <div key={s.id ?? i} className="bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
          <div className="flex items-center gap-2">
            <Pill color={dirColor(s.direction)}>{s.direction}</Pill>
            <span className="text-[var(--muted)] text-[10px] truncate flex-1">{s.source}</span>
            {s.corroborated && <Pill color="violet">corroborated</Pill>}
            {s.correct != null && <Pill color={s.correct ? "green" : "red"}>{s.correct ? "✓ right" : "✗ wrong"}</Pill>}
          </div>
          {s.headline && (
            <p className="text-[var(--text)] text-[11px] mt-1 leading-snug">
              {s.url
                ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-violet-400">{s.headline}</a>
                : s.headline}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
