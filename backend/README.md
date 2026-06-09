# Meridian Backend — real market data

This little server fetches **live data** and hands it to your Meridian app:

- **Live prices** for your holdings (Yahoo Finance)
- **News** for your tickers (Yahoo Finance)
- **Capitol Trades** — US politician disclosures
- **Screener** — Finviz top gainers

You don't need any API keys. It's all free.

---

## Run it

Open Terminal and run:

```bash
cd ~/meridian/backend
cp .env.example .env      # then edit .env: set OWNER_PASSWORD, ACCESS_CODE, SESSION_SECRET
npm install
npm start
```

> Security note: passwords now live in `.env` (gitignored), not in the app.
> See `../SECURITY.md`. Without a `.env` the server still runs but warns and
> uses default credentials.

When it works you'll see:

```
✅ Meridian backend running on http://localhost:3001
```

**Leave this Terminal tab open** — it's your data server. Open a *new* tab
(Cmd + T) to run your frontend.

---

## Check it's working

With the server running, open these in your browser:

- http://localhost:3001/health → should say `{"ok":true,...}`
- http://localhost:3001/api/portfolio → your positions with live prices
- http://localhost:3001/api/news → recent news
- http://localhost:3001/api/capitol → politician trades

In the app itself, the little dot in the top-right header turns **green**
when live data is connected. Grey means the server isn't running (the app
then falls back to your saved numbers, so it never breaks).

---

## When you buy or sell

Edit the `HOLDINGS` block at the top of `server.js` — change the `shares`
or `avgCost`. Prices update themselves.

## If a price looks wrong

It's almost always the ticker mapping. Open `symbols.js` and fix the Yahoo
symbol for that holding (Swedish stocks end in `.ST`, Copenhagen `.CO`,
Paris `.PA`, German `.DE`).

---

## Going live on williamgrip.se (later)

1. Push this `backend` folder to GitHub.
2. Deploy it on [Railway](https://railway.app) (free) → you get a URL.
3. In the frontend, set `VITE_BACKEND_URL` to that URL (or point a
   `api.williamgrip.se` subdomain at it) so your phone can reach it too.

Until then it runs locally on your Mac at `localhost:3001`.

---

## Heads-up on the scrapers

Yahoo (prices + news) is very reliable. **Capitol Trades** and **Finviz**
are scraped from their public sites — if either site changes its layout,
those two endpoints may need a small fix. Prices and news will keep working
regardless.
