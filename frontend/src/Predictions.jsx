// frontend/src/Predictions.jsx
// Prediction Markets — READ-ONLY calibration training feed.
// Hierarchy: Predictions → [Feed | My Predictions | Calibration] × [niche selector]
//
// Data: Polymarket public API via backend (no auth).
// Kalshi: stubbed for v1.
// Storage: prediction_log + base_rate_library + niche_config in Postgres.

import { useState, useEffect, useCallback, useRef } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ─── SHARED PRIMITIVES (match App.jsx) ─────────────────────────
function Pill({ color, children, sm }) {
  const sz = sm ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-0.5";
  const c = {
    green:  "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25",
    red:    "bg-red-500/15 text-red-400 border border-red-500/25",
    violet: "bg-violet-500/15 text-violet-400 border border-violet-500/25",
    amber:  "bg-amber-500/15 text-amber-400 border border-amber-500/25",
    sky:    "bg-sky-500/15 text-sky-400 border border-sky-500/25",
    gray:   "bg-zinc-700/40 text-zinc-400 border border-zinc-700/40",
  };
  return (
    <span className={`font-bold rounded-full tracking-widest uppercase ${sz} ${c[color] || c.gray}`}>
      {children}
    </span>
  );
}

function Card({ children, className = "", accent, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`rounded-2xl p-4 border transition-all ${
        accent
          ? "border-violet-500/30 bg-violet-500/5"
          : "border-[var(--border)] bg-[var(--card)]"
      } ${className}`}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <p className="text-[11px] font-bold tracking-[0.12em] uppercase text-[var(--muted)] mb-3">
      {children}
    </p>
  );
}

function StatCard({ label, value, sub, trend }) {
  return (
    <Card>
      <p className="text-[10px] uppercase tracking-widest font-semibold text-[var(--muted)]">{label}</p>
      <p className="text-[var(--text)] text-xl font-bold mt-1 tracking-tight">{value}</p>
      {sub && (
        <p className={`text-xs font-semibold mt-0.5 ${
          trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-[var(--muted)]"
        }`}>{sub}</p>
      )}
    </Card>
  );
}

