// Tests every data endpoint and prints what's working. Run: node diag.mjs
const b = "http://localhost:3001";
const l = await (await fetch(b + "/api/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "ABER34ZT" }),
})).json();
if (!l.token) { console.log("LOGIN FAILED:", l); process.exit(0); }
const H = { authorization: "Bearer " + l.token };
async function hit(path) {
  try { const r = await fetch(b + path, { headers: H }); return { status: r.status, j: await r.json() }; }
  catch (e) { return { status: "ERR", j: { error: String(e) } }; }
}

const port = await hit("/api/portfolio");
const withPrice = (port.j.stocks || []).filter(s => s.price != null).length;
console.log(`portfolio: ${port.status} | ${withPrice}/${(port.j.stocks||[]).length} stocks have prices ${port.j.error||""}`);

const mk = await hit("/api/market");
console.log(`market:    ${mk.status} | S&P=${mk.j.indices?.[0]?.price ?? "null"} Gold=${mk.j.commodities?.[0]?.price ?? "null"} ${mk.j.error||""}`);

const mv = await hit("/api/screener?view=topgainers");
console.log(`movers:    ${mv.status} | rows=${(mv.j.rows||[]).length} ${mv.j.error||""}`);

const cap = await hit("/api/capitol");
console.log(`capitol:   ${cap.status} | items=${Array.isArray(cap.j) ? cap.j.length : "0"} ${cap.j.error||""}`);

const se = await hit("/api/search?q=NVDA");
console.log(`search:    ${se.status} | results=${Array.isArray(se.j) ? se.j.length : "0"} ${se.j.error||""}`);
