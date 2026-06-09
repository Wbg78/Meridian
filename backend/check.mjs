// Quick health check: logs in and prints live prices for your holdings.
// Run with:  node check.mjs
const b = "http://localhost:3001";

const login = await fetch(b + "/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "ABER34ZT" }),
});
const l = await login.json();
console.log("login:", login.status, l.role || l.error);
if (!l.token) { console.log(">> Login failed — check OWNER_PASSWORD in .env and restart."); process.exit(0); }

const pr = await fetch(b + "/api/portfolio", { headers: { authorization: "Bearer " + l.token } });
const p = await pr.json();
console.log("portfolio:", pr.status, p.error || "");
console.log("--- prices ---");
(p.stocks || []).forEach((s) => console.log(`${s.ticker.padEnd(7)} ${s.price ?? "null"} ${s.currency || ""}`));
const ok = (p.stocks || []).filter((s) => s.price != null).length;
console.log(`\n${ok}/${(p.stocks || []).length} stocks have live prices.`);
