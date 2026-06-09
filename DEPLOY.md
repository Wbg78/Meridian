# Putting Meridian live on williamgrip.se

Two pieces go online:

| Piece | Hosts on | Result |
|-------|----------|--------|
| **Frontend** (the app) | Vercel (free) | `williamgrip.se` |
| **Backend** (data server) | Railway (free) | `https://...up.railway.app` |

You'll do the account clicks (I can't log into accounts for you); I've prepared
all the config so it "just works".

---

## Part A — Backend on Railway (do this first)

The app needs the data server online before it can show live data.

1. Push your project to GitHub (or use Railway's "Deploy from local").
   - Easiest: at [github.com](https://github.com) create a repo, then in Terminal:
     ```bash
     cd ~/meridian
     git add .
     git commit -m "Meridian app + backend"
     git branch -M main
     git remote add origin <your-repo-url>
     git push -u origin main
     ```
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick your repo.
3. In the service settings set **Root Directory** to `backend`.
4. Railway runs `npm install` then `npm start` automatically. When it's live it gives you a URL like `https://meridian-backend-production.up.railway.app`.
5. Test it: open `<that-url>/health` — you should see `{"ok":true,...}`.

**Copy that Railway URL — you need it in Part B.**

---

## Part B — Frontend on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project** → import the same GitHub repo.
2. Set **Root Directory** to `frontend`. Framework preset: **Vite** (auto-detected).
3. Under **Environment Variables**, add:
   - Name: `VITE_BACKEND_URL`
   - Value: your Railway URL from Part A (e.g. `https://meridian-backend-production.up.railway.app`)
4. Click **Deploy**. You get a URL like `meridian.vercel.app`. Open it — the app
   should load and the header dot should be **green** (live data).

---

## Part C — Connect your domain (One.com)

1. In Vercel → your project → **Settings → Domains** → add `williamgrip.se` and `www.williamgrip.se`.
2. Vercel shows you the exact DNS records to add. They are normally:

   | Type  | Name | Value |
   |-------|------|-------|
   | A     | `@`  | `76.76.21.21` |
   | CNAME | `www`| `cname.vercel-dns.com` |

   > Use whatever Vercel shows on screen — that's the source of truth.

3. Log in to **One.com → DNS settings for williamgrip.se** and add those two records.
4. Wait 10–60 minutes for DNS to propagate. Vercel auto-issues an HTTPS certificate.
   `https://williamgrip.se` is now your app.

---

## Install on your phone

On your iPhone, open `https://williamgrip.se` in **Safari** → Share → **Add to
Home Screen**. It gets the Meridian icon and opens full-screen like a native app.

---

## Notes

- **Keeping data fresh:** Railway's free tier may sleep an idle backend. If the
  dot is grey for a few seconds on first open, it's the backend waking up.
- **Security:** the login password lives in the frontend code right now, which
  is fine for a personal tool but not real security. When you add your friend,
  we move to proper accounts (Supabase).
- **Updating the app later:** push changes to GitHub → Vercel and Railway
  redeploy automatically.
