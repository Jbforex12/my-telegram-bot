# Fresh start — local first, one host online

## Why Railway + Render + Netlify caused trouble

| Platform | What it should do | What goes wrong if duplicated |
|----------|-------------------|-------------------------------|
| **Render / Railway** | Run `node bot.js` (Telegram + admin API) | **Only one** may run the bot. Two services = Telegram **409 Conflict**, random failures, 502s. |
| **Netlify** | Static files only (optional admin UI) | Safe **only if** it does not run the bot. Admin must call **one** API URL (Render or Railway), not localhost. |
| **Your PC** | Local testing | Stop `npm start` before the cloud bot runs. |

**Rule:** Exactly **one** running copy of the bot (local **or** cloud, not both; never two cloud hosts).

---

## Step 0 — Turn off the extra hosts

Do this before redeploying:

1. **Railway** — Open the service → **Settings** → **Remove service** or set to **Stopped** / delete deployment.
2. **Render** — If you have an old web service for this bot, **Suspend** it (you will create one fresh service below).
3. **Netlify** — **Optional:** delete the site, or keep it but do not use it until Render works. Prefer admin at `https://YOUR-APP.onrender.com/admin` instead.
4. **Your PC** — Close any terminal running `node bot.js` or `START-BOT.ps1`.

---

## Step 1 — Local (must work first)

Project folder (use this, not System32):

```
C:\Users\BRIGHT\Documents\my-telegram-bot
```

1. Open `.env` — confirm real values (not placeholders):

   - `TELEGRAM_BOT_TOKEN`
   - `GROQ_API_KEY`
   - `ADMIN_API_KEY`
   - `ADMIN_CHAT_ID`

2. In PowerShell:

   ```powershell
   cd C:\Users\BRIGHT\Documents\my-telegram-bot
   npm install
   npm start
   ```

3. Check:

   - http://localhost:3001/health → `{"status":"ok",...}`
   - http://localhost:3001/admin → login with `ADMIN_API_KEY` from `.env`
   - Telegram → send the bot a message; it should reply.

4. Press `Ctrl+C` to stop the bot before going online.

---

## Step 2 — Deploy on Render only (recommended)

Your repo already includes `render.yaml` with a **persistent disk** for `users.json` and `codes.json`.

1. Push latest code to GitHub (`Jbforex12/my-telegram-bot`).
2. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint** / connect repo → select `my-telegram-bot`.
3. **Environment** — add the same variables as `.env`:

   | Key | Value |
   |-----|--------|
   | `TELEGRAM_BOT_TOKEN` | from `.env` |
   | `GROQ_API_KEY` | from `.env` |
   | `ADMIN_API_KEY` | from `.env` |
   | `ADMIN_CHAT_ID` | from `.env` |

   Do **not** set `PORT` or `DATA_DIR` manually — `render.yaml` sets `DATA_DIR=/var/data`.

4. Deploy. Wait until status is **Live**.
5. Open:

   - `https://YOUR-SERVICE-NAME.onrender.com/health`
   - `https://YOUR-SERVICE-NAME.onrender.com/admin`

6. Log in with the same `ADMIN_API_KEY` as local `.env`.

7. Message your bot on Telegram — only Render should be running (not local, not Railway).

---

## Step 3 — What to use day to day

| Task | URL |
|------|-----|
| Admin panel | `https://YOUR-SERVICE-NAME.onrender.com/admin` |
| Phone bookmark | Same URL |
| Local testing | `http://localhost:3001/admin` (only while `npm start` is running) |

Do **not** open `admin.html` from Downloads or Netlify unless you set the server URL to your Render app every time.

---

## If something breaks again

- **409 / bot not replying** → two instances running; stop local + pause the other cloud host.
- **Admin “wrong API key”** → key must match `ADMIN_API_KEY` on Render exactly.
- **502 / failed to respond** → check Render **Logs** for `Env OK` and `HTTP server listening`.

---

## Optional: Railway later

Only use Railway **after** Render works, and **only if** Render is stopped/deleted. Never run both at once.
