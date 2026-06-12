import { useState, useEffect, useRef } from "react";

// ─── BACKEND ───────────────────────────────────────────────────
// Where the data server lives. Locally it's localhost:3001.
// When you deploy, change this to your Railway URL (e.g.
// "https://api.williamgrip.se") or set VITE_BACKEND_URL.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";

// ─── ACCESS CONTROL ────────────────────────────────────────────
// Passwords/codes now live on the BACKEND (env vars), not here.
// Login is verified server-side via POST /api/login.
// Tabs only the owner sees. Guests with the code never see these.
const OWNER_ONLY = ["dashboard", "portfolio", "analytics", "research", "tasks", "calendar"];

// ─── PORTFOLIO ─────────────────────────────────────────────────
// Intentionally EMPTY in the frontend. Your real holdings live on the
// backend and are fetched (with prices) only after you log in as owner,
// via the authenticated /api/portfolio endpoint. This means a guest's
// browser never downloads your portfolio at all.
const MY_PORTFOLIO = {
  stocks: [],
  funds: [],
  etfs: [],
};

const USD_SEK = 10.35;
const EUR_SEK = 11.20;
const DKK_SEK = 1.50;

function toSEK(price, currency) {
  if (currency === "SEK") return price;
  if (currency === "USD") return price * USD_SEK;
  if (currency === "EUR") return price * EUR_SEK;
  if (currency === "DKK") return price * DKK_SEK;
  return price;
}

// ─── TABS ──────────────────────────────────────────────────────
const TABS = [
  { id: "dashboard",   label: "Dashboard",      icon: "▦"  },
  { id: "portfolio",   label: "Portfolio",       icon: "◈"  },
  { id: "analytics",  label: "Analytics",       icon: "⊛"  },
  { id: "sentiment",  label: "Sentiment",       icon: "◍"  },
  { id: "news",       label: "News",            icon: "◎"  },
  { id: "screener",   label: "Screener",        icon: "⊞"  },
  { id: "capitol",    label: "Capitol Trades",  icon: "⬟"  },
  { id: "earnings",   label: "Earnings",        icon: "⊡"  },
  { id: "research",   label: "Research",        icon: "⊟"  },
  { id: "network",    label: "Network",         icon: "◉"  },
  { id: "tasks",      label: "Tasks",           icon: "⊕"  },
  { id: "calendar",   label: "Calendar",        icon: "▣"  },
];

const BOTTOM_NAV = ["dashboard","portfolio","tasks","calendar","analytics"];

// ─── MOCK DATA ─────────────────────────────────────────────────
const NEWS_FEED = [
  { ticker: "PLTR",  headline: "Palantir wins $480M US Army AI contract extension", time: "1h ago", sentiment: "bullish", source: "Reuters" },
  { ticker: "NVO",   headline: "Novo Nordisk Ozempic demand stabilises after supply crunch", time: "2h ago", sentiment: "neutral", source: "FT" },
  { ticker: "HIMS",  headline: "Hims & Hers faces FDA scrutiny over compounded GLP-1 drugs", time: "3h ago", sentiment: "bearish", source: "CNBC" },
  { ticker: "INVE-B",headline: "Investor AB raises stake in Atlas Copco amid industrial rally", time: "4h ago", sentiment: "bullish", source: "SvD" },
  { ticker: "LMND",  headline: "Lemonade Q2 loss narrows but guidance disappoints", time: "6h ago", sentiment: "bearish", source: "Bloomberg" },
  { ticker: "MACRO", headline: "Riksbanken signals further rate cuts as Swedish CPI falls to 1.8%", time: "8h ago", sentiment: "bullish", source: "Di" },
];

const CAPITOL_FEED = [
  { name: "Nancy Pelosi",          ticker: "PLTR", action: "BUY",  amount: "$250K–$500K", date: "Jun 1",  party: "D" },
  { name: "Dan Crenshaw",          ticker: "BX",   action: "BUY",  amount: "$15K–$50K",   date: "May 29", party: "R" },
  { name: "Tommy Tuberville",      ticker: "GOOGL",action: "SELL", amount: "$50K–$100K",  date: "May 28", party: "R" },
  { name: "Josh Gottheimer",       ticker: "HIMS", action: "BUY",  amount: "$100K–$250K", date: "May 27", party: "D" },
  { name: "Marjorie Taylor Greene",ticker: "DUOL", action: "BUY",  amount: "$15K–$50K",   date: "May 25", party: "R" },
];

const SENTIMENT_DATA = {
  fearGreed: 58,
  tickers: {
    PLTR:   { bullish: 84, bearish: 16, messages: 9203, trending: true  },
    GOOGL:  { bullish: 71, bearish: 29, messages: 5841, trending: true  },
    HIMS:   { bullish: 38, bearish: 62, messages: 4102, trending: true  },
    LMND:   { bullish: 32, bearish: 68, messages: 1923, trending: false },
    NVO:    { bullish: 55, bearish: 45, messages: 3341, trending: false },
    "INVE-B":{ bullish: 67, bearish: 33, messages: 412,  trending: false },
  },
};

const SOCIAL_POSTS = [
  { user: "W. Grip", avatar: "WG", text: "PLTR is the most undervalued AI infrastructure play right now. Every major defense contractor is being forced to use it. $143 is cheap at 2030 projections.", tickers: ["PLTR"], likes: 14, time: "2h ago" },
  { user: "Alex R.", avatar: "AR", text: "Novo Nordisk has been destroyed by the market. Pipeline is still intact. Obesity drug market is $100B+. This is a generational buying opportunity.", tickers: ["NVO"], likes: 31, time: "4h ago" },
];

const RESEARCH_DEFAULT = `## Investment Thesis — Q3 2026

### High Conviction
**PLTR** — AI infrastructure for defense + enterprise. AIP adoption accelerating. Every new government contract is recurring. Target: $200.

**INVE-B** — Swedish industrial conglomerate. Exposure to Atlas Copco, ABB, Epiroc. Compounding machine. Long-term hold.

---

### Needs Review
**FLYE** — Down -98%. Thesis broken. Exit or hold for recovery?
**NVO** — Down -71%. Ozempic competition real but market overreacting. Pipeline intact.
**DUOL** — Down -60%. AI disruption risk or buying opportunity?

---

### Macro — Sweden/Europe
Riksbanken cutting rates → REIT recovery likely (PLUS Fastigheter)
EUR weakness → Thales (defense) benefits from EU rearmament

---

### Watchlist
- NVIDIA: wait for pullback to $800
- Spotify: Swedish champion, underowned globally
- Embracer: deeply beaten down, optionality`;

// ─── MATH ──────────────────────────────────────────────────────
function mean(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }
function stddev(arr) { const m=mean(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); }

// ─── COMPONENTS ────────────────────────────────────────────────
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
  return <span className={`font-bold rounded-full tracking-widest uppercase ${sz} ${c[color]}`}>{children}</span>;
}

