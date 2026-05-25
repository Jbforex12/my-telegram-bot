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

## After setting variables

1. Click **Redeploy** in Railway.
2. Open **Deploy Logs** — you should see: `✅ Pathway Prep Bot is running!`
3. Visit `https://telegram-bot-production-a46e.up.railway.app/health` — should show `{"status":"ok",...}`
4. Open `/admin` and sign in with your `ADMIN_API_KEY`.

## Local development

Run the project from **Documents**, not `C:\Windows\System32` (Windows blocks saving files there):

```
cd C:\Users\BRIGHT\Documents\my-telegram-bot
npm install
npm start
```

Then open: http://localhost:3001/admin
