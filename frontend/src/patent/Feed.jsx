// frontend/src/patent/Feed.jsx
// Patent news feed — organised by industry, CLICK-to-expand only (no auto-fetch).
// Data: EPO OPS via GET /api/patents/feed?industry= (IPC classification + 90-day window).
// AI: GET /api/patents/analyze/:number (Haiku) — degrades gracefully without key.
//
// TODO: ontology ingestion hook — when a patent is opened in the Reader, the
// normalised PatentEvent object below can later be pushed into the digital-twin graph.

import { useState, useCallback } from "react";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ─── Industry config ─────────────────────────────────────────────
// id must match the key in backend INDUSTRY_IPC map.
const INDUSTRIES = [
  { id: "semiconductors", label: "Semiconductors" },
  { id: "aerospace",      label: "Aerospace & Defense" },
  { id: "ai_ml",          label: "AI & Machine Learning" },
  { id: "energy",         label: "Energy & Grid" },
  { id: "biotech",        label: "Biotech & Pharma" },
  { id: "robotics",       label: "Robotics & Automation" },
];

// ─── Primitive components ────────────────────────────────────────
function FCard({ children, className = "", accent, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`bg-[var(--card)] border rounded-2xl p-3 ${accent ? "border-violet-500/40" : "border-[var(--border)]"} ${onClick ? "cursor-pointer hover:border-violet-500/50 transition-colors" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

function Pill({ color, children }) {
  const cls = color === "green" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : color === "amber" ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : color === "red"   ? "bg-red-500/15 text-red-400 border-red-500/30"
    : "bg-violet-500/15 text-violet-400 border-violet-500/30";
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider border rounded px-1.5 py-0.5 ${cls}`}>
      {children}
    </span>
  );
}

// First sentence of abstract
function firstSentence(text) {
  if (!text) return "";
  const m = text.match(/^[^.!?]+[.!?]/);
  return m ? m[0].trim() : text.slice(0, 120) + "…";
}

// Build a normalised PatentEvent for future ontology ingestion
function toPatentEvent(patent, industry, analysis) {
  return {
    id: patent.number,
    title: patent.title,
    assignee: patent.assignee,
    date: patent.date,
    industry,
    abstract: patent.abstract || "",
    analysis: analysis ? {
      coreInnovation: analysis.coreInnovation,
      industryApplication: analysis.industryApplication,
      competitiveAdvantage: analysis.competitiveAdvantage,
      investmentSignal: analysis.investmentSignal,
      designComponents: analysis.designComponents || [],
    } : null,
  };
}

