// Reveals the real error from yahoo-finance2's quote(). Run: node probe.mjs
import YF from "yahoo-finance2";
const yf = (YF && typeof YF.quote === "function") ? YF : (YF?.default || YF);

async function test(sym) {
  try {
    const q = await yf.quote(sym);
    console.log(`OK ${sym}: price=${q.regularMarketPrice} ${q.currency}`);
  } catch (e) {
    console.log(`ERROR ${sym}: ${e.name}: ${e.message}`);
    if (e.result) console.log("   (data WAS returned despite error):", JSON.stringify(e.result).slice(0, 200));
  }
}

await test("AAPL");
await test("PLTR");
await test("INVE-B.ST");