function Card({ children, className = "", accent, onClick }) {
  return (
    <div onClick={onClick} className={`rounded-2xl p-4 border transition-all ${accent ? "border-violet-500/30 bg-violet-500/5" : "border-[var(--border)] bg-[var(--card)]"} ${className}`}>
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return <p className="text-[11px] font-bold tracking-[0.12em] uppercase text-[var(--muted)] mb-3">{children}</p>;
}

function Bar({ value, max = 100, color = "bg-violet-500", height = "h-1.5" }) {
  return (
    <div className={`w-full ${height} rounded-full bg-[var(--border)] overflow-hidden`}>
      <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${Math.min((value/max)*100,100)}%` }} />
    </div>
  );
}

function StatCard({ label, value, sub, trend }) {
  return (
    <Card>
      <p className="text-[10px] uppercase tracking-widest font-semibold text-[var(--muted)]">{label}</p>
      <p className="text-[var(--text)] text-xl font-bold mt-1 tracking-tight">{value}</p>
      {sub && <p className={`text-xs font-semibold mt-0.5 ${trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-[var(--muted)]"}`}>{sub}</p>}
    </Card>
  );
}

// ─── CLAUDE ASSISTANT ──────────────────────────────────────────
function ClaudeAssistant({ apiKey }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hi William 👋 I'm your Meridian assistant. Ask me anything about your portfolio, a position, a metric, or the market." }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const portfolioContext = `William's portfolio (209,489 SEK total):
Stocks: ${MY_PORTFOLIO.stocks.map(s=>`${s.ticker} (${s.shares} shares @ ${s.avgCost} ${s.currency}, now ${s.price}, ${s.change>0?"+":""}${s.change}% today)`).join(", ")}
Funds: ${MY_PORTFOLIO.funds.map(f=>`${f.name} ${f.value}kr (${f.gainPct>0?"+":""}${f.gainPct}%)`).join(", ")}
ETFs: ${MY_PORTFOLIO.etfs.map(e=>`${e.name} ${e.shares} shares`).join(", ")}`;

  async function send() {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input };
    setMessages(m => [...m, userMsg]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          context: portfolioContext,
          messages: [...messages.filter(m => m.role !== "assistant" || messages.indexOf(m) > 0), userMsg],
        }),
      });
      const data = await res.json();
      const reply = data.reply || data.error || "Something went wrong.";
      setMessages(m => [...m, { role: "assistant", content: reply }]);
    } catch {
      setMessages(m => [...m, { role: "assistant", content: "Couldn't reach the server." }]);
    }
    setLoading(false);
  }

  return (
    <>
      {/* Floating button */}
      <button onClick={() => setOpen(o=>!o)}
        className="fixed bottom-20 right-4 z-50 w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-violet-700 shadow-lg shadow-violet-500/30 flex items-center justify-center text-white text-lg font-black hover:scale-105 transition-transform">
        ✦
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-36 right-4 z-50 w-80 max-h-[500px] flex flex-col rounded-2xl border border-violet-500/30 bg-[var(--bg)] shadow-2xl shadow-violet-500/10 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-violet-500/5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-xs font-black text-white">✦</div>
              <span className="text-sm font-bold text-[var(--text)]">Claude · Meridian</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-[var(--muted)] hover:text-[var(--text)] text-xs">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0" style={{ maxHeight: 360 }}>
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${m.role === "user" ? "bg-violet-500 text-white" : "bg-[var(--card)] border border-[var(--border)] text-[var(--text)]"}`}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-xs text-[var(--muted)]">Thinking…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="p-3 border-t border-[var(--border)] flex gap-2">
            <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()}
              placeholder="Ask about your portfolio…"
              className="flex-1 bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-violet-500/50" />
            <button onClick={send} className="bg-violet-500 text-white rounded-xl px-3 py-2 text-xs font-bold hover:bg-violet-600 transition-colors">↑</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── VIEWS ─────────────────────────────────────────────────────

function DashboardView({ isOwner, token }) {
  const [earnings, setEarnings] = useState(null);
  useEffect(() => {
    if (!token) return; let c = false;
    const load = (t=0) => fetch(`${BACKEND_URL}/api/earnings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (!c) setEarnings(Array.isArray(d) ? d : []); })
      .catch(() => { if (c) return; if (t < 3) setTimeout(() => load(t+1), 4000); else setEarnings([]); });
    load();
    return () => { c = true; };
  }, [token]);
  const earningsToday = new Date(); earningsToday.setHours(0,0,0,0);
  const upcomingEarnings = (earnings || []).filter(e => e.nextEarnings && new Date(e.nextEarnings) >= earningsToday).slice(0,3);

  const stockValueSEK = MY_PORTFOLIO.stocks.reduce((s,p) => s + toSEK(p.price * p.shares, p.currency), 0);
  const fundValue     = MY_PORTFOLIO.funds.reduce((s,f) => s + f.value, 0);
  const etfValueSEK   = MY_PORTFOLIO.etfs.reduce((s,e) => s + toSEK(e.price * e.shares, e.currency), 0);
  const total         = stockValueSEK + fundValue + etfValueSEK;
  const dayChange     = MY_PORTFOLIO.stocks.reduce((s,p) => s + toSEK(p.price * p.shares * p.change / 100, p.currency), 0);

  const sortedByChange = [...MY_PORTFOLIO.stocks].sort((a,b) => (b.change ?? 0) - (a.change ?? 0));
  const best  = sortedByChange[0] || { ticker: "—", change: 0 };
  const worst = sortedByChange[sortedByChange.length - 1] || { ticker: "—", change: 0 };
  const loadingPortfolio = MY_PORTFOLIO.stocks.length === 0 && MY_PORTFOLIO.funds.length === 0;

  return (
    <div className="space-y-5">
      {loadingPortfolio && (
        <Card><p className="text-[var(--muted)] text-xs">Loading your portfolio from the server… (if this stays empty, the backend isn't running)</p></Card>
      )}
      {/* Hero */}
      <div className="rounded-2xl p-5 bg-gradient-to-br from-violet-600/20 via-violet-500/5 to-transparent border border-violet-500/20">
        <p className="text-[var(--muted)] text-xs uppercase tracking-widest font-semibold mb-1">Total Portfolio Value</p>
        <p className="text-4xl font-black text-[var(--text)] tracking-tight">{total.toLocaleString("sv-SE",{maximumFractionDigits:0})} <span className="text-lg font-semibold text-[var(--muted)]">kr</span></p>
        <p className={`text-sm font-bold mt-1 ${dayChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {dayChange >= 0 ? "+" : ""}{dayChange.toLocaleString("sv-SE",{maximumFractionDigits:0})} kr today
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Stocks"   value={`${stockValueSEK.toLocaleString("sv-SE",{maximumFractionDigits:0})} kr`} sub={`${MY_PORTFOLIO.stocks.length} positions`} />
        <StatCard label="Funds"    value={`${fundValue.toLocaleString("sv-SE",{maximumFractionDigits:0})} kr`}     sub={`${MY_PORTFOLIO.funds.length} funds`} />
        <StatCard label="Best Today"  value={best.ticker}  sub={`+${best.change}%`}  trend="up" />
        <StatCard label="Worst Today" value={worst.ticker} sub={`${worst.change}%`}  trend="down" />
      </div>

      <div>
        <SectionLabel>Latest News</SectionLabel>
        <div className="space-y-2">
          {NEWS_FEED.slice(0,3).map((n,i) => (
            <Card key={i}>
              <div className="flex gap-2 items-start">
                <Pill color={n.sentiment==="bullish"?"green":n.sentiment==="bearish"?"red":"gray"} sm>{n.ticker}</Pill>
                <div className="flex-1 min-w-0">
                  <p className="text-[var(--text)] text-sm leading-snug">{n.headline}</p>
                  <p className="text-[var(--muted)] text-xs mt-0.5">{n.source} · {n.time}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Upcoming Earnings</SectionLabel>
        <div className="space-y-2">
          {!earnings && <Card><p className="text-[var(--muted)] text-xs">Loading earnings dates…</p></Card>}
          {earnings && upcomingEarnings.length===0 && <Card><p className="text-[var(--muted)] text-xs">No upcoming earnings dates yet.</p></Card>}
          {upcomingEarnings.map((e,i) => (
            <Card key={i}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--text)] font-bold">{e.ticker}</span>
                  <Pill color="violet" sm>{new Date(e.nextEarnings).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</Pill>
                </div>
                <span className="text-[var(--muted)] text-xs">{e.epsEstimate!=null ? `EPS est. ${fmtNum(e.epsEstimate)}` : ""}</span>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── FORMAT HELPERS ────────────────────────────────────────────
function fmtBig(n) {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return (n/1e12).toFixed(2)+"T";
  if (a >= 1e9)  return (n/1e9).toFixed(2)+"B";
  if (a >= 1e6)  return (n/1e6).toFixed(1)+"M";
  return Number(n).toLocaleString("en-US");
}
function fmtNum(n, d=2) { return (n == null || isNaN(n)) ? "—" : Number(n).toFixed(d); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"}) : "—"; }

// Dependency-free SVG price chart
function LineChart({ data, height=160 }) {
  if (!data || data.length < 2) return <div className="text-[var(--muted)] text-xs py-8 text-center">No chart data</div>;
  const w = 600, h = height, pad = 4;
  const xs = data.map(d=>d.c);
  const min = Math.min(...xs), max = Math.max(...xs), span = (max-min)||1;
  const pts = data.map((d,i)=>{
    const x = pad + (i/(data.length-1))*(w-2*pad);
    const y = pad + (1-(d.c-min)/span)*(h-2*pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const up = xs[xs.length-1] >= xs[0];
  const color = up ? "#10b981" : "#ef4444";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{display:"block"}}>
      <polygon points={`${pad},${h-pad} ${pts} ${w-pad},${h-pad}`} fill={color} opacity="0.08" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

// Avanza-style detail panel for one stock
// Embedded TradingView advanced chart (free widget). Full candles,
// indicators, timeframes & drawing tools — no API key needed.
function TVChart({ symbol, height = 380, resizable = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || !symbol) return;
    container.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: "D",
      timezone: "Europe/Stockholm",
      theme: "dark",
      style: "1",
      locale: "en",
      hide_side_toolbar: false,
      allow_symbol_change: true,
      withdateranges: true,
      details: true,
      support_host: "https://www.tradingview.com",
    });
    container.appendChild(script);
    return () => { if (container) container.innerHTML = ""; };
  }, [symbol]);
  return <div className="tradingview-widget-container" ref={ref}
    style={{ height, width: "100%", ...(resizable ? { resize: "vertical", overflow: "auto", minHeight: 260 } : {}) }} />;
}

// Full-screen-ish modal that just shows a TradingView chart — used for
// market indices/commodities/crypto/FX where there's no /api/stock page.
function ChartModal({ tvSymbol, title, subtitle, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-[var(--bg)] border border-[var(--border)] rounded-t-3xl sm:rounded-2xl w-full max-w-6xl h-[92vh] overflow-hidden flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="bg-[var(--bg)] border-b border-[var(--border)] px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-[var(--text)] font-black text-base">{title}</p>
            {subtitle && <p className="text-[var(--muted)] text-xs">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--text)] w-8 h-8 rounded-full border border-[var(--border)] flex items-center justify-center">✕</button>
        </div>
        <div className="p-2 flex-1 min-h-0">
          <TVChart symbol={tvSymbol} height="100%" />
        </div>
      </div>
    </div>
  );
}

function StockDetail({ ticker, token, onClose }) {
  const [data,setData] = useState(null);
  const [range,setRange] = useState("5y");
  const [chartMode,setChartMode] = useState("tv");
  const [fullChart,setFullChart] = useState(false);
  const [loading,setLoading] = useState(true);
  const [err,setErr] = useState(false);
  useEffect(()=>{
    let cancelled=false; setLoading(true); setErr(false);
    fetch(`${BACKEND_URL}/api/stock/${encodeURIComponent(ticker)}?range=${range}`, { headers:{Authorization:`Bearer ${token}`} })
      .then(r=>r.ok?r.json():Promise.reject())
      .then(d=>{ if(!cancelled){ setData(d); setLoading(false); } })
      .catch(()=>{ if(!cancelled){ setErr(true); setLoading(false); } });
    return ()=>{cancelled=true;};
  },[ticker,range,token]);
  const st = data?.stats || {};
  const ratios = [
    ["P/E", fmtNum(st.peTrailing)], ["P/E fwd", fmtNum(st.peForward)], ["P/S", fmtNum(st.ps)],
    ["P/B", fmtNum(st.pb)], ["EPS", fmtNum(st.eps)], ["Beta", fmtNum(st.beta)],
    ["Div yield", st.dividendYield!=null?fmtNum(st.dividendYield)+"%":"—"],
    ["Profit margin", st.profitMargin!=null?fmtNum(st.profitMargin)+"%":"—"],
    ["Rev growth", st.revenueGrowth!=null?fmtNum(st.revenueGrowth)+"%":"—"],
    ["ROE", st.roe!=null?fmtNum(st.roe)+"%":"—"], ["Mkt cap", fmtBig(st.marketCap)],
    ["52w range", st.week52Low!=null?`${fmtNum(st.week52Low,0)}–${fmtNum(st.week52High,0)}`:"—"],
  ];
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-[var(--bg)] border border-[var(--border)] rounded-t-3xl sm:rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="sticky top-0 bg-[var(--bg)] border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[var(--text)] font-black text-base">{ticker}</p>
            <p className="text-[var(--muted)] text-xs">{data?.name || ""}</p>
          </div>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--text)] w-8 h-8 rounded-full border border-[var(--border)] flex items-center justify-center">✕</button>
        </div>
        <div className="p-4 space-y-4">
          {loading && <p className="text-[var(--muted)] text-sm py-10 text-center">Loading {ticker}…</p>}
          {err && <p className="text-red-400 text-sm py-10 text-center">Couldn't load data. Is the backend running?</p>}
          {data && !loading && <>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-3xl font-black text-[var(--text)]">{fmtNum(data.price)} <span className="text-sm text-[var(--muted)]">{data.currency}</span></p>
                <p className={`text-sm font-bold ${(data.change??0)>=0?"text-emerald-400":"text-red-400"}`}>{(data.change??0)>=0?"+":""}{fmtNum(data.change)}% today</p>
              </div>
              <div className="flex gap-1">
                {[["tv","📈 Interactive"],["line","Line"]].map(([m,lbl])=>(
                  <button key={m} onClick={()=>setChartMode(m)} className={`text-[10px] px-2 py-1 rounded-lg font-bold whitespace-nowrap ${chartMode===m?"bg-violet-500/15 text-violet-400 border border-violet-500/25":"text-[var(--muted)] border border-[var(--border)]"}`}>{lbl}</button>
                ))}
                {chartMode==="tv" && data.tvSymbol && (
                  <button onClick={()=>setFullChart(true)} title="Fullscreen chart" className="text-[10px] px-2 py-1 rounded-lg font-bold text-[var(--muted)] border border-[var(--border)] hover:text-violet-400">⛶</button>
                )}
              </div>
            </div>
            {chartMode==="tv" && data.tvSymbol ? (
              <>
                <Card className="p-0 overflow-hidden"><TVChart symbol={data.tvSymbol} height={520} resizable /></Card>
                <p className="text-[var(--muted)] text-[10px] -mt-2">Drag the bottom-right corner to resize · ⛶ for fullscreen</p>
              </>
            ) : (
              <>
                <div className="flex gap-1 justify-end">
                  {["1y","5y","10y"].map(r=>(
                    <button key={r} onClick={()=>setRange(r)} className={`text-[10px] px-2 py-1 rounded-lg font-bold ${range===r?"bg-violet-500/15 text-violet-400 border border-violet-500/25":"text-[var(--muted)] border border-[var(--border)]"}`}>{r.toUpperCase()}</button>
                  ))}
                </div>
                <Card><LineChart data={data.history}/></Card>
              </>
            )}
            {fullChart && data.tvSymbol && <ChartModal tvSymbol={data.tvSymbol} title={ticker} subtitle={data.name} onClose={()=>setFullChart(false)} />}
            <div>
              <SectionLabel>Key ratios</SectionLabel>
              <div className="grid grid-cols-3 gap-2">
                {ratios.map(([k,v])=>(
                  <div key={k} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-2">
                    <p className="text-[var(--muted)] text-[9px] uppercase tracking-wide">{k}</p>
                    <p className="text-[var(--text)] text-sm font-bold">{v}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-2"><p className="text-[var(--muted)] text-[9px] uppercase">Next report</p><p className="text-[var(--text)] text-xs font-bold">{fmtDate(data.nextEarnings)}</p></div>
              <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-2"><p className="text-[var(--muted)] text-[9px] uppercase">Ex-dividend</p><p className="text-[var(--text)] text-xs font-bold">{fmtDate(data.exDividend)}</p></div>
              <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-2"><p className="text-[var(--muted)] text-[9px] uppercase">Sector</p><p className="text-[var(--text)] text-xs font-bold">{data.sector||"—"}</p></div>
            </div>
            {data.owners?.length>0 && <div>
              <SectionLabel>Largest owners</SectionLabel>
              <div className="space-y-1">
                {data.owners.map((o,i)=>(
                  <div key={i} className="flex justify-between items-center bg-[var(--card)] border border-[var(--border)] rounded-xl px-3 py-2">
                    <span className="text-[var(--text)] text-xs">{o.organization}</span>
                    <span className="text-violet-400 text-xs font-bold">{o.pctHeld!=null?fmtNum(o.pctHeld)+"%":"—"}</span>
                  </div>
                ))}
              </div>
            </div>}
            {data.summary && <div>
              <SectionLabel>About</SectionLabel>
              <p className="text-[var(--muted)] text-xs leading-relaxed">{data.summary.slice(0,420)}{data.summary.length>420?"…":""}</p>
              {data.website && <a href={data.website} target="_blank" rel="noreferrer" className="text-violet-400 text-xs font-bold mt-2 inline-block">{data.website} ↗</a>}
            </div>}
          </>}
        </div>
      </div>
    </div>
  );
}

function PortfolioView({ isOwner, token }) {
  const [tab, setTab] = useState("stocks");
  const [selected, setSelected] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const tabs = ["stocks","funds","etfs"];

  useEffect(()=>{
    if(!isOwner || !token) return;
    let c=false;
    const load=()=>fetch(`${BACKEND_URL}/api/analytics`,{headers:{Authorization:`Bearer ${token}`}})
      .then(r=>r.ok?r.json():null).then(d=>{ if(!c&&d) setAnalytics(d); }).catch(()=>{});
    load();
    return ()=>{c=true;};
  },[isOwner,token]);

  const stockValueSEK = MY_PORTFOLIO.stocks.reduce((s,p) => s + toSEK(p.price*p.shares, p.currency), 0);
  const fundValue     = MY_PORTFOLIO.funds.reduce((s,f) => s + f.value, 0);
  const etfValueSEK   = MY_PORTFOLIO.etfs.reduce((s,e) => s + toSEK(e.price*e.shares, e.currency), 0);
  const total         = (stockValueSEK + fundValue + etfValueSEK) || 1;

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold capitalize transition-all ${tab===t ? "bg-violet-500/15 text-violet-400 border border-violet-500/25" : "text-[var(--muted)] border border-[var(--border)]"}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === "stocks" && (
        <div className="space-y-2">
          {[...MY_PORTFOLIO.stocks].sort((a,b)=>toSEK(b.price*b.shares,b.currency)-toSEK(a.price*a.shares,a.currency)).map((p,i) => {
            const val    = toSEK(p.price * p.shares, p.currency);
            const weight = (val / total * 100).toFixed(1);
            const gainPct= ((p.price - p.avgCost) / p.avgCost * 100).toFixed(1);
            const isUp   = p.price >= p.avgCost;
            return (
              <Card key={i} className="cursor-pointer hover:border-violet-500/40 transition-colors">
                <div onClick={()=>setSelected(p.ticker)}>
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[var(--text)] font-black text-sm">{p.ticker}</span>
                        <Pill color={isUp?"green":"red"} sm>{isUp?"+":""}{gainPct}%</Pill>
                        <span className="text-[var(--muted)] text-[10px]">{weight}%</span>
                      </div>
                      <p className="text-[var(--muted)] text-xs mt-0.5">{p.name} · {p.shares} sh · {p.currency}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[var(--text)] font-bold text-sm">{val.toLocaleString("sv-SE",{maximumFractionDigits:0})} kr</p>
                      <p className={`text-xs font-semibold ${(p.change??0)>=0?"text-emerald-400":"text-red-400"}`}>{(p.change??0)>=0?"+":""}{fmtNum(p.change)}% today</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-5 gap-1 pt-2 border-t border-[var(--border)]">
                    {[["P/E",fmtNum(p.pe)],["P/B",fmtNum(p.pb)],["EPS",fmtNum(p.eps)],["Div",p.divYield!=null?fmtNum(p.divYield)+"%":"—"],["Cap",fmtBig(p.marketCap)]].map(([k,v])=>(
                      <div key={k}><p className="text-[var(--muted)] text-[8px] uppercase tracking-wide">{k}</p><p className="text-[var(--text)] text-[11px] font-bold">{v}</p></div>
                    ))}
                  </div>
                  {p.perf && (
                    <div className="grid grid-cols-5 gap-1 pt-2 mt-1 border-t border-[var(--border)]">
                      {[["1W",p.perf.w1],["1M",p.perf.m1],["3M",p.perf.m3],["6M",p.perf.m6],["1Y",p.perf.y1]].map(([k,v])=>(
                        <div key={k}>
                          <p className="text-[var(--muted)] text-[8px] uppercase tracking-wide">{k}</p>
                          <p className={`text-[11px] font-bold ${v==null?"text-[var(--muted)]":v>=0?"text-emerald-400":"text-red-400"}`}>{v==null?"—":`${v>=0?"+":""}${v.toFixed(1)}%`}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-violet-400 text-[10px] mt-2">Tap for chart, owners &amp; next report →</p>
                </div>
              </Card>
            );
          })}
          {MY_PORTFOLIO.stocks.length===0 && <Card><p className="text-[var(--muted)] text-xs">Loading your holdings… (start the backend if this stays empty)</p></Card>}
        </div>
      )}

      {tab === "funds" && (
        <div className="space-y-2">
          {MY_PORTFOLIO.funds.map((f,i) => {
            const weight = (f.value / total * 100).toFixed(1);
            return (
              <Card key={i}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-[var(--text)] font-bold text-sm">{f.name}</p>
                    <p className="text-[var(--muted)] text-xs">{weight}% of portfolio</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[var(--text)] font-bold">{f.value.toLocaleString("sv-SE")} kr</p>
                    <p className={`text-xs font-semibold ${f.gainPct>=0?"text-emerald-400":"text-red-400"}`}>{f.gainPct>=0?"+":""}{f.gainPct}% since buy</p>
                  </div>
                </div>
                <Bar value={parseFloat(weight)} max={30} color="bg-violet-500" />
              </Card>
            );
          })}
        </div>
      )}

      {tab === "etfs" && (
        <div className="space-y-2">
          {MY_PORTFOLIO.etfs.map((e,i) => {
            const val    = toSEK(e.price * e.shares, e.currency);
            const gainPct= ((e.price - e.avgCost) / e.avgCost * 100).toFixed(1);
            return (
              <Card key={i} className="cursor-pointer hover:border-violet-500/40 transition-colors">
                <div onClick={()=>setSelected(e.ticker)} className="flex justify-between">
                  <div>
                    <p className="text-[var(--text)] font-bold">{e.ticker}</p>
                    <p className="text-[var(--muted)] text-xs">{e.name} · {e.shares} shares</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[var(--text)] font-bold">{val.toLocaleString("sv-SE",{maximumFractionDigits:0})} kr</p>
                    <Pill color={parseFloat(gainPct)>=0?"green":"red"} sm>{parseFloat(gainPct)>=0?"+":""}{gainPct}%</Pill>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Bottom summary — owner only */}
      {isOwner && (
        <div className="pt-3">
          <SectionLabel>Portfolio summary</SectionLabel>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <StatCard label="Total value" value={`${(analytics?.totalSEK ?? total).toLocaleString("sv-SE",{maximumFractionDigits:0})} kr`} />
            <StatCard label="Sharpe (1y)" value={analytics?.sharpe!=null?analytics.sharpe.toFixed(2):"…"} sub={analytics?.volatility!=null?`Volatility ${analytics.volatility}%`:"computing…"} trend={analytics?.sharpe>=1?"up":analytics?.sharpe<0?"down":undefined} />
          </div>
          {analytics?.allocations ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-2">Allocation by country</p>
                {(analytics.allocations.country||[]).map(a=>(
                  <div key={a.key} className="mb-2">
                    <div className="flex justify-between text-xs mb-0.5"><span className="text-[var(--text)]">{a.key}</span><span className="text-[var(--muted)]">{a.pct}%</span></div>
                    <Bar value={a.pct} max={100} />
                  </div>
                ))}
              </div>
              <div>
                <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest mb-2">Allocation by sector</p>
                {(analytics.allocations.sector||[]).map(a=>(
                  <div key={a.key} className="mb-2">
                    <div className="flex justify-between text-xs mb-0.5"><span className="text-[var(--text)]">{a.key}</span><span className="text-[var(--muted)]">{a.pct}%</span></div>
                    <Bar value={a.pct} max={50} color="bg-sky-500" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Card><p className="text-[var(--muted)] text-xs">Calculating allocation &amp; Sharpe ratio from market history…</p></Card>
          )}
        </div>
      )}

      {selected && <StockDetail ticker={selected} token={token} onClose={()=>setSelected(null)} />}
    </div>
  );
}

function GlossaryItem({ item }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex justify-between items-center cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span className="text-[var(--muted)] text-sm">{item.term}</span>
        <div className="flex items-center gap-2">
          <span className={`font-black text-lg ${item.color}`}>{item.val}</span>
          <span className="text-[var(--muted)] text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </div>
      {open && <p className="text-[var(--muted)] text-xs leading-relaxed mt-2 pt-2 border-t border-[var(--border)]">{item.exp}</p>}
    </Card>
  );
}

const COUNTRY_NAME = { SE:"Sweden", US:"United States", FR:"France", DK:"Denmark", IN:"India", DE:"Germany", GB:"United Kingdom", NO:"Norway", FI:"Finland", NL:"Netherlands", CH:"Switzerland", Global:"global markets", Asia:"Asia" };
function sliceLabel(dim, key) { return dim==="country" ? (COUNTRY_NAME[key]||key) : key; }
function sliceNewsQuery(dim, key) {
  if (dim==="country") return `${COUNTRY_NAME[key]||key} stock market economy`;
  if (dim==="region")  return `${key} stock market`;
  if (dim==="sector")  return `${key} sector stocks`;
  return null; // asset class: news doesn't apply
}

// One allocation slice: click to drill into its holdings + that-week's news.
function AllocSlice({ slice, dim, max, color, token }) {
  const [open, setOpen] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const [news, setNews] = useState(null);
  const q = sliceNewsQuery(dim, slice.key);
  useEffect(() => {
    if (!showNews || news || !q || !token) return; let c = false;
    fetch(`${BACKEND_URL}/api/news?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : { articles: [] }).then(d => { if (!c) setNews(d.articles||[]); }).catch(() => { if (!c) setNews([]); });
    return () => { c = true; };
  }, [showNews]);
  return (
    <Card>
      <div className="cursor-pointer" onClick={()=>setOpen(o=>!o)}>
        <div className="flex justify-between items-center mb-2">
          <span className="text-[var(--text)] font-bold text-sm">{sliceLabel(dim,slice.key)} <span className="text-[var(--muted)] text-xs font-normal">· {slice.holdings.length}</span></span>
          <span className="text-[var(--text)] font-black text-sm">{slice.pct}%</span>
        </div>
        <Bar value={slice.pct} max={max} color={color} />
        <div className="flex justify-between mt-1">
          <span className="text-[var(--muted)] text-[10px]">{slice.valueSEK.toLocaleString("sv-SE")} kr</span>
          <span className="text-violet-400 text-[10px] font-semibold">{open?"▲ hide":"▼ details"}</span>
        </div>
      </div>
      {open && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1.5">
          {slice.holdings.map((h,i)=>(
            <div key={i} className="flex justify-between items-center text-xs gap-2">
              <span className="text-[var(--text)] font-semibold w-16 flex-shrink-0">{h.ticker}</span>
              <span className="text-[var(--muted)] truncate flex-1">{h.name}</span>
              <span className="text-[var(--text)] font-bold">{h.pct}%</span>
            </div>
          ))}
          {q && (
            <div className="pt-1">
              <button onClick={()=>setShowNews(s=>!s)} className="text-violet-400 text-xs font-bold">📰 {showNews?"Hide news":"Top news this week"}</button>
              {showNews && (
                <div className="mt-2 space-y-2">
                  {!news && <p className="text-[var(--muted)] text-xs">Loading…</p>}
                  {news && news.length===0 && <p className="text-[var(--muted)] text-xs">No recent news.</p>}
                  {news && news.map((n,i)=>(
                    <a key={i} href={n.link} target="_blank" rel="noreferrer" className="block hover:opacity-80">
                      <p className="text-[var(--text)] text-xs leading-snug">{n.headline}</p>
                      <p className="text-[var(--muted)] text-[10px]">{n.source}{n.time?" · "+timeAgo(n.time):""}</p>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function AnalyticsView({ token }) {
  const [section, setSection] = useState("allocations");
  const [dim, setDim] = useState("assetClass");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  const [overlap, setOverlap] = useState(null);
  const [overlapErr, setOverlapErr] = useState(false);
  useEffect(() => {
    if (!token) return; let c = false; setErr(false);
    fetch(`${BACKEND_URL}/api/analytics`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (!c) setData(d); }).catch(() => { if (!c) setErr(true); });
    return () => { c = true; };
  }, [token]);
  useEffect(() => {
    if (!token || section!=="overlap" || overlap || overlapErr) return; let c = false;
    fetch(`${BACKEND_URL}/api/overlap`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (!c) setOverlap(d); }).catch(() => { if (!c) setOverlapErr(true); });
    return () => { c = true; };
  }, [token, section]);
  const sections = ["allocations","overlap","risk","glossary"];
  const dims = [["assetClass","Asset class"],["sector","Industry"],["country","Country"],["region","Region"]];
  const COLORS = ["bg-violet-500","bg-sky-500","bg-emerald-500","bg-amber-500","bg-rose-500","bg-fuchsia-500","bg-cyan-500","bg-orange-500"];
  const fmtPct = (x) => x!=null ? `${x>0?"+":""}${x}%` : "—";

  const alloc = data?.allocations?.[dim] || [];
  const maxPct = Math.max(...alloc.map(a=>a.pct), 1);

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 overflow-x-auto pb-1" style={{scrollbarWidth:"none"}}>
        {sections.map(s => (
          <button key={s} onClick={()=>setSection(s)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold capitalize whitespace-nowrap transition-all ${section===s?"bg-violet-500/15 text-violet-400 border border-violet-500/25":"text-[var(--muted)] border border-[var(--border)]"}`}>
            {s}
          </button>
        ))}
      </div>

      {err && <Card><p className="text-red-400 text-sm">Couldn't load analytics. (This view is owner-only — make sure the backend is reachable.)</p></Card>}
      {!data && !err && <Card><p className="text-[var(--muted)] text-sm">Crunching your portfolio…</p></Card>}

      {data && section==="allocations" && (
        <div className="space-y-3">
          <div className="flex gap-1.5 overflow-x-auto pb-1" style={{scrollbarWidth:"none"}}>
            {dims.map(([id,label]) => (
              <button key={id} onClick={()=>setDim(id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${dim===id?"bg-violet-500/15 text-violet-400 border border-violet-500/25":"text-[var(--muted)] border border-[var(--border)]"}`}>{label}</button>
            ))}
          </div>
          <p className="text-[var(--muted)] text-[11px] px-1">Total {data.totalSEK?.toLocaleString("sv-SE")} kr · tap a row to see holdings &amp; news</p>
          {alloc.map((slice,i)=>(
            <AllocSlice key={slice.key} slice={slice} dim={dim} max={maxPct} color={COLORS[i%COLORS.length]} token={token} />
          ))}
        </div>
      )}

      {section==="overlap" && (
        <div className="space-y-3">
          {overlapErr && <Card><p className="text-red-400 text-sm">Couldn't load overlap analysis.</p></Card>}
          {!overlap && !overlapErr && <Card><p className="text-[var(--muted)] text-sm">Cross-referencing your funds…</p></Card>}
          {overlap && (
            <>
              <Card>
                <p className="text-[var(--muted)] text-xs leading-relaxed">
                  Shows stocks you're exposed to through <span className="text-[var(--text)] font-semibold">more than one</span> holding —
                  e.g. directly <span className="text-[var(--text)] font-semibold">and</span> via a fund, or via two funds at once.
                  {" "}{overlap.disclaimer}
                </p>
              </Card>
              {overlap.overlaps.length === 0 && (
                <Card><p className="text-[var(--muted)] text-sm">No overlapping exposure found.</p></Card>
              )}
              {overlap.overlaps.map((o) => (
                <OverlapCard key={o.ticker} o={o} />
              ))}
              <p className="text-[var(--muted)] text-[11px] px-1 pt-2">Fund breakdown (curated top holdings)</p>
              {overlap.fundBreakdown.map((f) => (
                <FundHoldingsCard key={f.ticker} f={f} />
              ))}
            </>
          )}
        </div>
      )}

      {data && section==="risk" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Card accent>
              <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Ann. return (1y)</p>
              <p className={`text-2xl font-black ${(data.annReturn??0)>=0?"text-emerald-400":"text-red-400"}`}>{fmtPct(data.annReturn)}</p>
              <p className="text-[var(--muted)] text-xs">From daily prices</p>
            </Card>
            <Card>
              <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Volatility</p>
              <p className="text-2xl font-black text-amber-400">{data.volatility!=null?data.volatility+"%":"—"}</p>
              <p className="text-[var(--muted)] text-xs">Annualised σ</p>
            </Card>
            <Card>
              <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Sharpe ratio</p>
              <p className={`text-2xl font-black ${(data.sharpe??0)>=1?"text-emerald-400":(data.sharpe??0)>=0?"text-amber-400":"text-red-400"}`}>{data.sharpe!=null?data.sharpe:"—"}</p>
              <p className="text-[var(--muted)] text-xs">Rf {data.riskFree}%</p>
            </Card>
            <Card>
              <p className="text-[10px] uppercase tracking-widest text-[var(--muted)]">Holdings</p>
              <p className="text-2xl font-black text-violet-400">{(data.allocations?.assetClass||[]).reduce((s,a)=>s+a.holdings.length,0)}</p>
              <p className="text-[var(--muted)] text-xs">Across {(data.allocations?.assetClass||[]).length} classes</p>
            </Card>
          </div>
          <Card><p className="text-[var(--muted)] text-xs leading-relaxed">Return, volatility and Sharpe are computed from the last 12 months of daily prices across your equity holdings, weighted by current value. Funds without daily price history are excluded from the risk figures (but included in allocations).</p></Card>
        </div>
      )}

      {data && section==="glossary" && (
        <div className="space-y-3">
          {[
            {term:"Sharpe Ratio", val:data.sharpe!=null?String(data.sharpe):"—", color:(data.sharpe??0)>=1?"text-emerald-400":"text-amber-400", exp:"Return earned per unit of risk: (annual return − risk-free rate) ÷ volatility. Above 1.0 is good; below 0 means you're not being paid for the risk."},
            {term:"Volatility", val:data.volatility!=null?data.volatility+"%":"—", color:"text-amber-400", exp:"Annualised standard deviation — how much your portfolio swings year to year. Lower = steadier. Computed from 1y of daily returns."},
            {term:"Ann. return", val:fmtPct(data.annReturn), color:(data.annReturn??0)>=0?"text-emerald-400":"text-red-400", exp:"Annualised return implied by the last 12 months of daily price moves, value-weighted across your equities."},
            {term:"Risk-free rate", val:data.riskFree+"%", color:"text-sky-400", exp:"The return you could get risk-free (≈ short government bonds). Used as the baseline in the Sharpe ratio."},
          ].map((item,i) => (
            <GlossaryItem key={i} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// One overlapping holding — total combined SEK exposure across all
// sources (direct position + each fund/ETF that holds it), expandable
// to show the per-source breakdown.
function OverlapCard({ o }) {
  const [open, setOpen] = useState(false);
  const direct = o.sources.find(s => s.from === "Direct holding");
  return (
    <Card onClick={() => setOpen(s => !s)} className="cursor-pointer">
      <div className="flex justify-between items-center">
        <div>
          <span className="text-[var(--text)] font-bold text-sm">{o.ticker}</span>
          <span className="text-[var(--muted)] text-xs ml-2">{o.name}</span>
        </div>
        <span className="text-[var(--text)] font-black text-sm">{o.totalSEK.toLocaleString("sv-SE")} kr</span>
      </div>
      <div className="flex gap-1.5 mt-2 flex-wrap">
        {direct && <Pill color="violet" sm>Direct</Pill>}
        {o.sources.filter(s=>s.from!=="Direct holding").map((s,i) => (
          <Pill key={i} color="sky" sm>{s.from}</Pill>
        ))}
      </div>
      {open && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1.5">
          {o.sources.map((s,i) => (
            <div key={i} className="flex justify-between items-center text-xs gap-2">
              <span className="text-[var(--muted)] truncate flex-1">{s.from}{s.weight!=null?` · ${s.weight}% weight`:""}</span>
              <span className="text-[var(--text)] font-bold">{s.valueSEK.toLocaleString("sv-SE")} kr</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// One fund/ETF's curated top holdings, with their estimated SEK exposure.
function FundHoldingsCard({ f }) {
  const [open, setOpen] = useState(false);
  return (
    <Card onClick={() => setOpen(s => !s)} className="cursor-pointer">
      <div className="flex justify-between items-center">
        <div>
          <span className="text-[var(--text)] font-bold text-sm">{f.name}</span>
          <span className="text-[var(--muted)] text-xs ml-2">{f.ticker}</span>
        </div>
        <div className="text-right">
          <span className="text-[var(--text)] font-black text-sm">{f.valueSEK.toLocaleString("sv-SE")} kr</span>
          <p className="text-[var(--muted)] text-[10px]">{open?"▲ hide":"▼ top holdings"}</p>
        </div>
      </div>
      {open && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1.5">
          {f.note && <p className="text-[var(--muted)] text-xs">{f.note}</p>}
          {f.topHoldings.map((h,i) => (
            <div key={i} className="flex justify-between items-center text-xs gap-2">
              <span className="text-[var(--text)] font-semibold w-16 flex-shrink-0">{h.ticker}</span>
              <span className="text-[var(--muted)] truncate flex-1">{h.name}</span>
              <span className="text-[var(--muted)] text-[10px] mr-1">{h.weight}%</span>
              <span className="text-[var(--text)] font-bold">{h.valueSEK.toLocaleString("sv-SE")} kr</span>
            </div>
          ))}
          {f.asOf && <p className="text-[var(--muted)] text-[10px] pt-1">As of: {f.asOf}</p>}
        </div>
      )}
    </Card>
  );
}

// One stock's news-derived sentiment — tap to reveal the headlines that
// produced the score (each dotted by its bull/bear/neutral lean).
function SentimentTicker({ t }) {
  const [open, setOpen] = useState(false);
  const labelColor = t.label==="Bullish"?"green":t.label==="Bearish"?"red":"gray";
  return (
    <Card>
      <div className="cursor-pointer" onClick={()=>setOpen(o=>!o)}>
        <div className="flex justify-between items-center mb-2">
          <div className="flex gap-2 items-center">
            <span className="text-[var(--text)] font-bold">{t.ticker}</span>
            <Pill color={labelColor} sm>{t.label}</Pill>
          </div>
          <span className="text-[var(--muted)] text-xs">{t.mentions} headlines</span>
        </div>
        <div className="flex h-2 rounded-full overflow-hidden gap-0.5 bg-[var(--border)]">
          {t.bullish>0 && <div className="bg-emerald-500" style={{width:`${t.bullish}%`}} />}
          {t.neutral>0 && <div className="bg-zinc-500" style={{width:`${t.neutral}%`}} />}
          {t.bearish>0 && <div className="bg-red-500" style={{width:`${t.bearish}%`}} />}
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-emerald-400 text-[11px] font-bold">🟢 {t.bullish}%</span>
          <span className="text-[var(--muted)] text-[11px]">{t.neutral}% neutral</span>
          <span className="text-red-400 text-[11px] font-bold">{t.bearish}% 🔴</span>
        </div>
        <p className="text-violet-400 text-[10px] mt-1.5 font-semibold">{open?"▲ hide headlines":"▼ see the headlines behind this"}</p>
      </div>
      {open && (
        <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-2">
          {t.headlines.length===0 && <p className="text-[var(--muted)] text-xs">No recent headlines found.</p>}
          {t.headlines.map((h,i)=>(
            <a key={i} href={h.link} target="_blank" rel="noreferrer" className="flex gap-2 hover:opacity-80">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${h.lean==="bull"?"bg-emerald-500":h.lean==="bear"?"bg-red-500":"bg-zinc-500"}`} />
              <div className="min-w-0">
                <p className="text-[var(--text)] text-xs leading-snug">{h.headline}</p>
                <p className="text-[var(--muted)] text-[10px]">{h.source}{h.time?" · "+timeAgo(h.time):""}</p>
              </div>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

function SentimentView({ token }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!token) return; let c = false; setErr(false);
    fetch(`${BACKEND_URL}/api/sentiment`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (!c) setData(d); }).catch(() => { if (!c) setErr(true); });
    return () => { c = true; };
  }, [token]);
  const fg = data?.fearGreed;
  const fgColor = fg?.score==null?"text-[var(--muted)]":fg.score>=55?"text-emerald-400":fg.score>=45?"text-amber-400":"text-red-400";
  const cap = s => s ? s.replace(/\b\w/g, c => c.toUpperCase()) : "";
  return (
    <div className="space-y-5">
      {err && <Card><p className="text-red-400 text-sm">Couldn't load sentiment — try again shortly.</p></Card>}
      {!data && !err && <Card><p className="text-[var(--muted)] text-sm">Reading the week's headlines…</p></Card>}
      {data && <>
        {fg ? (
          <Card accent>
            <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest font-semibold mb-2">CNN Fear &amp; Greed Index · live</p>
            <div className="flex items-end gap-4 mb-4">
              <p className={`text-5xl font-black ${fgColor}`}>{fg.score}</p>
              <div className="pb-1"><p className={`text-xl font-bold ${fgColor}`}>{cap(fg.rating)}</p></div>
            </div>
            <div className="h-2.5 rounded-full overflow-hidden bg-gradient-to-r from-red-600 via-amber-400 to-emerald-500 relative">
              <div className="absolute top-0 w-2 h-full bg-white rounded-full shadow" style={{left:`calc(${fg.score}% - 4px)`}} />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-red-400 text-[10px] font-semibold">Fear</span>
              <span className="text-emerald-400 text-[10px] font-semibold">Greed</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3">
              {[["Prev close",fg.previousClose],["1 week ago",fg.week],["1 month ago",fg.month]].map(([k,v])=>(
                <div key={k} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-2 text-center"><p className="text-[var(--muted)] text-[9px] uppercase">{k}</p><p className="text-[var(--text)] text-sm font-bold">{v}</p></div>
              ))}
            </div>
          </Card>
        ) : (
          <Card><p className="text-[var(--muted)] text-sm">CNN Fear &amp; Greed unavailable right now — the per-stock sentiment below still works.</p></Card>
        )}

        <div>
          <SectionLabel>Per-stock sentiment · this week's news</SectionLabel>
          <Card className="border-amber-500/20 bg-amber-500/5 mb-2">
            <p className="text-amber-400 text-[11px] leading-relaxed">📰 Each score is computed from the real news headlines below — tap a stock to see the exact articles. Not from X or Reddit (those APIs are paid).</p>
          </Card>
          <div className="space-y-2">
            {(data.tickers||[]).map(t => <SentimentTicker key={t.ticker} t={t} />)}
          </div>
        </div>
      </>}
    </div>
  );
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d)) return "";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function NewsView({ token }) {
  const [categories, setCategories] = useState([]);
  const [active, setActive] = useState("all");
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true); setErr(false);
    const url = active === "all" ? `${BACKEND_URL}/api/news` : `${BACKEND_URL}/api/news?category=${active}`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (!cancelled) { if (d.categories) setCategories(d.categories); setArticles(d.articles || []); setLoading(false); } })
      .catch(() => { if (!cancelled) { setErr(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [active, token]);

  const chips = [{ id: "all", label: "All" }, ...categories];

  return (
    <div className="space-y-4">
      {/* Category filter */}
      <div className="tab-scroll -mx-4 px-4">
        <div className="flex gap-1.5" style={{ width: "max-content" }}>
          {chips.map(c => (
            <button key={c.id} onClick={() => setActive(c.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${active===c.id ? "bg-violet-500/15 text-violet-400 border border-violet-500/25" : "text-[var(--muted)] border border-[var(--border)]"}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <Card><p className="text-[var(--muted)] text-sm">Loading latest news…</p></Card>}
      {err && <Card><p className="text-red-400 text-sm">Couldn't load news. Is the backend running?</p></Card>}
      {!loading && !err && articles.length === 0 && <Card><p className="text-[var(--muted)] text-sm">No articles found.</p></Card>}

      <div className="space-y-2">
        {articles.map((n, i) => (
          <a key={i} href={n.link} target="_blank" rel="noreferrer" className="block">
            <Card className="hover:border-violet-500/40 transition-colors">
              <div className="flex gap-3">
                {n.image && (
                  <img src={n.image} alt=""
                    onError={(e)=>{ e.currentTarget.style.display = "none"; }}
                    className="w-16 h-16 rounded-xl object-cover flex-shrink-0 bg-[var(--bg)]" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex gap-2 items-center mb-1">
                    <Pill color="violet" sm>{n.source || "News"}</Pill>
                    <span className="text-[var(--muted)] text-xs ml-auto">{timeAgo(n.time)}</span>
                  </div>
                  <p className="text-[var(--text)] text-sm font-semibold leading-snug">{n.headline}</p>
                  {n.summary && <p className="text-[var(--muted)] text-xs mt-1 leading-relaxed line-clamp-2">{n.summary}</p>}
                  <p className="text-violet-400 text-[11px] font-bold mt-2">Read full story ↗</p>
                </div>
              </div>
            </Card>
          </a>
        ))}
      </div>
    </div>
  );
}

function ChangePill({ v }) {
  if (v == null) return <span className="text-[var(--muted)] text-xs">—</span>;
  return <span className={`text-xs font-bold ${v>=0?"text-emerald-400":"text-red-400"}`}>{v>=0?"+":""}{fmtNum(v)}%</span>;
}

function MarketOverview({ token }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  const [chart, setChart] = useState(null);
  useEffect(() => {
    if (!token) return; let c = false;
    // Retry a few times — the free backend cold-starts (~30s) after idle.
    const load = (tries=0) => fetch(`${BACKEND_URL}/api/market`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (!c) { setData(d); setErr(false); } })
      .catch(() => { if (c) return; if (tries < 4) setTimeout(() => load(tries+1), 4000); else setErr(true); });
    load();
    return () => { c = true; };
  }, [token]);
  if (err) return <Card><p className="text-red-400 text-sm">Couldn't load market data — the backend may be waking up. Give it ~30s and reopen this tab.</p></Card>;
  if (!data) return <Card><p className="text-[var(--muted)] text-sm">Loading market…</p></Card>;
  const groups = [["Indices","indices"],["Commodities","commodities"],["Crypto","crypto"],["FX","fx"]];
  return (
    <div className="space-y-4">
      {groups.map(([label,key]) => (
        <div key={key}>
          <SectionLabel>{label}</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {(data[key]||[]).map(m => (
              <Card key={m.symbol} className={m.tvSymbol?"cursor-pointer hover:border-violet-500/40 transition-colors":""}
                onClick={m.tvSymbol?()=>setChart(m):undefined}>
                <div className="flex justify-between items-center">
                  <span className="text-[var(--text)] text-sm font-bold">{m.label}</span>
                  <ChangePill v={m.change} />
                </div>
                <p className="text-[var(--text)] text-lg font-black mt-1">{m.price!=null?Number(m.price).toLocaleString("en-US",{maximumFractionDigits:2}):"—"}</p>
              </Card>
            ))}
          </div>
        </div>
      ))}
      {chart && <ChartModal tvSymbol={chart.tvSymbol} title={chart.label} subtitle={chart.symbol} onClose={()=>setChart(null)} />}
    </div>
  );
}

function TickerSearch({ token, onOpen }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!token || q.trim().length < 2) { setResults([]); return; }
    let c = false; setLoading(true);
    const id = setTimeout(() => {
      fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(q.trim())}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : []).then(d => { if (!c) { setResults(Array.isArray(d)?d:[]); setLoading(false); } })
        .catch(() => { if (!c) setLoading(false); });
    }, 350);
    return () => { c = true; clearTimeout(id); };
  }, [q, token]);
  return (
    <div className="space-y-3">
      <input value={q} onChange={e=>setQ(e.target.value)} autoFocus
        className="w-full bg-[var(--card)] border border-[var(--border)] text-[var(--text)] text-sm rounded-xl px-4 py-2.5 placeholder-[var(--muted)] outline-none focus:border-violet-500/50"
        placeholder="Search any stock — ticker or company name…" />
      {loading && <p className="text-[var(--muted)] text-xs px-1">Searching…</p>}
      <div className="space-y-2">
        {results.map((r,i) => (
          <Card key={i} className="cursor-pointer hover:border-violet-500/40 transition-colors">
            <div onClick={()=>onOpen(r.symbol)} className="flex justify-between items-center">
              <div>
                <span className="text-[var(--text)] font-black text-sm">{r.symbol}</span>
                <p className="text-[var(--muted)] text-xs">{r.name}</p>
              </div>
              <span className="text-[var(--muted)] text-[10px] uppercase">{r.exchange}</span>
            </div>
          </Card>
        ))}
        {q.trim().length>=2 && !loading && results.length===0 && <p className="text-[var(--muted)] text-xs px-1">No matches.</p>}
      </div>
    </div>
  );
}

function Movers({ token, onOpen }) {
  const [view, setView] = useState("topgainers");
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!token) return; let c = false; setRows(null); setErr(false);
    fetch(`${BACKEND_URL}/api/screener?view=${view}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (!c) setRows(d.rows||[]); }).catch(() => { if (!c) setErr(true); });
    return () => { c = true; };
  }, [view, token]);
  const views = [["topgainers","Gainers"],["losers","Losers"],["mostactive","Active"]];
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {views.map(([id,label]) => (
          <button key={id} onClick={()=>setView(id)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${view===id?"bg-violet-500/15 text-violet-400 border border-violet-500/25":"text-[var(--muted)] border border-[var(--border)]"}`}>{label}</button>
        ))}
      </div>
      {err && <Card><p className="text-red-400 text-sm">Couldn't load movers — try again in a moment.</p></Card>}
      {!rows && !err && <Card><p className="text-[var(--muted)] text-sm">Loading movers…</p></Card>}
      <div className="space-y-2">
        {(rows||[]).map((s,i) => (
          <Card key={i} className="cursor-pointer hover:border-violet-500/40 transition-colors">
            <div className="flex justify-between items-center gap-2">
              <div onClick={()=>onOpen(s.ticker)} className="flex items-center gap-2 min-w-0 flex-1">
                {s.logo && <img src={s.logo} alt="" className="w-7 h-7 rounded-lg object-contain bg-white border border-[var(--border)] flex-shrink-0" onError={e=>{e.currentTarget.style.display='none';}} />}
                <div className="min-w-0">
                  <span className="text-[var(--text)] font-black text-sm">{s.ticker}</span>
                  <p className="text-[var(--muted)] text-xs truncate max-w-[180px]">{s.name}</p>
                  {(s.industry || s.sector) && <p className="text-[var(--muted)] text-[10px] truncate max-w-[180px]">{s.industry || s.sector}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <a href={`https://news.google.com/search?q=${encodeURIComponent(s.ticker + " stock")}&hl=en-US&gl=US&ceid=US:en`}
                  target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}
                  className="text-[var(--muted)] hover:text-violet-400 text-sm" title={`News for ${s.ticker}`}>📰</a>
                <div onClick={()=>onOpen(s.ticker)} className="text-right">
                  <p className="text-[var(--text)] text-sm font-bold">{s.price!=null?fmtNum(s.price):"—"}</p>
                  <ChangePill v={s.change} />
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ScreenerView({ token }) {
  const [sub, setSub] = useState("market");
  const [selected, setSelected] = useState(null);
  const subs = [["market","Market"],["search","Search"],["movers","Movers"],["capitol","Capitol Trades"]];
  return (
    <div className="space-y-4">
      <div className="tab-scroll -mx-4 px-4">
        <div className="flex gap-1.5" style={{ width: "max-content" }}>
          {subs.map(([id,label]) => (
            <button key={id} onClick={()=>setSub(id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${sub===id?"bg-violet-500/15 text-violet-400 border border-violet-500/25":"text-[var(--muted)] border border-[var(--border)]"}`}>{label}</button>
          ))}
        </div>
      </div>
      {sub==="market"  && <MarketOverview token={token} />}
      {sub==="search"  && <TickerSearch token={token} onOpen={setSelected} />}
      {sub==="movers"  && <Movers token={token} onOpen={setSelected} />}
      {sub==="capitol" && <CapitolView />}
      {selected && <StockDetail ticker={selected} token={token} onClose={()=>setSelected(null)} />}
    </div>
  );
}

function CapitolRow({ c }) {
  const [imgOk, setImgOk] = useState(true);
  const ring = c.party==="D"?"bg-sky-500/15 text-sky-400":c.party==="R"?"bg-red-500/15 text-red-400":"bg-violet-500/15 text-violet-400";
  const pcol = c.party==="D"?"text-sky-400":c.party==="R"?"text-red-400":"text-violet-400";
  const initials = (c.name||"").split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();
  const meta = [c.party, c.state, c.role || c.chamber].filter(Boolean).join(" · ");
  return (
    <Card>
      <div className="flex items-center gap-3">
        {c.photo && imgOk ? (
          <a href={c.profileUrl||undefined} target="_blank" rel="noreferrer" className="flex-shrink-0">
            <img src={c.photo} onError={()=>setImgOk(false)} alt={c.name} className="w-10 h-12 rounded-lg object-cover object-top bg-[var(--card)] border border-[var(--border)]" />
          </a>
        ) : (
          <div className={`w-10 h-12 rounded-lg flex items-center justify-center text-xs font-black flex-shrink-0 ${ring}`}>{initials}</div>
        )}
        <div className="flex-1 min-w-0">
          <a href={c.profileUrl||undefined} target="_blank" rel="noreferrer" className="block">
            <p className="text-[var(--text)] text-sm font-semibold truncate hover:text-violet-400">{c.name}</p>
          </a>
          <p className="text-[var(--muted)] text-[11px] truncate"><span className={pcol}>{c.party||""}</span>{c.party&&(c.state||c.role)?" · ":""}{[c.state, c.role||c.chamber].filter(Boolean).join(" · ")}</p>
          <div className="flex items-center gap-1.5 mt-1">
            {c.logo && <img src={c.logo} alt="" className="w-4 h-4 rounded-sm object-contain bg-white" onError={e=>{e.currentTarget.style.display='none';}} />}
            <span className="text-[var(--text)] text-xs font-bold">{c.ticker}</span>
            <span className="text-[var(--muted)] text-[11px] truncate">· {c.amount} · {c.date}</span>
          </div>
        </div>
        <Pill color={c.action==="BUY"?"green":c.action==="SELL"?"red":"violet"} sm>{c.action}</Pill>
      </div>
    </Card>
  );
}

function CapitolView() {
  return (
    <div className="space-y-3">
      <Card className="border-amber-500/20 bg-amber-500/5">
        <p className="text-amber-400 text-xs font-semibold">📡 US Senate &amp; House STOCK Act disclosures · tap a member for their official profile</p>
      </Card>
      {CAPITOL_FEED.map((c,i) => <CapitolRow key={i} c={c} />)}
      {CAPITOL_FEED.length===0 && <Card><p className="text-[var(--muted)] text-sm">Loading congressional trades…</p></Card>}
    </div>
  );
}

function EarningsView({ token }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(()=>{
    if(!token) return; let c=false; setErr(false);
    const load=(t=0)=>fetch(`${BACKEND_URL}/api/earnings`,{headers:{Authorization:`Bearer ${token}`}})
      .then(r=>r.ok?r.json():Promise.reject()).then(d=>{ if(!c) setRows(Array.isArray(d)?d:[]); })
      .catch(()=>{ if(c)return; if(t<3) setTimeout(()=>load(t+1),4000); else setErr(true); });
    load();
    return ()=>{c=true;};
  },[token]);
  const today = new Date(); today.setHours(0,0,0,0);
  const days = d => d ? Math.round((new Date(d)-today)/86400000) : null;
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-2">
        <SectionLabel>Earnings — your positions</SectionLabel>
        <a href="https://www.tradingview.com/markets/stocks-usa/earnings/" target="_blank" rel="noreferrer" className="text-violet-400 text-xs font-bold border border-violet-500/25 rounded-xl px-3 py-1 bg-violet-500/5 whitespace-nowrap mb-3">See full calendar →</a>
      </div>
      {err && <Card><p className="text-red-400 text-sm">Couldn't load earnings — the backend may be waking up. Reopen this tab in ~30s.</p></Card>}
      {!rows && !err && <Card><p className="text-[var(--muted)] text-sm">Loading earnings dates…</p></Card>}
      {rows && rows.map((e,i)=>{
        const dd = days(e.nextEarnings);
        const upcoming = dd!=null && dd>=0;
        const hasLast = e.lastEpsActual!=null && e.lastEpsEstimate!=null;
        const beat = hasLast && e.lastEpsActual>=e.lastEpsEstimate;
        return (
          <Card key={i} accent={upcoming && dd<=7}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--text)] font-black text-sm">{e.ticker}</span>
                  <span className="text-[var(--muted)] text-xs truncate">{e.name}</span>
                </div>
                {e.sector && <p className="text-[var(--muted)] text-[11px] mt-0.5">{e.sector}</p>}
              </div>
              <div className="text-right flex-shrink-0">
                {e.nextEarnings ? (<>
                  <p className="text-[var(--text)] text-xs font-bold">{e.nextEarnings}</p>
                  <p className={`text-[10px] font-semibold ${upcoming?(dd<=7?"text-amber-400":"text-violet-400"):"text-[var(--muted)]"}`}>
                    {upcoming ? (dd===0?"Today":`in ${dd} day${dd===1?"":"s"}`) : `reported ${-dd}d ago`}
                  </p>
                </>) : <p className="text-[var(--muted)] text-xs">TBA</p>}
              </div>
            </div>
            {(hasLast || (upcoming && e.epsEstimate!=null)) && (
              <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--border)] text-[11px] flex-wrap">
                {upcoming && e.epsEstimate!=null && (
                  <><span className="text-[var(--muted)]">Est EPS</span><span className="text-[var(--text)] font-bold">{fmtNum(e.epsEstimate)}</span></>
                )}
                {hasLast && (
                  <><span className="text-[var(--muted)]">{upcoming?"· Last":"Last EPS"}</span><span className="text-[var(--text)] font-bold">{fmtNum(e.lastEpsActual)}</span><span className="text-[var(--muted)]">vs {fmtNum(e.lastEpsEstimate)}</span><Pill color={beat?"green":"red"} sm>{beat?"Beat":"Miss"}</Pill></>
                )}
              </div>
            )}
          </Card>
        );
      })}
      {rows && rows.length===0 && <Card><p className="text-[var(--muted)] text-sm">No earnings data available yet.</p></Card>}
    </div>
  );
}

function ResearchView() {
  const [content, setContent] = useState(RESEARCH_DEFAULT);
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <SectionLabel>Research Sheet</SectionLabel>
        <button className="text-xs text-violet-400 border border-violet-500/25 rounded-xl px-3 py-1 bg-violet-500/5 mb-3">Save</button>
      </div>
      <textarea value={content} onChange={e=>setContent(e.target.value)}
        className="w-full min-h-[500px] bg-[var(--card)] border border-[var(--border)] rounded-2xl p-4 text-[var(--text)] text-sm font-mono leading-relaxed resize-none outline-none focus:border-violet-500/50" />
    </div>
  );
}

function NetworkView() {
  const [input, setInput] = useState("");
  return (
    <div className="space-y-4">
      <Card>
        <textarea rows={3} value={input} onChange={e=>setInput(e.target.value)}
          className="w-full bg-transparent text-[var(--text)] text-sm placeholder-[var(--muted)] outline-none resize-none"
          placeholder="Share a thesis, trade idea, or observation…" />
        <div className="flex justify-between items-center mt-2 pt-2 border-t border-[var(--border)]">
          <span className="text-[var(--muted)] text-xs">Tag with $TICKER</span>
          <button className="bg-violet-500 text-white text-xs font-bold rounded-xl px-4 py-1.5 hover:bg-violet-600 transition-colors">Post</button>
        </div>
      </Card>
      {SOCIAL_POSTS.map((p,i) => (
        <Card key={i}>
          <div className="flex gap-2 items-center mb-3">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-xs font-black text-white">{p.avatar}</div>
            <div>
              <p className="text-[var(--text)] text-sm font-bold">{p.user}</p>
              <p className="text-[var(--muted)] text-xs">{p.time}</p>
            </div>
          </div>
          <p className="text-[var(--text)] text-sm leading-relaxed">{p.text}</p>
          <div className="flex items-center gap-2 mt-3">
            {p.tickers.map(t => <Pill key={t} color="violet" sm>{t}</Pill>)}
            <button className="ml-auto text-[var(--muted)] text-xs">♡ {p.likes}</button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function TasksView() {
  const [tasks, setTasks] = useState([
    { id:1, text:"Review PLTR earnings call transcript", done:false, priority:"high" },
    { id:2, text:"Decide on FLYE — exit or hold?",       done:false, priority:"high" },
    { id:3, text:"Add Novo Nordisk to watchlist alerts", done:false, priority:"medium" },
    { id:4, text:"Update Q3 investment thesis doc",      done:false, priority:"medium" },
    { id:5, text:"Research Spotify as potential addition",done:true, priority:"low" },
  ]);
  const [input, setInput] = useState("");
  const [priority, setPriority] = useState("medium");

  const toggle = id => setTasks(t=>t.map(x=>x.id===id?{...x,done:!x.done}:x));
  const add = () => {
    if (!input.trim()) return;
    setTasks(t=>[...t,{id:Date.now(),text:input.trim(),done:false,priority}]);
    setInput("");
  };
  const pColor = {high:"red",medium:"amber",low:"gray"};

  return (
    <div className="space-y-4">
      <Card>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()}
          className="w-full bg-transparent text-[var(--text)] text-sm placeholder-[var(--muted)] outline-none mb-3"
          placeholder="Add a task…" />
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5">
            {["high","medium","low"].map(p => (
              <button key={p} onClick={()=>setPriority(p)}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold capitalize border transition-all ${priority===p?"border-violet-500/50 text-violet-400 bg-violet-500/10":"border-[var(--border)] text-[var(--muted)]"}`}>{p}</button>
            ))}
          </div>
          <button onClick={add} className="bg-violet-500 text-white text-xs font-bold rounded-xl px-4 py-1.5">Add</button>
        </div>
      </Card>

      <div className="space-y-2">
        {tasks.filter(t=>!t.done).map(t => (
          <Card key={t.id}>
            <div className="flex items-center gap-3">
              <button onClick={()=>toggle(t.id)} className="w-5 h-5 rounded-full border-2 border-[var(--muted)] flex-shrink-0 hover:border-violet-400 transition-colors" />
              <span className="flex-1 text-[var(--text)] text-sm">{t.text}</span>
              <Pill color={pColor[t.priority]} sm>{t.priority}</Pill>
            </div>
          </Card>
        ))}
        {tasks.some(t=>t.done) && <>
          <p className="text-[var(--muted)] text-[10px] uppercase tracking-widest pt-2">Done</p>
          {tasks.filter(t=>t.done).map(t => (
            <Card key={t.id} className="opacity-40">
              <div className="flex items-center gap-3">
                <button onClick={()=>toggle(t.id)} className="w-5 h-5 rounded-full border-2 border-emerald-500 bg-emerald-500/20 flex-shrink-0" />
                <span className="flex-1 text-[var(--muted)] text-sm line-through">{t.text}</span>
              </div>
            </Card>
          ))}
        </>}
      </div>
    </div>
  );
}

function CalendarView() {
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth());
  const [year,  setYear]  = useState(today.getFullYear());

  const events = [
    { date: "2026-06-15", label: "INVE-B Dividend",    color: "bg-emerald-500" },
    { date: "2026-07-29", label: "GOOGL Earnings",     color: "bg-violet-500"  },
    { date: "2026-08-04", label: "PLTR Earnings",      color: "bg-violet-500"  },
    { date: "2026-08-06", label: "LMND Earnings",      color: "bg-violet-500"  },
    { date: "2026-08-07", label: "DUOL Earnings",      color: "bg-violet-500"  },
    { date: "2026-08-11", label: "HIMS Earnings",      color: "bg-violet-500"  },
  ];

  const firstDay  = new Date(year, month, 1).getDay();
  const daysCount = new Date(year, month+1, 0).getDate();
  const monthName = new Date(year, month).toLocaleString("en-US", {month:"long"});

  const getEvents = day => {
    const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    return events.filter(e=>e.date===dateStr);
  };

  const cells = [];
  for (let i=0; i<(firstDay===0?6:firstDay-1); i++) cells.push(null);
  for (let i=1; i<=daysCount; i++) cells.push(i);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={()=>{ if(month===0){setMonth(11);setYear(y=>y-1)}else setMonth(m=>m-1)}} className="text-[var(--muted)] w-8 h-8 rounded-xl border border-[var(--border)] flex items-center justify-center hover:border-violet-500/50 transition-colors">‹</button>
        <p className="text-[var(--text)] font-bold">{monthName} {year}</p>
        <button onClick={()=>{ if(month===11){setMonth(0);setYear(y=>y+1)}else setMonth(m=>m+1)}} className="text-[var(--muted)] w-8 h-8 rounded-xl border border-[var(--border)] flex items-center justify-center hover:border-violet-500/50 transition-colors">›</button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => <p key={d} className="text-[var(--muted)] text-[10px] text-center font-bold uppercase tracking-wide">{d}</p>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((day,i) => {
          if (!day) return <div key={i} />;
          const isToday = day===today.getDate() && month===today.getMonth() && year===today.getFullYear();
          const dayEvents = getEvents(day);
          return (
            <div key={i} className={`aspect-square rounded-xl flex flex-col items-center justify-center relative cursor-pointer transition-all ${isToday?"bg-violet-500 text-white":"hover:bg-[var(--card)] text-[var(--text)]"}`}>
              <span className="text-xs font-bold">{day}</span>
              {dayEvents.length > 0 && <div className={`absolute bottom-1 w-1 h-1 rounded-full ${isToday?"bg-white":dayEvents[0].color}`} />}
            </div>
          );
        })}
      </div>

      <SectionLabel>Upcoming Events</SectionLabel>
      <div className="space-y-2">
        {events.filter(e=>new Date(e.date)>=today).slice(0,5).map((e,i) => (
          <Card key={i}>
            <div className="flex items-center gap-3">
              <div className={`w-2 h-8 rounded-full ${e.color} flex-shrink-0`} />
              <div>
                <p className="text-[var(--text)] text-sm font-semibold">{e.label}</p>
                <p className="text-[var(--muted)] text-xs">{new Date(e.date).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── LOGIN GATE ─────────────────────────────────────────────────
function LoginGate({ onLogin }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const v = pw.trim();
    if (!v || busy) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch(`${BACKEND_URL}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: v }),
      });
      if (res.ok) {
        const data = await res.json();
        onLogin(data.role, data.token);
      } else {
        setErr("Incorrect password or code");
      }
    } catch {
      setErr("Can't reach the server. Is the backend running?");
    }
    setBusy(false);
  };
  return (
    <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-2xl font-black text-white mx-auto shadow-lg shadow-violet-500/30">W</div>
          <h1 className="text-2xl font-black text-[var(--text)]">MERIDIAN</h1>
          <p className="text-[var(--muted)] text-sm">Enter your password or access code</p>
        </div>
        <Card>
          <input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}
            placeholder="Password or access code"
            className={`w-full bg-[var(--bg)] border rounded-xl px-4 py-3 text-[var(--text)] text-sm outline-none transition-all ${err?"border-red-500":"border-[var(--border)] focus:border-violet-500/50"}`} />
          {err && <p className="text-red-400 text-xs mt-1">{err}</p>}
          <button onClick={submit} disabled={busy} className="w-full mt-3 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 text-white font-bold rounded-xl py-3 text-sm transition-colors">
            {busy ? "Checking…" : "Enter"}
          </button>
        </Card>
        <p className="text-center text-[var(--muted)] text-xs">williamgrip.se · Investment OS</p>
      </div>
    </div>
  );
}

// ─── VIEWS MAP ──────────────────────────────────────────────────
const VIEWS = {
  dashboard: DashboardView,
  portfolio: PortfolioView,
  analytics: AnalyticsView,
  sentiment: SentimentView,
  news: NewsView,
  screener: ScreenerView,
  capitol: CapitolView,
  earnings: EarningsView,
  research: ResearchView,
  network: NetworkView,
  tasks: TasksView,
  calendar: CalendarView,
};

// ─── APP SHELL ──────────────────────────────────────────────────
export default function App() {
  const [active,    setActive]    = useState("dashboard");
  const [role,      setRole]      = useState(null);   // null | "owner" | "guest"
  const [token,     setToken]     = useState(null);   // signed token from backend
  const loggedIn = role !== null;
  const isOwner  = role === "owner";
  const [time,      setTime]      = useState(new Date());
  const [darkMode,  setDarkMode]  = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [, setDataVersion]        = useState(0);   // bumped when live data arrives
  const [dataStatus, setDataStatus] = useState("offline"); // offline | live | loading

  // Pull real data from the backend using the signed token.
  // The portfolio is fetched ONLY for the owner. Market data (news,
  // capitol) is fetched for anyone logged in. If the backend is
  // offline, news/capitol fall back to saved samples; the portfolio
  // simply stays empty for guests.
  useEffect(() => {
    if (!loggedIn || !token) return;
    let cancelled = false;
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    async function refresh() {
      setDataStatus((s) => (s === "live" ? "live" : "loading"));
      let anyLive = false;
      try {
        // 1) Portfolio — OWNER ONLY. Replaces the (empty) arrays in place.
        if (isOwner) {
          const pRes = await fetch(`${BACKEND_URL}/api/portfolio`, auth);
          if (pRes.ok) {
            const p = await pRes.json();
            MY_PORTFOLIO.stocks = p.stocks || [];
            MY_PORTFOLIO.funds  = p.funds  || [];
            MY_PORTFOLIO.etfs   = p.etfs   || [];
            anyLive = true;
          }
        }

        // 2) News (default mix — for the Dashboard "Latest News" strip)
        try {
          const nRes = await fetch(`${BACKEND_URL}/api/news`, auth);
          if (nRes.ok) {
            const news = await nRes.json();
            const articles = news.articles || [];
            if (articles.length) {
              NEWS_FEED.length = 0;
              articles.slice(0, 20).forEach((n) =>
                NEWS_FEED.push({
                  ticker: (n.source || "NEWS").slice(0, 10),
                  headline: n.headline,
                  source: n.source || "",
                  link: n.link,
                  time: n.time ? new Date(n.time).toLocaleDateString() : "",
                  sentiment: "neutral",
                })
              );
              anyLive = true;
            }
          }
        } catch { /* keep sample news */ }

        // 3) Capitol Trades
        try {
          const cRes = await fetch(`${BACKEND_URL}/api/capitol`, auth);
          if (cRes.ok) {
            const cap = await cRes.json();
            if (Array.isArray(cap) && cap.length) {
              CAPITOL_FEED.length = 0;
              cap.forEach((c) => CAPITOL_FEED.push(c));
              anyLive = true;
            }
          }
        } catch { /* keep sample capitol */ }

        if (!cancelled) { setDataStatus(anyLive ? "live" : "offline"); setDataVersion((v) => v + 1); }
      } catch {
        if (!cancelled) setDataStatus("offline");
      }
    }

    refresh();
    const id = setInterval(refresh, 60_000); // refresh every minute
    return () => { cancelled = true; clearInterval(id); };
  }, [loggedIn, token, isOwner]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = e => setDarkMode(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Tabs the current role is allowed to see
  const visibleTabs = isOwner ? TABS : TABS.filter(t => !OWNER_ONLY.includes(t.id));
  // If the active tab isn't allowed for this role, fall back to the first allowed one
  const safeActive = visibleTabs.some(t => t.id === active) ? active : (visibleTabs[0]?.id || "news");
  const View = VIEWS[safeActive];
  const activeTab = TABS.find(t=>t.id===safeActive);
  const visibleBottomNav = BOTTOM_NAV.filter(id => visibleTabs.some(t => t.id === id));

  const CSS_VARS = darkMode ? `
    --bg: #09090b; --card: #111113; --border: #27272a;
    --text: #fafafa; --muted: #71717a;
  ` : `
    --bg: #f8f8f8; --card: #ffffff; --border: #e4e4e7;
    --text: #09090b; --muted: #71717a;
  `;

  if (!loggedIn) return (
    <>
      <style>{`:root { ${CSS_VARS} } * { box-sizing: border-box; }`}</style>
      <LoginGate onLogin={(r, t) => { setRole(r); setToken(t); setActive(r === "owner" ? "dashboard" : "news"); }} />
    </>
  );

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800;900&family=DM+Mono:wght@400;500&display=swap');
        :root { ${CSS_VARS} }
        * { box-sizing: border-box; margin: 0; }
        body { background: var(--bg); }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 2px; }
        .tab-scroll { overflow-x: auto; scrollbar-width: none; }
        .tab-scroll::-webkit-scrollbar { display: none; }
      `}</style>

      <div className="min-h-screen bg-[var(--bg)]">
        {/* Header */}
        <div className="sticky top-0 z-40 bg-[var(--bg)]/90 backdrop-blur border-b border-[var(--border)]">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-xs font-black text-white shadow-sm shadow-violet-500/40">W</div>
              <div>
                <p className="text-[var(--text)] text-sm font-black leading-none tracking-tight">MERIDIAN</p>
                <p className="text-[var(--muted)] text-[9px] tracking-widest font-semibold">WILLIAMGRIP.SE</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5" title={dataStatus === "live" ? "Live data connected" : dataStatus === "loading" ? "Connecting…" : "Backend offline — showing saved data"}>
                <span className={`w-2 h-2 rounded-full ${dataStatus === "live" ? "bg-emerald-500" : dataStatus === "loading" ? "bg-amber-500" : "bg-zinc-500"}`} />
                <span className="text-[var(--muted)] text-[9px] tracking-wide uppercase hidden sm:inline">{dataStatus === "live" ? "Live" : dataStatus === "loading" ? "Sync" : "Offline"}</span>
              </div>
              <div className="text-right hidden sm:block">
                <p className="text-[var(--text)] text-xs font-mono">{time.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}</p>
                <p className="text-[var(--muted)] text-[9px] tracking-wide">NYSE {(() => { const h = new Date().toLocaleString("en-US",{timeZone:"America/New_York",hour:"numeric",hour12:false}); const m = new Date().getMinutes(); const tot = parseInt(h)*60+m; return tot>=570&&tot<960?"OPEN":"CLOSED"; })()}</p>
              </div>
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-xs font-black text-white">WG</div>
            </div>
          </div>

          {/* Tab bar */}
          <div className="tab-scroll">
            <div className="flex gap-1 px-4 pb-3 max-w-2xl mx-auto" style={{width:"max-content",minWidth:"100%"}}>
              {visibleTabs.map(tab => (
                <button key={tab.id} onClick={()=>setActive(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${safeActive===tab.id?"bg-violet-500/15 text-violet-400 border border-violet-500/25":"text-[var(--muted)] hover:text-[var(--text)]"}`}>
                  <span className="text-[11px]">{tab.icon}</span>{tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-2xl mx-auto px-4 py-5 pb-28">
          <div className="mb-5">
            <h1 className="text-xl font-black text-[var(--text)] tracking-tight">{activeTab?.label}</h1>
            <div className="h-0.5 w-8 bg-violet-500 rounded-full mt-1" />
          </div>
          <View isOwner={isOwner} token={token} />
        </div>

        {/* Bottom nav */}
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-[var(--bg)]/95 backdrop-blur border-t border-[var(--border)]">
          <div className="max-w-2xl mx-auto px-2 py-2 flex justify-around">
            {visibleBottomNav.map(id => {
              const tab = TABS.find(t=>t.id===id);
              return (
                <button key={id} onClick={()=>setActive(id)}
                  className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all ${safeActive===id?"text-violet-400":"text-[var(--muted)]"}`}>
                  <span className="text-lg">{tab.icon}</span>
                  <span className="text-[9px] font-bold tracking-wide">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Claude AI floating assistant — owner only (knows your portfolio) */}
        {isOwner && <ClaudeAssistant />}
      </div>
    </div>
  );
}