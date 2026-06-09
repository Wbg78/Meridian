# How Meridian keeps your portfolio private

## The model

- Your **passwords and join code live on the backend** as environment
  variables — never in the frontend code that visitors download.
- Logging in calls `POST /api/login`. The backend checks your input and, if
  correct, returns a **signed token** that says whether you're `owner` or
  `guest`. The token is signed with `SESSION_SECRET`, so it can't be forged.
- `GET /api/portfolio` requires an **owner** token. A guest's token is
  rejected with `403 Forbidden`. The portfolio data is **never sent** to a
  guest — and it isn't in the frontend bundle either, so there's nothing to
  dig out of the page source.
- Market data (news, Capitol Trades) requires any valid login.
- `CORS` is locked to the origins in `ALLOWED_ORIGINS`, so other websites
  can't call your API from a browser.

## First-time local setup

```bash
cd ~/meridian/backend
cp .env.example .env
# generate a strong signing secret:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# paste that into SESSION_SECRET in .env, and set OWNER_PASSWORD + ACCESS_CODE
npm install
npm start
```

## When you deploy

On your **backend host** (Railway/Render), set these environment variables
(same names as `.env`): `OWNER_PASSWORD`, `ACCESS_CODE`, `SESSION_SECRET`,
and `ALLOWED_ORIGINS` (must include `https://williamgrip.se`).

On **Netlify** (frontend), set `VITE_BACKEND_URL` to your backend's URL.

## Honest limits

- This is solid, normal app security for a personal tool: forged tokens are
  blocked, guests can't fetch the portfolio, secrets aren't shipped to the
  browser.
- It is **not** bank-grade. The token lives in the browser tab while you're
  logged in. Don't reuse your important passwords here, and change
  `OWNER_PASSWORD` from any value that's been shared in chat.
- When you add your friend with real per-user accounts later, a managed auth
  service (e.g. Supabase) handles password hashing and sessions for you.
