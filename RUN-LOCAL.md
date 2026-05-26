# Run the bot locally (correct folder)

Always use this folder:

```
C:\Users\BRIGHT\Documents\my-telegram-bot
```

Do **not** run the copy under `C:\Windows\System32\my-telegram-bot` — Windows may block updates there, and an old bot can keep running in the background.

## Start / stop

```powershell
cd C:\Users\BRIGHT\Documents\my-telegram-bot
.\STOP-BOT.ps1
.\START-BOT.ps1
```

Admin panel: http://localhost:3001/admin  
API key: same as `ADMIN_API_KEY` in `.env`

## Features (local)

- **Documents:** PDF, Word, Excel, CSV, text, HTML (`/file pdf topic` or ask in chat)
- **Photo analysis:** send an image with a caption — the bot answers about what is in the photo
- **No picture generation** unless you set `IMAGE_GEN=true` in `.env` (default is off)

## If buttons still misbehave

1. Run `.\STOP-BOT.ps1`
2. Close any terminal still running `node bot.js`
3. Run `.\START-BOT.ps1` from **Documents** only
4. Hard-refresh the admin page (Ctrl+F5)
