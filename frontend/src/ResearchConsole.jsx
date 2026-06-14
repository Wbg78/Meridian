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

const STAGE_ORDER = ["resolve", "signals", "edgar", "ontology", "crisis", "done"];
const STAGE_NAME = { resolve: "Resolve ticker", signals: "Positioning signals", edgar: "SEC EDGAR pull", ontology: "Entity graph", crisis: "Shock propagation", done: "Dossier" };

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
  const [twBudget, setTwBudget] = useState(null);
  const [accuracy, setAccuracy] = useState([]);
  const [sigHistory, setSigHistory] = useState([]);
  const [intelTab, setIntelTab] = useState("accuracy");
  const abortRef = useRef(null);

  // Load the scenario library + recent history + signal intel once.
  useEffect(() => {
    if (!token) return;
    let c = false;
    const get = (path) => fetch(`${BACKEND_URL}/api/research/${path}`, { headers: auth(token) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    get("shocks").then((d) => { if (!c && Array.isArray(d)) setShocks(d); });
    get("runs").then((d) => { if (!c && Array.isArray(d)) setRuns(d); });
    get("accuracy").then((d) => { if (!c && Array.isArray(d)) setAccuracy(d); });
    get("twitter-budget").then((d) => { if (!c && d && !d.error) setTwBudget(d); });
    return () => { c = true; };
  }, [token]);

  // Refresh per-ticker signal history whenever a result loads.
  useEffect(() => {
    if (!token || !result?.ticker) return;
    let c = false;
    fetch(`${BACKEND_URL}/api/research/signals/${result.ticker}`, { headers: auth(token) })
      .then((r) => (r.ok ? r.json() : [])).then((d) => { if (!c) setSigHistory(Array.isArray(d) ? d : []); }).catch(() => {});
    return () => { c = true; };
  }, [token, result?.ticker]);

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
        <div className="flex items-center justify-between gap-2 mb-2">
          <Label>Deep research · ticker + crisis</Label>
          {twBudget && (
            <span title={`X/Twitter: ${(twBudget.monthlyUsed ?? 0).toLocaleString()} / ${(twBudget.monthlyBudget ?? 0).toLocaleString()} tweet reads this month`}>
              <Pill color={twBudget.monthlyPct > 90 ? "red" : twBudget.monthlyPct > 70 ? "amber" : "gray"}>𝕏 {twBudget.monthlyPct ?? 0}% used</Pill>
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
                : st === "warn" ? "bg-amber-500"
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

      {/* ── Positioning signals ── */}
      {result?.positioningSignal && <SignalPanel signal={result.positioningSignal} anomalies={result.anomalies} />}

      {/* ── Institutional positioning (13F holders + insiders) ── */}
      {result?.positioningSignal?.institutionalPositioning && <InstitutionalPanel ip={result.positioningSignal.institutionalPositioning} />}

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

      {/* ── Signal intelligence (accuracy leaderboard + per-ticker history) ── */}
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
          {intelTab === "accuracy" ? <AccuracyBoard rows={accuracy} /> : <SignalHistory rows={sigHistory} ticker={result?.ticker} />}
        </div>
      )}
    </div>
  );
}

// Source-accuracy leaderboard — how often each source's signals proved
// right (resolved 7 days after firing). Handles both the Postgres row
// shape (accuracy_rate/total_signals/credibility_adj) and the in-memory
// shape (accuracy/total/credibilityAdj).
function AccuracyBoard({ rows }) {
  if (!rows.length) return <Card><p className="text-[var(--muted)] text-xs">No accuracy data yet — a source needs 10+ resolved signals (each scored 7 days after it fired) before it's ranked.</p></Card>;
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => {
        const acc = r.accuracy_rate ?? r.accuracy ?? 0;
        const total = r.total_signals ?? r.total ?? 0;
        const adj = r.credibility_adj ?? r.credibilityAdj ?? 0;
        return (
          <div key={i} className="flex items-center gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
            <span className="text-[var(--text)] text-xs font-bold flex-1 truncate">{r.source_key}</span>
            <span className="text-[var(--muted)] text-[10px]">{total} signals</span>
            {adj !== 0 && <span className={`text-[10px] font-bold ${adj > 0 ? "text-emerald-400" : "text-red-400"}`}>{adj > 0 ? "+" : ""}{adj.toFixed(2)}</span>}
            <Pill color={acc >= 0.6 ? "green" : acc >= 0.45 ? "amber" : "red"}>{Math.round(acc * 100)}% acc</Pill>
          </div>
        );
      })}
    </div>
  );
}

