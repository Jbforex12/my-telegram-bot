# Go live on Render (Pathway Prep bot)

## Before you start

1. Stop the bot on your PC so Telegram does not get **409 Conflict**:
   ```powershell
   cd C:\Users\BRIGHT\Documents\my-telegram-bot
   .\STOP-BOT.ps1
   ```
   Close any terminal still running `node bot.js`. End **node.exe** in Task Manager if port 3001 is busy.

2. Code must be on GitHub: `https://github.com/Jbforex12/my-telegram-bot`

---

## Deploy on Render

1. Open [Render Dashboard](https://dashboard.render.com) → **New +** → **Blueprint**.
2. Connect GitHub → choose repo **my-telegram-bot** → apply `render.yaml`.
3. When prompted, set these **secret** variables (copy from your local `.env`):

   | Variable | Notes |
   |----------|--------|
   | `TELEGRAM_BOT_TOKEN` | From @BotFather |
   | `GROQ_API_KEY` | From console.groq.com |
   | `ADMIN_API_KEY` | Same as local — used for `/admin` login |
   | `ADMIN_CHAT_ID` | Your Telegram user ID |

   `IMAGE_GEN` and `DATA_DIR` are set in `render.yaml` — do not override unless you know why.

4. Wait until the service is **Live** (first deploy ~2–5 minutes).

5. Test:
   - `https://YOUR-SERVICE.onrender.com/health` → `{"status":"ok",...}`
   - `https://YOUR-SERVICE.onrender.com/admin` → log in with `ADMIN_API_KEY`
   - Message your bot on Telegram

---

## After go-live

| Use | URL |
|-----|-----|
| Admin (phone or PC) | `https://YOUR-SERVICE.onrender.com/admin` |
| Health check | `https://YOUR-SERVICE.onrender.com/health` |

Do **not** run `START-BOT.ps1` on your PC while Render is live.

---

## Browser shows plain "Not Found" on /health

That means Render is **not** running your Node app yet (not the bot’s JSON error).

1. Render dashboard → your service → **Logs**
2. If you see `Missing required environment variables` → **Environment** → add `TELEGRAM_BOT_TOKEN` and `GROQ_API_KEY` from `.env` → **Manual Deploy**
3. Confirm **Start command** is `npm start` and **Root directory** is empty (repo root)
4. Confirm service type is **Web Service**, not Static Site
5. After fix, `/health` should show JSON like `{"status":"ok",...}` not plain "Not Found"

## If the bot does not reply

- Render **Logs** → look for `Env OK` and `HTTP server listening`
- **409 Conflict** → stop local bot and any old Railway/Render service
- Admin wrong key → `ADMIN_API_KEY` on Render must match `.env` exactly
