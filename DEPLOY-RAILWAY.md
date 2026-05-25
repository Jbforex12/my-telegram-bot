# Deploy Pathway Prep Bot on Railway

Your bot URL: **https://telegram-bot-production-a46e.up.railway.app**

Admin panel (use this in the browser — not a file from Downloads):

**https://telegram-bot-production-a46e.up.railway.app/admin**

## Why login failed

1. **Wrong admin file** — Opening `admin.html` from Downloads uses an old copy. Use the `/admin` URL on your live bot instead.
2. **API key mismatch** — The key you type must match `ADMIN_API_KEY` in Railway exactly (same value as in your local `.env`).
3. **Server offline (502)** — Railway returns 502 when the bot process crashes, usually because required env vars are missing.

## Required Railway variables

In Railway → your service → **Variables**, set all of these (copy values from your local `.env`):

| Variable | Required |
|----------|----------|
| `TELEGRAM_BOT_TOKEN` | Yes |
| `GROQ_API_KEY` | Yes |
| `ADMIN_API_KEY` | Yes — same secret you use to log into admin |
| `ADMIN_CHAT_ID` | Recommended |
| `PORT` | Leave unset — Railway sets this automatically |

Do **not** use placeholder values from `.env.example`.

## Quick test (if 502 won't go away)

In Railway → Settings → **Start command**, temporarily set:

```
node railway-health.js
```

Redeploy. If `https://telegram-bot-production-a46e.up.railway.app/health` then returns `{"status":"ok","mode":"health-only",...}`, your **networking is fine** and the full bot is crashing — open **Deploy Logs** for the real error, then set start command back to `npm start` and fix vars.

## Fix 502 "Application failed to respond"

If variables are set but you still see 502:

1. **Networking → Public domain → Target port** must be **automatic** (or match the `PORT` Railway injects — often `8080`). If target port is `3001` but the app listens on `8080`, every request returns 502.
2. Open **Deploy Logs** (not Build Logs). Look for:
   - `Env OK — PORT=...` (good)
   - `❌ Bot cannot start — missing environment variables` (fix vars, redeploy)
   - `✅ HTTP server listening on 0.0.0.0:...` (good)
3. Click **Redeploy** after any variable change.
4. **Stop local bot** on your PC (`START-BOT.ps1` window) while Railway runs — two instances cause Telegram conflicts.

## After a successful deploy

1. Visit `https://telegram-bot-production-a46e.up.railway.app/health` — should show `{"status":"ok",...}`
2. Open `/admin` and sign in with your `ADMIN_API_KEY`.

## Local development

Run the project from **Documents**, not `C:\Windows\System32` (Windows blocks saving files there):

```
cd C:\Users\BRIGHT\Documents\my-telegram-bot
npm install
npm start
```

Then open: http://localhost:3001/admin