// Per-ticker recorded signal history, with right/wrong outcome once resolved.
function SignalHistory({ rows, ticker }) {
  if (!rows.length) return <Card><p className="text-[var(--muted)] text-xs">No recorded signals{ticker ? ` for ${ticker}` : ""} yet — run an analysis to populate history. Outcomes resolve 7 days after a signal fires.</p></Card>;
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
          {s.headline && <p className="text-[var(--text)] text-[11px] mt-1 leading-snug">{s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-violet-400">{s.headline}</a> : s.headline}</p>}
        </div>
      ))}
    </div>
  );
}

// Positioning signals gathered before the ontology build — what the
// market is doing (insiders, news, analysts, retail, optional Twitter),
// bias-corrected and weighted, plus any anomalies the tracker flagged.
function SignalPanel({ signal, anomalies = [] }) {
  const sb = signal.sourceBreakdown || {};
  const empty = !signal.totalSignals;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Market positioning · before fundamentals</Label>
        <div className="flex items-center gap-2">
          <Pill color={dirColor(signal.direction)}>{signal.direction}</Pill>
          {signal.confidence != null && <span className="text-[var(--muted)] text-[10px]">conf {Math.round(signal.confidence * 100)}%</span>}
        </div>
      </div>

      {/* Anomaly warnings — prominent */}
      {anomalies.length > 0 && anomalies.map((a, i) => (
        <Card key={i} className="border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2 mb-1">
            <Pill color="amber">⚠ {String(a.type || a.anomaly_type || "anomaly").replace(/_/g, " ")}</Pill>
          </div>
          <p className="text-amber-200/90 text-xs leading-relaxed">{a.description}</p>
        </Card>
      ))}

      <Card accent={!empty}>
        {empty ? (
          <p className="text-[var(--muted)] text-xs">{signal.conflictNote || "No positioning signals found for this ticker right now (free sources can be sparse — adding NewsAPI/Finnhub keys widens coverage)."}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 mb-3">
              <span className="text-[var(--text)] text-xs font-bold">{signal.totalSignals} signals</span>
              <span className="text-emerald-400 text-xs">{signal.bullSignals} bull</span>
              <span className="text-red-400 text-xs">{signal.bearSignals} bear</span>
              <span className="text-[var(--muted)] text-xs">{signal.neutralSignals} neutral</span>
              {signal.corroborationMultiplier != null && <span className="text-[var(--muted)] text-[10px] ml-auto">corroboration ×{signal.corroborationMultiplier}</span>}
            </div>

            {/* source breakdown */}
            <div className="grid grid-cols-5 gap-1.5 mb-3">
              {[["SEC", sb.sec], ["News", sb.news], ["Reddit", sb.reddit], ["Analyst", sb.analyst], ["X", sb.twitter]].map(([k, v]) => (
                <div key={k} className="bg-[var(--bg)] border border-[var(--border)] rounded-lg p-1.5 text-center">
                  <p className="text-[var(--text)] text-xs font-bold">{v ?? 0}</p>
                  <p className="text-[var(--muted)] text-[9px] uppercase">{k}</p>
                </div>
              ))}
            </div>

            {signal.keyDriver && (
              <div className="mb-2">
                <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-1">Key driver</p>
                <a href={signal.keyDriver.url || undefined} target="_blank" rel="noreferrer" className="text-[var(--text)] text-xs hover:text-violet-400 leading-snug block">
                  {signal.keyDriver.headline}
                  <span className="text-[var(--muted)]"> · {signal.keyDriver.source}</span>
                </a>
              </div>
            )}

            {signal.hasConflict && signal.conflictNote && (
              <p className="text-amber-400 text-[11px] mt-2">⚠ {signal.conflictNote}</p>
            )}
            {signal.politicalBiasNote && <p className="text-[var(--muted)] text-[10px] mt-2 italic">{signal.politicalBiasNote}</p>}
            {signal.learningNote && <p className="text-violet-400/80 text-[10px] mt-1">{signal.learningNote}</p>}
          </>
        )}
      </Card>

      {/* top signals by direction */}
      {(signal.topBullishSignals?.length > 0 || signal.topBearishSignals?.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {signal.topBullishSignals?.length > 0 && (
            <Card><Label>Top bullish</Label>
              <div className="space-y-1.5">{signal.topBullishSignals.map((s, i) => (
                <a key={i} href={s.url || undefined} target="_blank" rel="noreferrer" className="block text-[var(--text)] text-[11px] hover:text-emerald-400 leading-snug truncate">↗ {s.headline} <span className="text-[var(--muted)]">· {s.source}</span></a>
              ))}</div>
            </Card>
          )}
          {signal.topBearishSignals?.length > 0 && (
            <Card><Label>Top bearish</Label>
              <div className="space-y-1.5">{signal.topBearishSignals.map((s, i) => (
                <a key={i} href={s.url || undefined} target="_blank" rel="noreferrer" className="block text-[var(--text)] text-[11px] hover:text-red-400 leading-snug truncate">↗ {s.headline} <span className="text-[var(--muted)]">· {s.source}</span></a>
              ))}</div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// Institutional positioning — each major holder's current stake, dollar
// value, and quarter-over-quarter change, plus insider net buying. The
// "net" verdict is stake × recency × direction weighted (big holders adding
// count more than small holders trimming).
function InstitutionalPanel({ ip }) {
  const fmtB = (v) => (v == null ? "—" : Math.abs(v) >= 1e9 ? "$" + (v / 1e9).toFixed(1) + "B" : Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(0) + "M" : "$" + v);
  const moveColor = (d) => (d === "accumulating" ? "green" : d === "trimming" ? "red" : "gray");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Institutional positioning · 13F holders + insiders</Label>
        <Pill color={dirColor(ip.netInstitutionalDirection)}>net {ip.netInstitutionalDirection}</Pill>
      </div>

      <Card accent>
        <div className="grid grid-cols-3 gap-2">
          {[["Inst. owned", ip.institutionsPercentHeld != null ? ip.institutionsPercentHeld + "%" : "—"],
            ["Filers", ip.institutionsCount != null ? ip.institutionsCount.toLocaleString() : "—"],
            ["Insiders own", ip.insidersPercentHeld != null ? ip.insidersPercentHeld + "%" : "—"]].map(([k, v]) => (
            <div key={k} className="bg-[var(--bg)] border border-[var(--border)] rounded-xl p-2">
              <p className="text-[var(--muted)] text-[9px] uppercase">{k}</p>
              <p className="text-[var(--text)] text-sm font-bold">{v}</p>
            </div>
          ))}
        </div>
        {ip.summary && <p className="text-[var(--muted)] text-[11px] mt-2 leading-relaxed">{ip.summary}</p>}
        {ip.insiderNetPercent != null && (
          <p className="text-[11px] mt-1.5">
            <span className="text-[var(--muted)]">Insider net activity: </span>
            <span className={ip.insiderDirection === "bullish" ? "text-emerald-400 font-bold" : ip.insiderDirection === "bearish" ? "text-red-400 font-bold" : "text-[var(--muted)]"}>
              {ip.insiderNetPercent >= 0 ? "+" : ""}{ip.insiderNetPercent}% ({ip.insiderDirection})
            </span>
          </p>
        )}
      </Card>

      {/* top holders table */}
      {ip.topHolders?.length > 0 && (
        <div>
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-1.5">Top holders · current position</p>
          <div className="space-y-1.5">
            {ip.topHolders.map((h, i) => (
              <div key={i} className="flex items-center gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
                <span className="text-[var(--text)] text-xs font-semibold truncate flex-1">{h.name}</span>
                <span className="text-[var(--muted)] text-[10px] w-12 text-right flex-shrink-0">{h.pctHeld != null ? h.pctHeld + "%" : "—"}</span>
                <span className="text-[var(--muted)] text-[10px] w-14 text-right flex-shrink-0">{fmtB(h.value)}</span>
                {h.pctChange != null && (
                  <span className={`text-[10px] w-12 text-right flex-shrink-0 font-bold ${h.pctChange > 0 ? "text-emerald-400" : h.pctChange < 0 ? "text-red-400" : "text-[var(--muted)]"}`}>
                    {h.pctChange > 0 ? "+" : ""}{h.pctChange}%
                  </span>
                )}
                <Pill color={moveColor(h.direction)}>{h.direction}</Pill>
              </div>
            ))}
          </div>
          <p className="text-[var(--muted)] text-[9px] mt-1.5 italic">% = share of company held · $ = position value · last column = quarter-over-quarter change</p>
        </div>
      )}

      {/* recent insider transactions */}
      {ip.recentInsiderTx?.length > 0 && (
        <div>
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-1.5">Recent insider transactions</p>
          <div className="space-y-1.5">
            {ip.recentInsiderTx.map((t, i) => (
              <div key={i} className="flex items-center gap-2 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
                <Pill color={t.action === "BUY" ? "green" : t.action === "SELL" ? "red" : "gray"}>{t.action}</Pill>
                <span className="text-[var(--text)] text-xs truncate flex-1">{t.filer}<span className="text-[var(--muted)]">{t.relation ? " · " + t.relation : ""}</span></span>
                {t.value != null && <span className="text-[var(--muted)] text-[10px] flex-shrink-0">{fmtB(t.value)}</span>}
                {t.date && <span className="text-[var(--muted)] text-[10px] flex-shrink-0">{t.date}</span>}
              </div>
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
