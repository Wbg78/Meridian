// frontend/src/PatentInfo.jsx
// Patent-Info — top-level Meridian section with FEED / SANDBOX sub-nav.
// Owner-only tab: id "patents-info", icon "⊞"
//
// Data: EPO OPS via existing backend routes (no new keys).
// AI:   Uses ANTHROPIC_API_KEY already in backend (degrades gracefully if missing).
//
// TODO: ontology ingestion hook — when a PatentEvent is loaded into the Sandbox,
// it can later be pushed as a node/event into the digital-twin investment graph.

import { useState } from "react";
import Feed    from "./patent/Feed.jsx";
import Sandbox from "./patent/Sandbox.jsx";

export default function PatentInfo({ token }) {
  const [sub, setSub]                   = useState("feed");   // "feed" | "sandbox"
  const [sandboxPatent, setSandboxPatent] = useState(null);   // PatentEvent or null
  const [recentlyViewed, setRecentlyViewed] = useState([]);   // feed → sandbox bridge

  // Called by Feed when user clicks "Load in Sandbox" on a patent card
  function handleSandboxLoad(patentEvent, recent) {
    if (patentEvent) setSandboxPatent(patentEvent);
    if (recent)      setRecentlyViewed(recent);
    setSub("sandbox");
  }

  return (
    <div className="space-y-4">
      {/* Sub-nav */}
      <div className="flex gap-1.5">
        {[["feed", "FEED"], ["sandbox", "SANDBOX ⊞"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${
              sub === id
                ? "bg-violet-500/15 text-violet-400 border-violet-500/30"
                : "text-[var(--muted)] border-[var(--border)] hover:text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[var(--muted)] text-[10px]">EPO/OPS · Claude Haiku</span>
        </div>
      </div>

      {sub === "feed" && (
        <Feed token={token} onSandboxLoad={handleSandboxLoad} />
      )}

      {sub === "sandbox" && (
        <Sandbox
          token={token}
          initialPatent={sandboxPatent}
          recentlyViewed={recentlyViewed}
        />
      )}
    </div>
  );
}