// ─── Patent Reader (slide-up modal) ─────────────────────────────
function PatentReader({ patent, token, industry, onClose, onSandboxLoad }) {
  const [analysis, setAnalysis]   = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiErr, setAiErr]         = useState(null);

  useState(() => {
    if (!patent) return;
    setAnalysis(null); setAiErr(null); setAiLoading(true);
    fetch(`${BACKEND}/api/patents/analyze/${encodeURIComponent(patent.number)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setAiErr(d.error); } else { setAnalysis(d.analysis); }
        setAiLoading(false);
      })
      .catch(e => { setAiErr(e.message); setAiLoading(false); });
  }, [patent, token]);

  if (!patent) return null;

  const numClean = patent.number.replace(/[^A-Z0-9]/gi, "");
  const figUrl = `https://patentimages.storage.googleapis.com/thumbnails/${numClean}.png`;
  const patentEvent = toPatentEvent(patent, industry, analysis);
  const signalColor = s => s === "bullish" ? "green" : s === "bearish" ? "red" : "amber";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg)] border border-[var(--border)] rounded-t-3xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--border)] px-5 py-3 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[var(--text)] font-black text-sm leading-tight">{patent.title}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-violet-400 text-xs font-bold">{patent.assignee}</span>
              <span className="text-[var(--muted)] text-xs">·</span>
              <span className="text-[var(--muted)] text-xs">{patent.date}</span>
              <span className="text-[var(--muted)] text-xs">·</span>
              <a href={patent.url} target="_blank" rel="noreferrer" className="text-violet-400 text-xs hover:underline">
                {patent.number} ↗
              </a>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--muted)] text-xl leading-none flex-shrink-0">×</button>
        </div>

        <div className="p-5 space-y-5" style={{ maxWidth: "70ch", margin: "0 auto" }}>
          {/* Figure */}
          <img
            src={figUrl}
            alt={`Figure for ${patent.number}`}
            className="w-full max-h-48 object-contain rounded-xl border border-[var(--border)] bg-[var(--card)]"
            onError={e => {
              e.currentTarget.style.display = "none";
              e.currentTarget.nextSibling.style.display = "flex";
            }}
          />
          <div className="hidden w-full h-24 rounded-xl border border-[var(--border)] bg-[var(--card)] items-center justify-center text-[var(--muted)] text-sm">
            No representative figure available
          </div>

          {/* AI Summary */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-400 mb-2">AI Summary</p>
            {aiLoading && <p className="text-[var(--muted)] text-sm">Analyzing with Claude Haiku…</p>}
            {aiErr && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
                <p className="text-amber-400 text-xs font-semibold">AI summary unavailable</p>
                <p className="text-[var(--muted)] text-xs mt-1">
                  {aiErr.includes("ANTHROPIC_API_KEY")
                    ? "Set ANTHROPIC_API_KEY in the backend environment to enable AI summaries."
                    : aiErr}
                </p>
              </div>
            )}
            {analysis && !aiErr && (
              <div className="space-y-3">
                <div className="bg-violet-500/8 border border-violet-500/20 rounded-xl p-4 space-y-2">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-violet-400">Core Innovation</span>
                    <p className="text-[var(--text)] text-sm leading-relaxed mt-1">{analysis.coreInnovation}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Industry Application</span>
                    <p className="text-[var(--text)] text-sm leading-relaxed mt-1">{analysis.industryApplication}</p>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Competitive Advantage</span>
                    <p className="text-[var(--text)] text-sm leading-relaxed mt-1">{analysis.competitiveAdvantage}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <Pill color={signalColor(analysis.investmentSignal)}>{analysis.investmentSignal || "neutral"} signal</Pill>
                  {analysis.technologyReadinessLevel && (
                    <Pill color="violet">TRL {analysis.technologyReadinessLevel}</Pill>
                  )}
                  <button
                    onClick={() => onSandboxLoad(patentEvent)}
                    className="ml-auto text-xs font-bold text-violet-400 border border-violet-500/30 rounded-xl px-3 py-1.5 bg-violet-500/8 hover:bg-violet-500/15 transition-colors"
                  >
                    ⊞ Load in Sandbox →
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Original filed text */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--muted)] mb-2">
              Original Filed Text (abstract)
            </p>
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
              <p className="text-[var(--text)] text-sm leading-relaxed">
                {patent.abstract || "Abstract not available for this filing."}
              </p>
            </div>
          </div>

          {analysis?.designComponents?.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--muted)] mb-2">
                Design Components (from AI analysis)
              </p>
              <div className="space-y-2">
                {analysis.designComponents.map((c, i) => (
                  <div key={i} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3">
                    <p className="text-violet-400 text-xs font-bold">{c.component}</p>
                    <p className="text-[var(--text)] text-xs mt-0.5 leading-relaxed">{c.function}</p>
                    {c.cadHint && <p className="text-[var(--muted)] text-[10px] mt-1">CAD hint: {c.cadHint}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Industry Section (click-to-expand only — NO auto-fetch) ─────
// Fetches on first expand; subsequent expands use cached state.
function IndustrySection({ industry, token, onSelect }) {
  const [open, setOpen]       = useState(false);
  const [patents, setPatents] = useState([]);
  const [loaded, setLoaded]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState(null);  // { type, message }

  const load = useCallback(() => {
    if (loaded || loading) return;
    setLoading(true);
    setErr(null);
    fetch(`${BACKEND}/api/patents/feed?industry=${encodeURIComponent(industry.id)}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok || d.error) {
          const msg = d.error || `HTTP ${r.status}`;
          const type = (r.status === 401 || d.code === "AUTH_FAILED")    ? "auth"
                     : (r.status === 429 || d.code === "QUOTA_EXCEEDED") ? "quota"
                     : "error";
          setErr({ type, message: msg });
          setLoading(false);
          return;
        }
        setPatents(Array.isArray(d.docs) ? d.docs : []);
        setLoaded(true);
        setLoading(false);
      })
      .catch(e => {
        setErr({ type: "error", message: e.message });
        setLoading(false);
      });
  }, [loaded, loading, industry.id, token]);

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) load();
  }

  function ErrorBanner() {
    if (!err) return null;
    const msg =
      err.type === "auth"  ? `EPO OPS auth error — ${err.message}` :
      err.type === "quota" ? "EPO OPS rate limit reached — try again in a few minutes." :
      `Error: ${err.message}`;
    return (
      <div className="bg-[var(--card)] border border-red-500/30 rounded-2xl p-3">
        <p className="text-red-400 text-xs font-semibold">⚠ {msg}</p>
        <button
          onClick={() => { setErr(null); setLoaded(false); load(); }}
          className="text-violet-400 text-[10px] mt-1 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Clickable header — the ONLY trigger for loading */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between group py-1"
      >
        <div className="flex items-center gap-2">
          <span className="text-[var(--text)] font-black text-sm group-hover:text-violet-400 transition-colors">
            {industry.label}
          </span>
          <div className="h-0.5 w-5 bg-violet-500 rounded-full" />
        </div>
        <div className="flex items-center gap-2">
          {loaded && <span className="text-[var(--muted)] text-[10px]">{patents.length} filings</span>}
          <span
            className="text-[var(--muted)] text-xs transition-transform duration-200"
            style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            ›
          </span>
        </div>
      </button>

      {open && (
        <div className="space-y-2 pb-1">
          {loading && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex-shrink-0 w-52 h-28 bg-[var(--card)] border border-[var(--border)] rounded-2xl animate-pulse" />
              ))}
            </div>
          )}

          <ErrorBanner />

          {loaded && patents.length === 0 && !err && (
            <p className="text-[var(--muted)] text-xs px-1">No recent filings found in the last 90 days.</p>
          )}

          {patents.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: "none" }}>
              {patents.map((p, i) => (
                <FCard
                  key={i}
                  onClick={() => onSelect(p, industry.id)}
                  className="flex-shrink-0 w-56 space-y-1.5"
                >
                  <p className="text-[var(--muted)] text-[10px] font-mono">{p.date || "—"}</p>
                  <p className="text-violet-400 text-[11px] font-bold truncate">{p.assignee}</p>
                  <p className="text-[var(--text)] text-xs font-semibold leading-tight line-clamp-2">{p.title}</p>
                  <p className="text-[var(--muted)] text-[10px] leading-relaxed line-clamp-2">
                    {firstSentence(p.abstract)}
                  </p>
                </FCard>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Feed ────────────────────────────────────────────────────────
export default function Feed({ token, onSandboxLoad }) {
  const [selected, setSelected]             = useState(null);
  const [recentlyViewed, setRecentlyViewed] = useState([]);

  function handleSelect(patent, industryId) {
    setSelected({ patent, industry: industryId });
    setRecentlyViewed(prev => {
      const next = [{ ...patent, industry: industryId }, ...prev.filter(p => p.number !== patent.number)];
      return next.slice(0, 10);
    });
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-4">
        <p className="text-[var(--muted)] text-xs">
          IPC classification · 90-day window · click a section to load
        </p>
        {recentlyViewed.length > 0 && (
          <button
            onClick={() => onSandboxLoad(null, recentlyViewed)}
            className="text-[10px] font-bold text-violet-400 border border-violet-500/25 rounded-xl px-3 py-1.5 bg-violet-500/8 hover:bg-violet-500/15 transition-colors"
          >
            ⊞ Open Sandbox
          </button>
        )}
      </div>

      <div className="divide-y divide-[var(--border)]">
        {INDUSTRIES.map(ind => (
          <div key={ind.id} className="py-3">
            <IndustrySection industry={ind} token={token} onSelect={handleSelect} />
          </div>
        ))}
      </div>

      {selected && (
        <PatentReader
          patent={selected.patent}
          industry={selected.industry}
          token={token}
          onClose={() => setSelected(null)}
          onSandboxLoad={pe => { onSandboxLoad(pe, recentlyViewed); setSelected(null); }}
        />
      )}
    </div>
  );
}