// ─── CALIBRATION CURVE ──────────────────────────────────────────
function CalibrationCurve({ curve }) {
  if (!curve?.length) {
    return (
      <div className="text-center text-[var(--muted)] text-xs py-8">
        Resolve at least one prediction to see your calibration curve.
      </div>
    );
  }

  const W = 280, H = 200, PAD = 30;
  const toX = v => PAD + v * (W - 2 * PAD);
  const toY = v => H - PAD - v * (H - 2 * PAD);

  const pts = curve.map(d => `${toX(d.bucket).toFixed(1)},${toY(d.hit_rate).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map(v => (
        <g key={v}>
          <line x1={PAD} y1={toY(v)} x2={W - PAD} y2={toY(v)}
            stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2,4" />
          <line x1={toX(v)} y1={PAD} x2={toX(v)} y2={H - PAD}
            stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2,4" />
          <text x={PAD - 4} y={toY(v) + 3} textAnchor="end" fontSize="6" fill="#71717a">
            {Math.round(v * 100)}
          </text>
          <text x={toX(v)} y={H - 4} textAnchor="middle" fontSize="6" fill="#71717a">
            {Math.round(v * 100)}
          </text>
        </g>
      ))}

      {/* Perfect calibration diagonal (dashed gray) */}
      <line x1={toX(0)} y1={toY(0)} x2={toX(1)} y2={toY(1)}
        stroke="#71717a" strokeWidth="1" strokeDasharray="4,4" />

      {/* My calibration polyline */}
      {curve.length > 1 && (
        <polyline points={pts} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinejoin="round" />
      )}

      {/* Data points with n= labels */}
      {curve.map((d, i) => (
        <g key={i}>
          <circle
            cx={toX(d.bucket)} cy={toY(d.hit_rate)} r="4"
            fill="#8b5cf6" stroke="var(--bg)" strokeWidth="1.5"
          />
          <text
            x={toX(d.bucket)} y={toY(d.hit_rate) - 8}
            textAnchor="middle" fontSize="6.5" fill="#71717a"
          >
            n={d.total}
          </text>
        </g>
      ))}

      {/* Axis labels */}
      <text x={W / 2} y={H} textAnchor="middle" fontSize="7" fill="#71717a">
        Stated probability (%)
      </text>
      <text
        x={8} y={H / 2} textAnchor="middle" fontSize="7" fill="#71717a"
        transform={`rotate(-90, 8, ${H / 2})`}
      >
        Actual hit rate (%)
      </text>
    </svg>
  );
}

// ─── CALIBRATION VIEW ───────────────────────────────────────────
function CalibrationView({ token, niche }) {
  const [data, setData] = useState(null);
  const [err, setErr]   = useState(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setData(null); setErr(null);
    const nicheParam = niche && niche !== "all" ? encodeURIComponent(niche) : "";
    fetch(`${BACKEND_URL}/api/predictions/calibration?niche=${nicheParam}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [token, niche]);

  const brierLabel = (b) => {
    if (b == null) return "";
    if (b < 0.05) return "Excellent";
    if (b < 0.1)  return "Good";
    if (b < 0.2)  return "Fair";
    return "Poor";
  };

  return (
    <div className="space-y-4">
      <Card className="border-violet-500/20 bg-violet-500/5">
        <p className="text-violet-400 text-xs font-semibold">
          📈 Calibration curve — your dots should lie on the dashed diagonal.
          A dot above the line means you were underconfident; below means overconfident.
        </p>
      </Card>

      {err && <Card><p className="text-red-400 text-sm">Couldn't load calibration: {err}</p></Card>}
      {!data && !err && <Card><p className="text-[var(--muted)] text-sm">Loading calibration data…</p></Card>}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Logged" value={data.total_predictions ?? 0} />
            <StatCard label="Resolved" value={data.resolved_predictions ?? 0} />
            <StatCard
              label="Avg Brier"
              value={data.avg_brier_overall != null ? data.avg_brier_overall.toFixed(3) : "—"}
              sub={brierLabel(data.avg_brier_overall)}
              trend={
                data.avg_brier_overall == null ? undefined
                : data.avg_brier_overall < 0.15 ? "up"
                : data.avg_brier_overall > 0.25 ? "down"
                : undefined
              }
            />
          </div>

          <Card>
            <SectionLabel>Calibration Curve</SectionLabel>
            <CalibrationCurve curve={data.curve} />
            <p className="text-[var(--muted)] text-[10px] mt-2">
              Lower Brier is better (0 = perfect, 1 = worst possible).
              Dashed line = perfect calibration.
            </p>
          </Card>

          {data.curve?.length > 0 && (
            <>
              <SectionLabel>Per-bucket breakdown</SectionLabel>
              <div className="space-y-1.5">
                {data.curve.map((d, i) => {
                  const diff = Math.abs(d.bucket - d.hit_rate);
                  const diffColor = diff < 0.05 ? "text-emerald-400" : diff < 0.15 ? "text-amber-400" : "text-red-400";
                  return (
                    <Card key={i}>
                      <div className="flex justify-between items-center text-xs gap-2">
                        <span className="text-[var(--muted)] w-20 flex-shrink-0">
                          {Math.round(d.bucket * 100)}% stated
                        </span>
                        <span className="text-[var(--text)] font-bold">
                          {Math.round(d.hit_rate * 100)}% actual
                        </span>
                        <span className="text-[var(--muted)]">n={d.total}</span>
                        <span className={`font-bold ${diffColor}`}>
                          BS {d.avg_brier?.toFixed(3) ?? "—"}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 rounded-full bg-[var(--border)] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-violet-500"
                          style={{ width: `${Math.round(d.hit_rate * 100)}%` }}
                        />
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}

          {!data.curve?.length && (
            <Card>
              <p className="text-[var(--muted)] text-sm">
                No resolved predictions yet.
                Resolve predictions in the "My Predictions" tab to build your calibration curve.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── PREDICTION LOG VIEW ────────────────────────────────────────
function PredictionLogView({ token, niche }) {
  const [entries,   setEntries]   = useState(null);
  const [resolving, setResolving] = useState(null); // entry id being resolved
  const [err,       setErr]       = useState(null);

  const load = useCallback(() => {
    if (!token) return;
    setErr(null);
    const nicheParam = niche && niche !== "all" ? encodeURIComponent(niche) : "";
    fetch(`${BACKEND_URL}/api/predictions/log?niche=${nicheParam}&limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => setEntries(Array.isArray(d) ? d : []))
      .catch(e => setErr(String(e)));
  }, [token, niche]);

  useEffect(() => { load(); }, [load]);

  async function resolve(id, outcome) {
    setResolving(id);
    try {
      const r = await fetch(`${BACKEND_URL}/api/predictions/log/${id}/resolve`, {
        method:  "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ outcome }),
      });
      if (r.ok) {
        const updated = await r.json();
        setEntries(prev => (prev || []).map(e => e.id === id ? updated : e));
      }
    } catch {}
    setResolving(null);
  }

  return (
    <div className="space-y-3">
      <Card className="border-sky-500/20 bg-sky-500/5">
        <p className="text-sky-400 text-xs font-semibold leading-relaxed">
          📌 Predictions are timestamped before resolution. Brier score = (my_prob − outcome)².
          Perfect score = 0. Worst possible = 1.
        </p>
      </Card>

      {err && <Card><p className="text-red-400 text-sm">{err}</p></Card>}
      {!entries && !err && <Card><p className="text-[var(--muted)] text-sm">Loading…</p></Card>}

      {entries?.length === 0 && (
        <Card>
          <p className="text-[var(--muted)] text-sm">
            No predictions logged yet.
            Open a market in the Feed, expand it, and tap "Lock my probability".
          </p>
        </Card>
      )}

      {(entries || []).map(e => {
        const pending  = e.resolution_outcome == null;
        const brier    = e.brier_score;
        const bsColor  = brier == null ? "text-[var(--muted)]"
          : brier < 0.05 ? "text-emerald-400"
          : brier < 0.15 ? "text-amber-400"
          : "text-red-400";
        const lockedDate = new Date(e.timestamp_locked).toLocaleDateString("en-US", {
          month: "short", day: "numeric", year: "numeric",
        });

        return (
          <Card key={e.id} accent={!pending && brier != null && brier < 0.05}>
            <div className="flex justify-between items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-[var(--text)] text-sm font-semibold leading-snug">{e.question}</p>
                <div className="flex gap-1.5 items-center mt-1.5 flex-wrap">
                  <Pill color="violet" sm>{e.niche}</Pill>
                  <Pill color="sky" sm>{e.venue}</Pill>
                  <Pill
                    color={pending ? "amber" : e.resolution_outcome === 1 ? "green" : "red"}
                    sm
                  >
                    {pending ? "Pending" : e.resolution_outcome === 1 ? "Resolved YES" : "Resolved NO"}
                  </Pill>
                  <span className="text-[var(--muted)] text-[10px]">{lockedDate}</span>
                </div>
              </div>
              <div className="text-right flex-shrink-0 ml-2">
                <p className="text-[var(--text)] font-black text-2xl leading-none">
                  {Math.round(e.my_prob * 100)}%
                </p>
                <p className="text-[var(--muted)] text-[9px] mt-0.5">my prob</p>
                {!pending && brier != null && (
                  <p className={`text-xs font-bold mt-0.5 ${bsColor}`}>
                    BS {brier.toFixed(3)}
                  </p>
                )}
              </div>
            </div>

            {pending && (
              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-2">
                  Mark resolved
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => resolve(e.id, 1)}
                    disabled={resolving === e.id}
                    className="flex-1 text-emerald-400 text-xs font-bold border border-emerald-500/25 rounded-xl py-1.5 bg-emerald-500/5 disabled:opacity-50"
                  >
                    ✓ YES
                  </button>
                  <button
                    onClick={() => resolve(e.id, 0)}
                    disabled={resolving === e.id}
                    className="flex-1 text-red-400 text-xs font-bold border border-red-500/25 rounded-xl py-1.5 bg-red-500/5 disabled:opacity-50"
                  >
                    ✗ NO
                  </button>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ─── BASE-RATE PANEL ────────────────────────────────────────────
// Lazy-loaded when market card is expanded. Fetches from backend (DB + LLM).
function BaseRatePanel({ token, marketId, question, niche, marketProb, divThreshold = 0.15 }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState(null);
  const [editing, setEditing] = useState(false);
  const [editBr,  setEditBr]  = useState("");
  const [editRc,  setEditRc]  = useState("");
  const [saving,  setSaving]  = useState(false);

  useEffect(() => {
    if (!token || !marketId || !question) return;
    let cancelled = false;
    setLoading(true); setErr(null);

    fetch(
      `${BACKEND_URL}/api/predictions/base-rate?market_id=${encodeURIComponent(marketId)}&question=${encodeURIComponent(question)}&niche=${encodeURIComponent(niche || "")}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
      .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(d.error || r.statusText)))
      .then(d  => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setErr(String(e)); setLoading(false); } });

    return () => { cancelled = true; };
  }, [token, marketId, question, niche]);

  async function saveConfirm() {
    const br = parseFloat(editBr);
    if (isNaN(br) || br < 0 || br > 100) return;
    setSaving(true);
    try {
      const r = await fetch(`${BACKEND_URL}/api/predictions/base-rate/confirm`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          market_id:       marketId,
          reference_class: editRc || data?.reference_class,
          base_rate:       br / 100,
          rationale:       data?.rationale || "",
        }),
      });
      if (r.ok) {
        const updated = await r.json();
        setData(updated);
        setEditing(false);
      }
    } catch {}
    setSaving(false);
  }

  if (loading) return <p className="text-[var(--muted)] text-xs py-2">Querying base-rate library…</p>;
  if (err)     return <p className="text-red-400 text-xs py-2">Base rate error: {err}</p>;
  if (!data)   return null;

  const br         = data.base_rate;
  const diverge    = (br != null && marketProb != null) ? Math.abs(marketProb - br) : null;
  const isDiverging = diverge != null && diverge > divThreshold;

  return (
    <div className="space-y-2">
      <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest">
        Historical Base Rate
      </p>

      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[var(--text)] text-sm font-semibold">
            {data.reference_class || "—"}
          </p>
          {data.rationale && (
            <p className="text-[var(--muted)] text-xs leading-relaxed mt-0.5">
              {data.rationale}
            </p>
          )}
          <div className="flex gap-1.5 mt-1 flex-wrap">
            {data.confirmed_by_me && <Pill color="green" sm>✓ Confirmed</Pill>}
            {data.source === "llm" && !data.confirmed_by_me && <Pill color="gray" sm>AI suggestion</Pill>}
            {data.source === "unavailable" && <Pill color="amber" sm>No AI key</Pill>}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-2xl font-black text-emerald-400">
            {br != null ? `${Math.round(br * 100)}%` : "—"}
          </p>
          <p className="text-[var(--muted)] text-[9px]">base rate</p>
        </div>
      </div>

      {/* Divergence indicator */}
      {diverge != null && (
        <div className={`rounded-xl px-3 py-2 text-xs font-semibold ${
          isDiverging
            ? "bg-amber-500/10 border border-amber-500/25 text-amber-400"
            : "bg-[var(--bg)] border border-[var(--border)] text-[var(--muted)]"
        }`}>
          {isDiverging
            ? `⚡ ${Math.round(diverge * 100)}pp divergence — crowd disagrees with history`
            : `${Math.round(diverge * 100)}pp from base rate — within normal range`
          }
        </div>
      )}

      {/* Side-by-side probability bar */}
      {br != null && marketProb != null && (
        <div className="space-y-1">
          <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
            <div
              className="bg-violet-500 flex items-center justify-center"
              style={{ width: `${Math.round(marketProb * 100)}%` }}
              title={`Market: ${Math.round(marketProb * 100)}%`}
            />
            <div className="flex-1 bg-[var(--border)]" />
          </div>
          <div className="flex justify-between text-[10px] text-[var(--muted)]">
            <span>Market <span className="text-violet-400 font-bold">{Math.round(marketProb * 100)}%</span></span>
            <span>Base rate <span className="text-emerald-400 font-bold">{Math.round(br * 100)}%</span></span>
          </div>
        </div>
      )}

      {/* Edit / confirm controls */}
      {!editing ? (
        <button
          onClick={() => { setEditing(true); setEditBr(br != null ? String(Math.round(br * 100)) : ""); setEditRc(data.reference_class || ""); }}
          className="text-[var(--muted)] text-[10px] hover:text-violet-400 font-semibold"
        >
          {data.confirmed_by_me ? "Edit my base rate →" : "Correct / confirm →"}
        </button>
      ) : (
        <div className="space-y-2 pt-1">
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest">Correct base rate</p>
          <input
            value={editRc} onChange={e => setEditRc(e.target.value)}
            placeholder="Reference class label"
            className="w-full bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-1.5 text-xs text-[var(--text)] outline-none focus:border-violet-500/50"
          />
          <div className="flex gap-2 items-center">
            <input
              type="number" min="0" max="100" step="1"
              value={editBr} onChange={e => setEditBr(e.target.value)}
              placeholder="Base rate %"
              className="w-24 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-1.5 text-xs text-[var(--text)] outline-none focus:border-violet-500/50"
            />
            <span className="text-[var(--muted)] text-xs">%</span>
            <button
              onClick={saveConfirm} disabled={saving}
              className="px-3 py-1.5 rounded-xl text-xs font-bold bg-violet-500 text-white disabled:opacity-50"
            >
              {saving ? "…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 rounded-xl text-xs text-[var(--muted)] border border-[var(--border)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MARKET CARD ────────────────────────────────────────────────
function MarketCard({ market, token }) {
  const [expanded, setExpanded]   = useState(false);
  const [logOpen,  setLogOpen]    = useState(false);
  const [myProb,   setMyProb]     = useState("");
  const [logging,  setLogging]    = useState(false);
  const [logged,   setLogged]     = useState(false);
  const [logErr,   setLogErr]     = useState(null);

  const prob    = market.implied_prob_devigged;
  const probPct = Math.round(prob * 100);
  const cwPct   = Math.round(market.confidence_weight * 100);
  const lowSignal = market.confidence_weight < 0.1;

  async function logPrediction() {
    const p = parseFloat(myProb);
    if (isNaN(p) || p < 0 || p > 100) {
      setLogErr("Enter a number between 0 and 100.");
      return;
    }
    setLogging(true); setLogErr(null);
    try {
      const r = await fetch(`${BACKEND_URL}/api/predictions/log`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          market_id: market.id,
          question:  market.question,
          venue:     market.venue,
          my_prob:   p / 100,
          niche:     market.niche_tag,
          metadata: {
            end_date:          market.end_date,
            confidence_weight: market.confidence_weight,
            market_prob:       prob,
          },
        }),
      });
      if (r.ok) {
        setLogged(true);
        setLogOpen(false);
      } else {
        const d = await r.json();
        setLogErr(d.error || "Failed to lock prediction.");
      }
    } catch (e) {
      setLogErr(String(e));
    }
    setLogging(false);
  }

  return (
    <Card className={lowSignal ? "opacity-60" : ""}>
      {/* ── Card header — always visible ── */}
      <div className="cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start justify-between gap-2 mb-2">
          <p className="text-[var(--text)] text-sm font-semibold leading-snug flex-1">
            {market.question}
          </p>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <Pill color="violet" sm>POLY</Pill>
            {lowSignal && <Pill color="gray" sm>Low signal</Pill>}
          </div>
        </div>

        {/* Devigged probability bar */}
        <div className="space-y-1 mb-2">
          <div className="flex justify-between text-xs">
            <span className="text-[var(--muted)]">YES probability (devigged)</span>
            <span className="font-black text-[var(--text)]">{probPct}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-[var(--border)] overflow-hidden">
            <div
              className="h-full rounded-full bg-violet-500 transition-all"
              style={{ width: `${probPct}%` }}
            />
          </div>
        </div>

        {/* Meta row */}
        <div className="flex gap-3 flex-wrap text-[10px] text-[var(--muted)]">
          <span>Vol ${market.volume >= 1000 ? `${(market.volume / 1000).toFixed(0)}k` : market.volume.toFixed(0)}</span>
          <span>Liq ${market.liquidity >= 1000 ? `${(market.liquidity / 1000).toFixed(0)}k` : market.liquidity.toFixed(0)}</span>
          <span className={cwPct >= 30 ? "text-emerald-400" : cwPct >= 10 ? "text-amber-400" : "text-[var(--muted)]"}>
            Signal {cwPct}%
          </span>
          {market.time_to_resolution != null && (
            <span>{market.time_to_resolution > 0 ? `${market.time_to_resolution}d left` : "Resolving soon"}</span>
          )}
          <span className="ml-auto text-violet-400 font-semibold">
            {expanded ? "▲ collapse" : "▼ expand"}
          </span>
        </div>
      </div>

      {/* ── Expanded section ── */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-4">

          {/* Base rate panel — lazy loaded */}
          <BaseRatePanel
            token={token}
            marketId={market.id}
            question={market.question}
            niche={market.niche_tag}
            marketProb={prob}
          />

          <div className="border-t border-[var(--border)]" />

          {/* Lock prediction */}
          {logged ? (
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 text-sm font-bold">✓ Prediction locked</span>
              <Pill color="green" sm>Timestamped</Pill>
            </div>
          ) : (
            <>
              {!logOpen ? (
                <button
                  onClick={() => setLogOpen(true)}
                  className="w-full text-center py-2 rounded-xl text-xs font-bold text-violet-400 border border-violet-500/25 bg-violet-500/5 hover:bg-violet-500/10 transition-colors"
                >
                  Lock my probability →
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest">
                    My probability that this resolves YES (%)
                  </p>
                  <div className="flex gap-2 items-center">
                    <input
                      type="number" min="0" max="100" step="1"
                      value={myProb}
                      onChange={e => { setMyProb(e.target.value); setLogErr(null); }}
                      onKeyDown={e => e.key === "Enter" && logPrediction()}
                      placeholder="e.g. 35"
                      autoFocus
                      className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-violet-500/50"
                    />
                    <button
                      onClick={logPrediction}
                      disabled={logging || !myProb.trim()}
                      className="px-4 py-2 rounded-xl text-xs font-bold bg-violet-500 text-white disabled:opacity-50"
                    >
                      {logging ? "…" : "Lock"}
                    </button>
                    <button
                      onClick={() => { setLogOpen(false); setLogErr(null); }}
                      className="px-3 py-2 rounded-xl text-xs text-[var(--muted)] border border-[var(--border)]"
                    >
                      ✕
                    </button>
                  </div>
                  {logErr && <p className="text-red-400 text-xs">{logErr}</p>}
                  <p className="text-[var(--muted)] text-[10px]">
                    Locked with a timestamp before resolution. Brier score computed when you mark it resolved.
                  </p>
                </div>
              )}
            </>
          )}

          {/* External link */}
          <a
            href={market.url}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--muted)] text-[10px] hover:text-violet-400 inline-block"
          >
            View on Polymarket ↗
          </a>
        </div>
      )}
    </Card>
  );
}

// ─── MARKET FEED ────────────────────────────────────────────────
function MarketFeed({ token, niche }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setErr(null);
    try {
      const r   = await fetch(
        `${BACKEND_URL}/api/predictions/feed?niche=${encodeURIComponent(niche)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setData(json);
    } catch (e) {
      setErr(e.message);
    }
    setLoading(false);
  }, [token, niche]);

  // Fetch on tab open (niche change) — NOT on interval
  useEffect(() => { load(); }, [load]);

  const markets = data?.markets || [];
  const isRateLimit = err?.includes("429") || err?.includes("rate-limit");

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex justify-between items-center gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {data?.stubbed?.kalshi && <Pill color="gray" sm>Kalshi: v2</Pill>}
          {data?.error && !err && <Pill color="amber" sm>Partial data</Pill>}
          {markets.length > 0 && (
            <span className="text-[var(--muted)] text-[10px]">
              {markets.length} markets · READ-ONLY
            </span>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-[var(--muted)] text-xs border border-[var(--border)] rounded-xl px-3 py-1.5 hover:text-[var(--text)] disabled:opacity-50 flex-shrink-0"
        >
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {/* Honest error states */}
      {err && !loading && (
        <Card className={isRateLimit ? "border-amber-500/20 bg-amber-500/5" : "border-red-500/20 bg-red-500/5"}>
          <p className={`text-sm font-semibold ${isRateLimit ? "text-amber-400" : "text-red-400"}`}>
            {isRateLimit ? "⏳ Rate limited" : "⚠ API error"}
          </p>
          <p className="text-[var(--muted)] text-xs mt-1 leading-relaxed">{err}</p>
          <button onClick={load} className="text-violet-400 text-xs font-bold mt-2">
            Retry →
          </button>
        </Card>
      )}

      {loading && !data && (
        <Card>
          <p className="text-[var(--muted)] text-sm">Fetching prediction markets from Polymarket…</p>
        </Card>
      )}

      {!loading && !err && markets.length === 0 && (
        <Card className="border-amber-500/20 bg-amber-500/5">
          <p className="text-amber-400 text-sm font-semibold">No markets matched</p>
          <p className="text-[var(--muted)] text-xs mt-1 leading-relaxed">
            No active Polymarket markets matched this niche's keywords.
            Try "All Niches" or refresh — Polymarket's inventory changes frequently.
          </p>
        </Card>
      )}

      {/* Market list */}
      {markets.map(m => <MarketCard key={m.id} market={m} token={token} />)}

      {markets.length > 0 && data?.cached_at && (
        <p className="text-[var(--muted)] text-[10px] px-1 pt-1">
          Cached {Math.round((Date.now() - data.cached_at) / 60_000)}m ago ·
          Polymarket · Refresh to fetch live data
        </p>
      )}
    </div>
  );
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────
export default function Predictions({ token }) {
  const [niches,      setNiches]      = useState([]);
  const [activeNiche, setActiveNiche] = useState("all");
  const [sub,         setSub]         = useState("feed"); // "feed" | "log" | "calibration"

  // Load niche config + restore last-selected niche
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${BACKEND_URL}/api/predictions/niches`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        if (cancelled) return;
        setNiches(Array.isArray(data) ? data : []);
        // Restore last-selected niche
        const lastSelected = (Array.isArray(data) ? data : [])
          .filter(n => n.last_selected_at)
          .sort((a, b) => new Date(b.last_selected_at) - new Date(a.last_selected_at))[0];
        if (lastSelected) setActiveNiche(lastSelected.slug);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  function selectNiche(slug) {
    setActiveNiche(slug);
    if (slug !== "all" && token) {
      // Persist last-selected (fire and forget)
      fetch(`${BACKEND_URL}/api/predictions/niches/${encodeURIComponent(slug)}/select`, {
        method:  "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  }

  const nicheOptions = [
    { slug: "all", label: "All Niches" },
    ...niches.filter(n => n.is_active),
  ];

  return (
    <div className="space-y-4">
      {/* ── Sub-nav: Feed / My Predictions / Calibration ── */}
      <div className="flex gap-1.5">
        {[
          ["feed",        "Feed"],
          ["log",         "My Predictions"],
          ["calibration", "Calibration"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${
              sub === id
                ? "bg-violet-500/15 text-violet-400 border-violet-500/30"
                : "text-[var(--muted)] border-[var(--border)] hover:text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Niche selector (shown on Feed + Calibration) ── */}
      {(sub === "feed" || sub === "calibration") && (
        <div className="tab-scroll -mx-4 px-4">
          <div className="flex gap-1.5" style={{ width: "max-content" }}>
            {nicheOptions.map(n => (
              <button
                key={n.slug}
                onClick={() => selectNiche(n.slug)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                  activeNiche === n.slug
                    ? "bg-violet-500/15 text-violet-400 border border-violet-500/25"
                    : "text-[var(--muted)] border border-[var(--border)]"
                }`}
              >
                {n.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Disclaimer ── */}
      {sub === "feed" && (
        <Card className="border-sky-500/20 bg-sky-500/5">
          <p className="text-sky-400 text-xs font-semibold leading-relaxed">
            📡 READ-ONLY · No trading, no order placement.
            Data from Polymarket (public API). Kalshi stubbed — auth required outside US.
          </p>
        </Card>
      )}

      {/* ── Views ── */}
      {sub === "feed"        && <MarketFeed         token={token} niche={activeNiche} />}
      {sub === "log"         && <PredictionLogView  token={token} niche={activeNiche} />}
      {sub === "calibration" && <CalibrationView    token={token} niche={activeNiche} />}
    </div>
  );
}
